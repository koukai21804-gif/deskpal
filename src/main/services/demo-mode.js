// 演示模式（demo mode，v0.6.2）：用户向他人展示缇托能力时开启的会话级状态。
// 设计约束（spec《deskpal 演示模式》）：
//   · 会话级（session-scoped）：状态按 roleplay 会话 id 分开持有，只存内存——
//     不写长期记忆、不写 user profile、应用重启即重置为「非演示」；
//   · 打字机速度（chars/min）是唯一持久化项（settings.demo.speed），一次调节全局生效、
//     重启后仍按该速度显示；
//   · 命令族：/demo 进入（已在演示中则提示状态不重复进入）、/demo off 退出、
//     /demo status 查询（是否演示中+已持续轮次）、/demo speed -XX 调速（如 150）。
// 本模块只管状态机与命令解析；状态块注入见 prompts.demoBlock（system 最末段），
// 打字机渲染在聊天窗渲染层，记忆 demo 标记在 memory.addMemory/mergeExtracted。
const store = require('./store');
const logger = require('../logger');

const SPEED_MIN = 20, SPEED_MAX = 3000, SPEED_DEFAULT = 300; // 每分钟显示字数
// /demo 命令识别（渲染层与主进程双端同款思路；主进程兜底防止命令被误发进 LLM/历史）
const DEMO_COMMAND_RE = /^\s*\/\s*demo(?:\s+(.*))?$/i;

// sessionId -> { on, rounds, since }。只在内存里：重启重置是规格要求，不是遗漏。
const states = new Map();

function activeSessionId() {
  try { return require('./sessions').active().id; } catch (_) { return 's_main'; }
}

function stateOf(sessionId) {
  const key = sessionId || activeSessionId();
  if (!states.has(key)) states.set(key, { on: false, rounds: 0, since: null });
  return { key, st: states.get(key) };
}

function isOn(sessionId) { return stateOf(sessionId).st.on; }

// 状态快照（渲染层徽标/打字机用；speed 始终带出——它是全局持久设置）
function snapshot(sessionId) {
  const { key, st } = stateOf(sessionId);
  return { sessionId: key, on: st.on, rounds: st.rounds, since: st.since, speed: getSpeed() };
}

// 注入用最小块（prompts.roleplaySystem 的 opts.demo；off 时返回 null 保证状态块完全移除）
function blockFor(sessionId) {
  const st = stateOf(sessionId).st;
  return st.on ? { on: true, rounds: st.rounds } : null;
}

// 轮次计数：演示中每发一条 roleplay 用户消息 +1（chat.send 在组装上下文前调用，
// 状态块里的「已持续 N 轮」与本轮一致；/demo status 读同一个数）
function bumpRound(sessionId) {
  const st = stateOf(sessionId).st;
  if (!st.on) return 0;
  st.rounds += 1;
  return st.rounds;
}

// ---- 打字机速度（settings.demo.speed，持久） ----
function clampSpeed(v) {
  const n = Math.round(+v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
}
function getSpeed() {
  const n = clampSpeed(((store.get('settings').demo) || {}).speed);
  return n == null ? SPEED_DEFAULT : n;
}
function setSpeed(v) {
  const n = clampSpeed(v);
  if (n == null) return { ok: false, error: `速度必须是 ${SPEED_MIN}-${SPEED_MAX} 之间的整数（每分钟显示字数）` };
  store.set('settings', { demo: { speed: n } });
  return { ok: true, speed: n };
}

function isCommand(text) { return DEMO_COMMAND_RE.test(String(text || '')); }

// 命令执行：返回 { ok, changed, transition, message, state }——transition 供 ipc 层
// 落「系统事件」入史（on/off 都落：off 注是关闭后模型仍能正确自述「普通模式」的唯一信号，
// 因为规格要求状态块在关闭后完全移除、不得残留）
function execute(text, sessionId) {
  const { key, st } = stateOf(sessionId);
  const m = String(text || '').match(DEMO_COMMAND_RE);
  if (!m) return { ok: false, changed: false, message: '不是演示模式命令', state: snapshot(key) };
  const rest = String(m[1] || '').trim();

  // /demo speed -XX | /demo speed XX（横线是命令行惯用的前缀写法，不是负数）
  const sp = rest.match(/^speed\s+(\-?\d+)$/i);
  if (sp || /^speed\b/i.test(rest)) {
    if (!sp) return { ok: false, changed: false, message: `调速失败：速度必须是 ${SPEED_MIN}-${SPEED_MAX} 之间的整数（每分钟显示字数）。示例：/demo speed -150`, state: snapshot(key) };
    const r = setSpeed(sp[1].replace(/^\-/, ''));
    return r.ok
      ? { ok: true, changed: false, message: `打字机速度已设为每分钟 ${r.speed} 字（全局生效，重启后保持）`, state: snapshot(key) }
      : { ok: false, changed: false, message: `调速失败：${r.error}。示例：/demo speed -150`, state: snapshot(key) };
  }
  // /demo off
  if (/^off$/i.test(rest)) {
    if (!st.on) return { ok: true, changed: false, message: '当前不在演示模式中', state: snapshot(key) };
    st.on = false;
    logger.info('[demo] 演示模式退出（' + key + '，共 ' + st.rounds + ' 轮）');
    return { ok: true, changed: true, transition: 'off', message: `已退出演示模式（本次共 ${st.rounds} 轮）`, state: snapshot(key) };
  }
  // /demo status
  if (/^status$/i.test(rest)) {
    return st.on
      ? { ok: true, changed: false, message: `演示模式：开启中，已持续 ${st.rounds} 轮（打字机 ${getSpeed()} 字/分钟）；退出用 /demo off`, state: snapshot(key) }
      : { ok: true, changed: false, message: `演示模式：未开启（打字机速度 ${getSpeed()} 字/分钟已记忆）`, state: snapshot(key) };
  }
  // /demo（或未知后缀）：进入演示模式；已在演示中则提示状态、不重复进入
  if (st.on) {
    return { ok: true, changed: false, message: `已在演示模式中（已持续 ${st.rounds} 轮）。退出用 /demo off，查看状态用 /demo status`, state: snapshot(key) };
  }
  st.on = true; st.rounds = 0; st.since = new Date().toISOString();
  logger.info('[demo] 演示模式开启（' + key + '）');
  return {
    ok: true, changed: true, transition: 'on',
    message: `演示模式已开启：主动推进 / 术语必附短解 / 回复提速约 30% / 打字机逐字显示（${getSpeed()} 字/分钟）。退出用 /demo off`,
    state: snapshot(key),
  };
}

module.exports = {
  isCommand, execute, snapshot, isOn, blockFor, bumpRound,
  getSpeed, setSpeed, SPEED_MIN, SPEED_MAX, SPEED_DEFAULT,
  _states: states, // 测试用（重启重置断言）
};
