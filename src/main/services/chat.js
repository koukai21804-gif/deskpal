// 聊天管线：发送/停止/历史/导出/记忆提取（主进程持有权威历史）
// v0.3：流式正文经 stream-pipeline（节拍+进展剥离）；roleplay 且 agent 开启时接入 agent/loop 执行管线
const dayjs = require('dayjs');
const { dialog } = require('electron');
const fs = require('fs');
const store = require('./store');
const llm = require('./llm');
const prompts = require('./prompts');
const emotion = require('./emotion');
const logger = require('../logger');
const windows = require('../windows');
const { makeStreamPipeline } = require('./stream-pipeline');
const loop = require('./agent/loop');

const HISTORY_KEY = { roleplay: 'chats/roleplay', quick: 'chats/quick' };
const MAX_KEEP = 200, CTX_MSGS = 20, CTX_TOKENS = 6400;
// 记忆提取节奏（v0.3.4 消除「会话尾部滞留」缺口，三路触发同一入口）：
//   每 6 条用户消息提取一次；会话冷却（≥30 分钟无新消息）由闲置定时器补提取；
//   打开记忆面板时强制补提取（memory:list 前调 flushMemory）。
const EXTRACT_EVERY = 6, IDLE_MIN_SINCE = 2, IDLE_GAP_MIN = 30;
let extracting = false;

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

// 最终回复落史（两条路径共用）；msgId 由主进程生成并随 llm:done 带回，
// 渲染层用它保持本地消息附加数据（时间线/diff 卡）在历史刷新后不丢
async function finalizeReply(tab, fl) {
  const h = getHistory(tab);
  const msgId = 'm' + Date.now().toString(36);
  h.push({
    id: msgId, role: 'assistant', content: fl.clean,
    emotion: fl.emotion || undefined,
    beats: fl.beats && fl.beats.length ? fl.beats : undefined,
    schedule: fl.schedule || undefined,
    at: dayjs().format(),
  });
  saveHistory(tab, h);
  if (fl.emotion && tab === 'roleplay') emotion.broadcastEmotion(fl.emotion, { source: 'chat' });
  else if (fl.emotion) emotion.broadcastEmotion(fl.emotion, { source: 'chat', revertMs: 6000 });
  return { msgId };
}

// 发送消息：流式回推 llm:chunk → llm:done（done 内含管线 flush 结果）
async function send(tab, text) {
  const reqId = llm.newReqId('chat');
  const history = getHistory(tab);
  history.push({ id: 'm' + Date.now().toString(36), role: 'user', content: String(text), at: dayjs().format() });
  saveHistory(tab, history);

  const messages = buildMessages(tab, history);
  sendToWin({ event: 'llm:chunk', data: { tab, reqId, delta: '' } }); // 占位开始信号

  // roleplay 且 agent 开启 → 工具执行管线；否则普通流式（流式在后台执行，立即返回 reqId 供渲染层停止）
  const agentOn = tab === 'roleplay' && !!(store.get('settings').agent || {}).enabled;
  if (agentOn) runAgentTurn(tab, reqId, String(text), messages);
  else plainTurn(tab, reqId, messages);

  return { reqId };
}

// 普通流式轮（quick / agent 关闭时的 roleplay）
function plainTurn(tab, reqId, messages) {
  const pipeline = makeStreamPipeline(tab, reqId);
  (async () => {
    try {
      await llm.streamChat({ messages, reqId, onChunk: (delta) => pipeline.onDelta(delta) });
      const fl = pipeline.flush();
      const { msgId } = await finalizeReply(tab, fl);
      sendToWin({ event: 'llm:done', data: { tab, reqId, clean: fl.clean, emotion: fl.emotion, beats: fl.beats, schedule: fl.schedule, aborted: false, msgId } });
      if (tab === 'roleplay') memoryTick().catch(e => logger.warn('记忆提取失败: ' + e.message));
    } catch (e) {
      if (e.name === 'AbortError') {
        // 停止：保留半截（onChunk 已推送的部分在渲染层保留）
        sendToWin({ event: 'llm:done', data: { tab, reqId, clean: '', emotion: null, schedule: null, aborted: true } });
        return;
      }
      logger.error(e);
      sendToWin({ event: 'llm:error', data: { tab, reqId, error: e.userMsg || e.message } });
    }
  })();
}

// Agent 执行轮（F9）：loop 负责 tool-call 循环/权限/差分归因/台账，这里只管聊天域收尾
function runAgentTurn(tab, reqId, instruction, baseMessages) {
  loop.startRun({
    reqId, instruction, baseMessages,
    onFinal: (fl) => finalizeReply(tab, fl),
    onDone: (p) => {
      sendToWin({
        event: 'llm:done',
        data: {
          tab, reqId, clean: p.clean, emotion: p.emotion, beats: p.beats, schedule: p.schedule,
          aborted: false, runId: p.runId, changes: p.changes, msgId: p.msgId,
        },
      });
      memoryTick().catch(e => logger.warn('记忆提取失败: ' + e.message));
    },
    onAborted: ({ runId }) => {
      sendToWin({ event: 'llm:done', data: { tab, reqId, clean: '', emotion: null, schedule: null, aborted: true, runId } });
    },
    onError: (e) => {
      sendToWin({ event: 'llm:error', data: { tab, reqId, error: e.userMsg || e.message } });
    },
  }).catch(e => {
    // startRun 自身异常兜底（loop 内部已 try/catch，这里防御 Promise 层面的意外）
    logger.error(e);
    sendToWin({ event: 'llm:error', data: { tab, reqId, error: e.userMsg || e.message } });
  });
}

// 记忆系统：有未提取的用户消息时提取。force=true 无视节奏阈值（面板打开/冷却补提取用）。
// 并发互斥：定时器/面板/回复收尾三方同时触发时只跑一次，避免重复条目。
async function memoryTick(force = false) {
  if (extracting) return false;
  const data = store.get('chats/roleplay');
  const since = data.userCountSince || 0;
  if (since <= 0) return false;
  if (!force && since < EXTRACT_EVERY) return false;
  extracting = true;
  try {
    return await runExtract(data, since);
  } finally {
    extracting = false;
  }
}

// 提取主体：LLM 摘要（失败正则兜底）→ 过滤入库（上限 50 淘汰）→ 清零计数
async function runExtract(data, since) {
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
  return true;
}

// 会话冷却补提取：每 10 分钟检查——有 ≥2 条未提取消息且 ≥30 分钟无新用户消息时补一次，
// 收掉「会话尾部不足节奏阈值、永不提取」的缺口（unref：纯 Node 测试进程不因此挂住）
const lullTimer = setInterval(() => {
  try {
    const data = store.get('chats/roleplay');
    if ((data.userCountSince || 0) < IDLE_MIN_SINCE) return;
    const lastUser = [...(data.messages || [])].reverse().find(m => m.role === 'user');
    if (!lastUser || !lastUser.at) return;
    const idleMin = (Date.now() - new Date(lastUser.at).getTime()) / 60000;
    if (idleMin >= IDLE_GAP_MIN) memoryTick(true).catch(() => {});
  } catch (_) {}
}, 10 * 60 * 1000);
if (lullTimer.unref) lullTimer.unref();

// 打开记忆面板前的强制补提取：有未提取消息就提一次（无视节奏阈值），失败静默（面板照常可看）
async function flushMemory() {
  try { return await memoryTick(true); } catch (_) { return false; }
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

module.exports = { send, stop: llm.stop, getHistory, saveHistory, bumpUserCount, exportChat, buildMessages, memoryTick, flushMemory };
