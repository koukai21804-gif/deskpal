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
const { tokenEstimate, createAnchoredEstimator, createUsageMeter } = require('./token-est');
const loop = require('./agent/loop');
const markers = require('./agent/markers');
const userProfile = require('./user-profile');
const canon = require('./canon');
const searchLedger = require('./agent/search-ledger');
const sessions = require('./sessions');
const memory = require('./memory');

const HISTORY_KEY = { roleplay: 'chats/roleplay', quick: 'chats/quick' };
const MAX_KEEP = 200, CTX_MSGS = 20, CTX_TOKENS = 6400;
// 戏外工作轮（/order）的历史窗收窄（20261004 实测反馈）：工作任务的上下文核心是指令本身与
// 工具轮，20 条扮演历史对任务贡献小、却每轮全量重发（N 轮 × base 的乘法税）；10 条保住
// 「最近我们在干什么」的连续性即可。token 上限不变。
const CTX_MSGS_WORK = 10;
// 记忆提取节奏（v0.3.4 消除「会话尾部滞留」缺口，三路触发同一入口）：
//   每 6 条用户消息提取一次；会话冷却（≥30 分钟无新消息）由闲置定时器补提取；
//   打开记忆面板时强制补提取（memory:list 前调 flushMemory）。
const EXTRACT_EVERY = 6, IDLE_MIN_SINCE = 2, IDLE_GAP_MIN = 30;
let extracting = false;

function getHistory(tab) {
  if (tab !== 'roleplay') return store.get(HISTORY_KEY[tab]).messages || [];
  return sessions.active().messages || [];
}

function saveHistory(tab, messages) {
  if (tab !== 'roleplay') {
    store.replace(HISTORY_KEY[tab], { ...store.get(HISTORY_KEY[tab]), messages: messages.slice(-MAX_KEEP) });
    return;
  }
  const { doc } = sessions.ensure();
  const sess = sessions.active();
  sess.messages = messages.slice(-MAX_KEEP);
  sessions.touch(sess);
  sessions.persist(doc);
}

// ---- 会话管理（v0.5 多会话：主对话=角色扮演常驻；专项会话=特定任务/场景） ----
// 切走/新建/删除前先固化旧会话的未提取信息（flushMemory + 档案漂移都作用于「当前活跃会话」，
// 必须在 activeSessionId 变更之前跑完，否则提取器读到的是新会话的消息）。
async function flushActiveSession() {
  await flushMemory();
  await userProfile.tick(true).catch(e => logger.warn('身份档案漂移失败: ' + e.message));
}

function listSessions() { return sessions.list(); }

async function newSession({ name, goal } = {}) {
  await flushActiveSession();
  const sess = sessions.create({ name, goal });
  sessions.switchTo(sess.id);
  return { ...sess, messages: undefined, msgCount: 0 };
}

async function switchSession(id) {
  const cur = sessions.active();
  if (cur && cur.id === id) return { ...cur, messages: undefined, msgCount: (cur.messages || []).length };
  await flushActiveSession();
  const sess = sessions.switchTo(id);
  return { ...sess, messages: undefined, msgCount: (sess.messages || []).length };
}

function renameSession(id, opts) { return sessions.rename(id, opts); }

async function deleteSession(id) {
  const r = sessions.del(id); // 主对话不可删（sessions 内守卫）；删除=显式丢弃，不做提取
  return r;
}

// 戏外→戏内记忆隔离（v0.4.0-dev.3）：
//   a) （系统核实：…）/（系统注记：…）是 harness 给用户的审计注记（戏外），永不进入
//      角色上下文（戏内）——它们以断言口吻描述既往轮次「与事实不符」或传输状态，残留
//      会在后续轮次诱发角色自我怀疑（实测 dev.2 事故）；注记族随 P0-3 扩展（断流半截交付）；
//   b) agent 任务轮的完整工作报告在戏内记忆里只保留摘要，全文留在聊天 UI 与 runs.jsonl（戏外），
//      防止任务长文霸占上下文、把扮演语气拖回任务腔。
const HARNESS_NOTE_RE = prompts.HARNESS_NOTE_RE;

