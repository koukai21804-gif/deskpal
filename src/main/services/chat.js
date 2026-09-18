// 聊天管线：发送/停止/历史/导出/记忆提取（主进程持有权威历史）
const dayjs = require('dayjs');
const { dialog } = require('electron');
const fs = require('fs');
const store = require('./store');
const llm = require('./llm');
const prompts = require('./prompts');
const emotion = require('./emotion');
const logger = require('../logger');
const windows = require('../windows');

const HISTORY_KEY = { roleplay: 'chats/roleplay', quick: 'chats/quick' };
const MAX_KEEP = 200, CTX_MSGS = 20, CTX_TOKENS = 6400;

function getHistory(tab) {
  return store.get(HISTORY_KEY[tab]).messages || [];
}

function saveHistory(tab, messages) {
  store.replace(HISTORY_KEY[tab], { ...store.get(HISTORY_KEY[tab]), messages: messages.slice(-MAX_KEEP) });
}

function tokenEstimate(text) {
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  return cjk * 0.5 + Math.max(0, text.length - cjk) * 0.25;
}

// 组装请求上下文：system + 最近 CTX_MSGS 条（token 超限再砍半）
function buildMessages(tab, history) {
  const system = tab === 'quick' ? prompts.quickSystem() : prompts.roleplaySystem();
  let recent = history.slice(-CTX_MSGS).map(m => ({
    role: m.role, content: emotion.parseAndStrip(m.content).clean,
  }));
  let total = tokenEstimate(system);
  for (const m of recent) total += tokenEstimate(m.content);
  while (total > CTX_TOKENS && recent.length > 4) {
    const cut = Math.ceil(recent.length / 2);
    total -= recent.slice(0, cut).reduce((s, m) => s + tokenEstimate(m.content), 0);
    recent = recent.slice(cut);
  }
  return [{ role: 'system', content: system }, ...recent];
}

function sendToWin(payload) {
  const win = windows.getWindow('chat');
  if (win) win.webContents.send(payload.event, payload.data);
}

// 发送消息：流式回推 llm:chunk → llm:done（done 内含 parseAndStrip 结果）
async function send(tab, text) {
  const reqId = llm.newReqId('chat');
  const history = getHistory(tab);
  history.push({ id: 'm' + Date.now().toString(36), role: 'user', content: String(text), at: dayjs().format() });
  saveHistory(tab, history);

  const messages = buildMessages(tab, history);
  sendToWin({ event: 'llm:chunk', data: { tab, reqId, delta: '' } }); // 占位开始信号

  // 流式在后台执行，立即返回 reqId 供渲染层停止
  (async () => {
    try {
      const raw = await llm.streamChat({
        messages,
        reqId,
        onChunk: (delta) => sendToWin({ event: 'llm:chunk', data: { tab, reqId, delta } }),
      });
      const { clean, emotion: emo, schedule } = emotion.parseAndStrip(raw);
      const h = getHistory(tab);
      h.push({ id: 'm' + Date.now().toString(36), role: 'assistant', content: clean, emotion: emo, schedule: schedule || undefined, at: dayjs().format() });
      saveHistory(tab, h);
      if (emo && tab === 'roleplay') emotion.broadcastEmotion(emo, { source: 'chat' });
      else if (emo) emotion.broadcastEmotion(emo, { source: 'chat', revertMs: 6000 });
      sendToWin({ event: 'llm:done', data: { tab, reqId, clean, emotion: emo, schedule, aborted: false } });
      if (tab === 'roleplay') memoryTick().catch(e => logger.warn('记忆提取失败: ' + e.message));
    } catch (e) {
      if (e.name === 'AbortError') {
        // 停止：保留半截（streamChat 抛出时 onChunk 已推送的部分在渲染层保留）
        sendToWin({ event: 'llm:done', data: { tab, reqId, clean: '', emotion: null, schedule: null, aborted: true } });
        return;
      }
      logger.error(e);
      sendToWin({ event: 'llm:error', data: { tab, reqId, error: e.userMsg || e.message } });
    }
  })();

  return { reqId };
}

// 记忆系统：距上次提取的用户消息 ≥10 → 低温提取
async function memoryTick() {
  const data = store.get('chats/roleplay');
  const since = data.userCountSince || 0;
  if (since < 10) return;
  const msgs = data.messages || [];
  // 只统计本次提取之后的消息里有多少条用户消息
  const recent = msgs.slice(-20).map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n');
  let extracted = [];
  try {
    const out = await llm.genericCompletion(
      [{ role: 'system', content: prompts.memoryExtractPrompt(recent) }],
      { temperature: 0.3, maxTokens: 1024 },
    );
    const m = out.match(/\[[\s\S]*\]/);
    if (m) {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        extracted = arr.filter(x => x && x.content && Number.isFinite(+x.importance) && +x.importance >= 2)
          .slice(0, 8).map(x => ({
            type: ['relationship', 'event', 'fact', 'preference'].includes(x.type) ? x.type : 'fact',
            content: String(x.content).slice(0, 40), importance: Math.min(5, Math.max(1, +x.importance)),
            createdAt: dayjs().format(),
          }));
      }
    }
  } catch (e) { logger.warn('记忆提取调用失败: ' + e.message); }

  if (!extracted.length) {
    // 正则兜底
    const lastUser = [...msgs].reverse().find(m => m.role === 'user');
    const mm = lastUser && lastUser.content.match(/(我是|我叫|我喜欢|我讨厌|我生日|我在?做)(.{2,20})/);
    extracted = mm
      ? [{ type: 'fact', content: mm[1] + mm[2], importance: 2, createdAt: dayjs().format() }]
      : [{ type: 'event', content: `进行了${since}轮对话`, importance: 2, createdAt: dayjs().format() }];
  }

  const mem = store.get('memory/roleplay');
  mem.items = [...(mem.items || []), ...extracted];
  // 上限 50：按重要性升序 → createdAt 升序淘汰
  if (mem.items.length > 50) {
    mem.items.sort((a, b) => (a.importance - b.importance) || (a.createdAt < b.createdAt ? -1 : 1));
    mem.items = mem.items.slice(mem.items.length - 50);
  }
  store.replace('memory/roleplay', mem);
  store.replace('chats/roleplay', { ...data, userCountSince: 0, lastExtractAt: dayjs().format() });
}

// 用户消息计数（chat:save-history 后由 ipc 调用）
function bumpUserCount(tab) {
  if (tab !== 'roleplay') return;
  const data = store.get('chats/roleplay');
  store.replace('chats/roleplay', { ...data, userCountSince: (data.userCountSince || 0) + 1 });
}

async function exportChat(tab) {
  const msgs = getHistory(tab);
  if (!msgs.length) throw new Error('当前会话没有消息可导出');
  const nameMap = { roleplay: '角色扮演', quick: '速问速答' };
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出聊天记录', defaultPath: `deskpal-${nameMap[tab]}-${dayjs().format('YYYYMMDD-HHmm')}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (canceled || !filePath) return null;
  const persona = store.get('persona').pet;
  const lines = [`# deskpal ${nameMap[tab]}记录`, '', `- 宠物：${persona.name}`, `- 导出时间：${prompts.nowText()}`, '', '---', ''];
  for (const m of msgs) {
    lines.push(m.role === 'user' ? `**🧑 ${'用户'}：**` : `**🟢 ${persona.name}：**`);
    lines.push(m.content, '');
  }
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

module.exports = { send, stop: llm.stop, getHistory, saveHistory, bumpUserCount, exportChat };