// ---- 戏外工作报告的结构化压缩（M-2 修复，v0.5）----
// 旧实现 slice(0, 800) 从头截断：报告结构固定「结论→论证→不确定的部分→建议」，800 字符
// 只够覆盖结论——下一轮模型只看得见自己的结论、看不见自己标的置信度，是「错误的自我强化」
// 的机械成因。新算法：头尾硬保（结论区 + 自认缺口区）+ 白名单整节保留（不确定/风险/未完成…），
// 全程机械执行（计数触发、代码压缩，禁止 LLM 摘要——摘要有损，回执无损）。
// 分级上限（护栏 G-1）：窗口内最新 1 份报告 2000，更早的报告 500——否则多份报告挤爆
// CTX_TOKENS=6400，报告没被压缩、对话被压缩。
const REPORT_CAP_NEW = 2000, REPORT_CAP_OLD = 500;
// 白名单按「标题词」匹配（splitByHeading 已剥掉 ## 前缀，这里匹配裸标题）——
// 不按位置：位置随写作习惯漂移，标题名（结论/不确定/风险/未完成…）相对稳定
const REPORT_KEEP_RE = /^(结论|摘要|我不?不确定|不确定|风险|局限|自认|未完成|待补|缺口|验证|验收)/;

function splitByHeading(text) {
  const re = /^#{2,3}[ \t]*(.+)$/gm;
  const blocks = [];
  let m, prevEnd = 0, prevTitle = null;
  while ((m = re.exec(text))) {
    if (prevTitle !== null) blocks.push({ title: prevTitle, start: prevEnd, end: m.index, text: text.slice(prevEnd, m.index) });
    prevTitle = m[1].trim(); prevEnd = m.index;
  }
  if (prevTitle !== null) blocks.push({ title: prevTitle, start: prevEnd, end: text.length, text: text.slice(prevEnd) });
  return blocks;
}

function compressReport(text, cap) {
  if (text.length <= cap) return text;
  const headLen = Math.min(400, Math.floor(cap * 0.4));
  const tailLen = Math.min(400, Math.floor(cap * 0.3));
  const blockKeep = Math.min(600, Math.floor(cap * 0.35)); // 单节节选上限：白名单节也可能被无标题的附录拖长
  const receipt = `\n[报告已结构化压缩：原 ${text.length} 字符 → 压缩版；完整版见聊天记录与工作台账]`;
  const budget = cap - receipt.length;
  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);
  const build = (mid) => {
    let out = head + '\n…（中间段略）…\n' + mid + '\n…（中间段略）…\n' + tail;
    if (out.length > budget) out = head + '\n…（中间段略）…\n' + tail;
    return out;
  };
  // 白名单节按标题匹配（不按位置——位置随写作习惯漂移）。与头/尾区间重叠的部分不重复计入：
  // 起点已在头部区间的节跳过（头部已含）；终点裁到尾部区间起点为止；节选后超长再截。
  const tailStart = text.length - tailLen;
  const picked = splitByHeading(text)
    .filter(b => REPORT_KEEP_RE.test(b.title) && b.start >= headLen && b.start < tailStart)
    .map(b => {
      let seg = text.slice(b.start, Math.min(b.end, tailStart)).trim();
      if (seg.length > blockKeep) seg = seg.slice(0, blockKeep) + '\n…（本节超长，此处节选）';
      return seg;
    });
  let mid = picked.join('\n\n');
  while (mid && head.length + mid.length + tail.length + 30 > budget) {
    picked.pop(); // 从最低优先级（最靠后）节开始丢
    mid = picked.join('\n\n');
  }
  return build(mid) + receipt;
}

function forContext(m, reportCap = REPORT_CAP_OLD) {
  let c = emotion.parseAndStrip(m.content).clean.replace(HARNESS_NOTE_RE, '').trim();
  if (m.agentRun) {
    // provenance 前缀（P1-4）：历史被截断后各种文本拉平为纯文本——给报告打来源标，
    // 角色能区分「自己的戏外工作报告」与扮演对话（H2/H4 共同病根）
    c = '[戏外工作报告] ' + compressReport(c, reportCap);
  }
  return c;
}

// 锚点法计量（P0-2）：最近一次成功请求的上游 prompt_tokens 钉在其末条消息上，
// 锚前真实计数 + 锚后本地估算——纯估算的漂移不再随对话增长累积
const ctxEst = createAnchoredEstimator();

// 组装请求上下文：system + 最近 CTX_MSGS 条（token 超限再砍半）。
// agentRun 报告分级上限（G-1）：窗口内最新一份 2000、更早的 500。
// opts.work：戏外工作轮 → 历史窗收窄到 CTX_MSGS_WORK（见常量注释）。
function buildMessages(tab, history, opts = {}) {
  const system = tab === 'quick' ? prompts.quickSystem() : prompts.roleplaySystem();
  const winSize = opts.work && tab === 'roleplay' ? CTX_MSGS_WORK : CTX_MSGS;
  const win = history.slice(-winSize);
  const lastAgentIdx = win.reduce((a, m, i) => (m.agentRun ? i : a), -1);
  const items = win.map((m, i) => ({ key: m.id, content: forContext(m, i === lastAgentIdx ? REPORT_CAP_NEW : REPORT_CAP_OLD) }));
  let recent = win.map((m, i) => ({ role: m.role, content: forContext(m, i === lastAgentIdx ? REPORT_CAP_NEW : REPORT_CAP_OLD) }));
  let total = ctxEst.estimate(items, system);
  while (total > CTX_TOKENS && recent.length > 4) {
    const cut = Math.ceil(recent.length / 2);
    total -= items.slice(0, cut).reduce((s, x) => s + tokenEstimate(x.content), 0);
    items.splice(0, cut);
    recent = recent.slice(cut);
  }
  return [{ role: 'system', content: system }, ...recent];
}

function sendToWin(payload) {
  const win = windows.getWindow('chat');
  if (win) win.webContents.send(payload.event, payload.data);
}

// 最终回复落史（两条路径共用）；msgId 由主进程生成并随 llm:done 带回，
// 渲染层用它保持本地消息附加数据（时间线/diff 卡）在历史刷新后不丢。
// meta.agentRun：agent 任务轮的回复打标（戏内记忆据此做摘要化隔离，见 forContext）
// meta.work：戏外工作轮（/order 打标）——消息带 work 标，渲染层 highlight（用户决策 2026-09-29）
async function finalizeReply(tab, fl, meta = {}) {
  const h = getHistory(tab);
  const msgId = 'm' + Date.now().toString(36);
  h.push({
    id: msgId, role: 'assistant', content: fl.clean,
    emotion: fl.emotion || undefined,
    beats: fl.beats && fl.beats.length ? fl.beats : undefined,
    schedule: fl.schedule || undefined,
    agentRun: meta.agentRun || undefined,
    work: meta.work || undefined,
    usage: meta.usage || undefined, // 本轮 API 消耗（输入/思考/回复分项；供应商未报则缺省）
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
  // 戏内/戏外通道（loop.channelOf）：/order、/指令：、/命令： 行首打标 = 戏外工作轮，消息打 work 标
  // 供渲染层 highlight；仅 roleplay 有 agent 管线，quick 恒为戏内
  const work = tab === 'roleplay' && loop.channelOf(text) === 'work';
  const history = getHistory(tab);
  history.push({ id: 'm' + Date.now().toString(36), role: 'user', content: String(text), work: work || undefined, at: dayjs().format() });
  saveHistory(tab, history);

  const messages = buildMessages(tab, history, { work });
  // 锚点候选：本次请求覆盖的末条历史消息 id（成功后上游 prompt_tokens 落锚于此，P0-2）
  const anchorKey = history[history.length - 1].id;
  const sessionId = tab === 'roleplay' ? sessions.active().id : undefined;
  sendToWin({ event: 'llm:chunk', data: { tab, reqId, delta: '', sessionId } }); // 占位开始信号

  // roleplay 且 agent 开启 → 工具执行管线；否则普通流式（流式在后台执行，立即返回 reqId 供渲染层停止）
  const agentOn = tab === 'roleplay' && !!(store.get('settings').agent || {}).enabled;
  if (agentOn) runAgentTurn(tab, reqId, String(text), messages, work, anchorKey, sessionId);
  else plainTurn(tab, reqId, messages, anchorKey, false, sessionId);

  return { reqId, work, sessionId };
}

// 普通流式轮（quick / agent 关闭时的 roleplay）；overflowTried：溢出压缩重试标记（P0-4）
function plainTurn(tab, reqId, messages, anchorKey, overflowTried = false, sessionId = undefined) {
  const pipeline = makeStreamPipeline(tab, reqId);
  const turnMeter = createUsageMeter(); // 本轮 API 消耗（外显）
  (async () => {
    try {
      // 思考期反馈（deepseek 思考模式全程开启，v0.3.7 用户决策）：推理流先行、正文未出时
      // 宠物切思考表情，避免长时间无输出的「卡住」观感；每轮流至多触发一次
      let thinkingNoted = false;
      await llm.streamChat({
        messages, reqId,
        onChunk: (delta) => pipeline.onDelta(delta),
        onReasoning: () => {
          if (!thinkingNoted) { thinkingNoted = true; emotion.broadcastEmotion('thinking', { source: 'chat', revertMs: 60000 }); }
        },
        // 用量：聚合器（外显）+ 锚点落锚（P0-2；普通轮无工具上下文，任何成功请求的用量都可作锚）
        onUsage: (u) => {
          try { turnMeter.add(u); } catch (_) {}
          if (u && Number.isFinite(+u.prompt_tokens)) ctxEst.setAnchor({ key: anchorKey, promptTokens: u.prompt_tokens });
        },
      });
      const fl = pipeline.flush();
      const usage = turnMeter.snapshot();
      const { msgId } = await finalizeReply(tab, fl, { usage });
      sendToWin({ event: 'llm:done', data: { tab, reqId, clean: fl.clean, emotion: fl.emotion, beats: fl.beats, schedule: fl.schedule, aborted: false, msgId, usage, sessionId } });
      if (tab === 'roleplay') {
        memoryTick().catch(e => logger.warn('记忆提取失败: ' + e.message));
        userProfile.tick().catch(e => logger.warn('身份档案漂移失败: ' + e.message)); // 开发版：档案漂移与记忆提取同节奏
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        // 停止：保留半截（onChunk 已推送的部分在渲染层保留）
        sendToWin({ event: 'llm:done', data: { tab, reqId, clean: '', emotion: null, schedule: null, aborted: true, sessionId } });
        return;
      }
      // 溢出→压缩续跑（P0-4）：保 system+末条用户消息重试一次（错误发生在请求期，
      // 尚无正文外化，重试无重复风险）
      if (e && e.contextOverflow && !overflowTried && messages.length > 2) {
        const compact = [
          messages[0].role === 'system'
            ? { role: 'system', content: messages[0].content + '\n' + markers.compactedHistoryNote({}) }
            : messages[0],
          messages[messages.length - 1],
        ];
        logger.warn('[chat] 上下文溢出，压缩历史后重试一次');
        plainTurn(tab, reqId, compact, null, true, sessionId);
        return;
      }
      logger.error(e);
      sendToWin({ event: 'llm:error', data: { tab, reqId, error: e.userMsg || e.message, sessionId } });
    }
  })();
}

// Agent 执行轮（F9）：loop 负责 tool-call 循环/权限/差分归因/台账，这里只管聊天域收尾
function runAgentTurn(tab, reqId, instruction, baseMessages, work, anchorKey, sessionId = undefined) {
  const turnMeter = createUsageMeter(); // 本轮 API 消耗（外显；与锚点口径分离——锚点只认首个基础轮）
  loop.startRun({
    reqId, instruction, baseMessages,
    // 锚点落锚（P0-2）：loop 只在首个基础轮（无 toolTurns）转发用量——混入工具
    // 上下文的 prompt_tokens 会把锚点抬高、导致下轮容量高估
    onUsage: (u) => { if (u && Number.isFinite(+u.prompt_tokens)) ctxEst.setAnchor({ key: anchorKey, promptTokens: u.prompt_tokens }); },
    // 溢出压缩前固化记忆（P0-4）：值得长期保留的对话信息先进记忆库再丢历史
    onContextOverflow: async () => { await flushMemory(); },
    onFinal: (fl, x) => finalizeReply(tab, fl, { agentRun: true, work, usage: x && x.usage }),
    onDone: (p) => {
      sendToWin({
        event: 'llm:done',
        data: {
          tab, reqId, clean: p.clean, emotion: p.emotion, beats: p.beats, schedule: p.schedule,
          aborted: false, runId: p.runId, changes: p.changes, msgId: p.msgId, usage: p.usage, sessionId,
        },
      });
      memoryTick().catch(e => logger.warn('记忆提取失败: ' + e.message));
      userProfile.tick().catch(e => logger.warn('身份档案漂移失败: ' + e.message)); // 开发版：档案漂移与记忆提取同节奏
    },
    onAborted: ({ runId }) => {
      sendToWin({ event: 'llm:done', data: { tab, reqId, clean: '', emotion: null, schedule: null, aborted: true, runId, sessionId } });
    },
    onError: (e) => {
      sendToWin({ event: 'llm:error', data: { tab, reqId, error: e.userMsg || e.message, sessionId } });
    },
  }).catch(e => {
    // startRun 自身异常兜底（loop 内部已 try/catch，这里防御 Promise 层面的意外）
    logger.error(e);
    sendToWin({ event: 'llm:error', data: { tab, reqId, error: e.userMsg || e.message, sessionId } });
  });
}

// 记忆系统：有未提取的用户消息时提取。force=true 无视节奏阈值（面板打开/冷却补提取/切会话前用）。
// 并发互斥：定时器/面板/回复收尾三方同时触发时只跑一次，避免重复条目。
async function memoryTick(force = false) {
  if (extracting) return false;
  const sess = sessions.active();
  const since = sess.userCountSince || 0;
  if (since <= 0) return false;
  if (!force && since < EXTRACT_EVERY) return false;
  extracting = true;
  try {
    return await runExtract(sess, since);
  } finally {
    extracting = false;
  }
}

// 提取主体：LLM 摘要（失败正则兜底）→ 看得见现有记忆的合并落库（memory.mergeExtracted）→ 清零计数
// v0.5：①提取器注入现有记忆清单（id｜内容），同主题输出 mergeInto——「同主题合并」的纪律
// 从物理上不可执行变为可执行；②喂给提取器的对话先剥 harness 注记（戏外审计断言不进记忆）；
// ③落库统一走 memory.mergeExtracted（补 id/截断标记/淘汰归档都在那一侧）。
async function runExtract(sess, since) {
  const msgs = sess.messages || [];
  const recent = msgs.slice(-20)
    .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${prompts.stripHarnessNotes(m.content)}`)
    .join('\n');
  const memDoc = store.get('memory/roleplay');
  const existing = (memDoc.items || []).map(m => ({ id: m.id, content: m.content })).slice(0, 60);
  let extracted = [];
  try {
    const out = await llm.genericCompletion(
      [{ role: 'system', content: prompts.memoryExtractPrompt(recent, existing) }],
      { temperature: 0.3, maxTokens: 1024 },
    );
    const m = out.match(/\[[\s\S]*\]/);
    if (m) {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        extracted = arr.filter(x => x && x.content && Number.isFinite(+x.importance) && +x.importance >= 2)
          .slice(0, 8).map(x => ({
            type: ['relationship', 'event', 'fact', 'preference'].includes(x.type) ? x.type : 'fact',
            content: String(x.content),
            importance: Math.min(5, Math.max(1, +x.importance)),
            mergeInto: x.mergeInto && existing.some(e => e.id === x.mergeInto) ? String(x.mergeInto) : undefined,
          }));
      }
    }
  } catch (e) { logger.warn('记忆提取调用失败: ' + e.message); }

  if (!extracted.length) {
    // 正则兜底
    const lastUser = [...msgs].reverse().find(m => m.role === 'user');
    const mm = lastUser && lastUser.content.match(/(我是|我叫|我喜欢|我讨厌|我生日|我在?做)(.{2,20})/);
    extracted = mm
      ? [{ type: 'fact', content: mm[1] + mm[2], importance: 2 }]
      : [];
    // 无可提取内容：只清计数（不写「进行了N轮对话」这类噪声条目）
    if (!extracted.length) {
      sess.userCountSince = 0;
      sess.lastExtractAt = dayjs().format();
      sessions.persist(sessions.ensure().doc);
      return true;
    }
  }

  memory.mergeExtracted(extracted);
  sess.userCountSince = 0;
  sess.lastExtractAt = dayjs().format();
  sessions.persist(sessions.ensure().doc);
  return true;
}

// 会话冷却补提取：每 10 分钟检查——活跃会话有 ≥2 条未提取消息且 ≥30 分钟无新用户消息时补一次，
// 收掉「会话尾部不足节奏阈值、永不提取」的缺口（unref：纯 Node 测试进程不因此挂住）
const lullTimer = setInterval(() => {
  try {
    const sess = sessions.active();
    if ((sess.userCountSince || 0) < IDLE_MIN_SINCE) return;
    const lastUser = [...(sess.messages || [])].reverse().find(m => m.role === 'user');
    if (!lastUser || !lastUser.at) return;
    const idleMin = (Date.now() - new Date(lastUser.at).getTime()) / 60000;
    if (idleMin >= IDLE_GAP_MIN) {
      memoryTick(true).catch(() => {});
      userProfile.tick(true).catch(() => {}); // 开发版：冷却补漂移（tick 自带 ≥2 条门槛，不空跑）
    }
  } catch (_) {}
}, 10 * 60 * 1000);
if (lullTimer.unref) lullTimer.unref();

// 打开记忆面板前的强制补提取：有未提取消息就提一次（无视节奏阈值），失败静默（面板照常可看）
async function flushMemory() {
  try { return await memoryTick(true); } catch (_) { return false; }
}

// 用户消息计数（chat:save-history 后由 ipc 调用）；roleplay 计在当前活跃会话头上
function bumpUserCount(tab) {
  if (tab !== 'roleplay') return;
  const { doc } = sessions.ensure();
  const sess = sessions.active();
  sess.userCountSince = (sess.userCountSince || 0) + 1;
  sessions.persist(doc);
  userProfile.bump(); // 开发版：身份档案漂移计数（只认 roleplay）
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
  const persona = canon.view().pet;
  const lines = [`# deskpal ${nameMap[tab]}记录`, '', `- 宠物：${persona.name}`, `- 导出时间：${prompts.nowText()}`, '', '---', ''];
  for (const m of msgs) {
    lines.push(m.role === 'user' ? `**🧑 ${'用户'}：**` : `**🟢 ${persona.name}：**`);
    lines.push(m.content, '');
  }
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

module.exports = {
  send, stop: llm.stop, getHistory, saveHistory, bumpUserCount, exportChat, buildMessages,
  memoryTick, flushMemory,
  listSessions, newSession, switchSession, renameSession, deleteSession,
};
