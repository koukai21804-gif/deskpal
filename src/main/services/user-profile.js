// 用户身份档案（开发版新增）：分层的对用户长期认知 + 随角色扮演对话漂移更新。
// 架构与搜索账本同款哲学：档案写入方只有主进程——
//   · 面板（用户裁决）经 IPC 写；
//   · 漂移（应用层）从真实对话提取，逐条落变更日志（含旧值快照，可回滚）；
//   · 角色本身无任何写通道（注入只读 + fs-guard 拒写 user/profile.json 双保险）。
// 分层（senpai-model §6.1 挂载优先级）：P0 身份锚（锁定）/ P1 性格与相处 / P2 近况与工作 /
// P3 关系档案。漂移只作用于 P1–P3；P0 仅面板可改（身份锚漂移 = 身份漂移，风险不成比例）。
const store = require('./store');
const llm = require('./llm');
const prompts = require('./prompts');
const sessions = require('./sessions');
const logger = require('../logger');

const LAYERS = ['P1', 'P2', 'P2b', 'P3'];
const DRIFT_LAYERS = ['P1', 'P2', 'P2b', 'P3'];
// 容量对齐 senpai-model 十组 55 字段架构（v0.4.0-dev.2）：P0=身份基座(A组)；P1=生理节奏/认知/
// 价值/情绪/交互(B-F组)；P2=职业与经济稳定层(G-H组)；P3=关系档案/元规则(E6-8/I组)。
// v0.5 新增 P2b=项目流水层：易变的项目进展/里程碑/工具链/单次审计结论——此前这类信息与
// 稳定职业锚挤同一批 30 个位置，实测 P2 满载静默拒收 17 条（M-4）。
const MAX_KEYS = 30;          // P1/P2/P3 每层键数上限
const P2B_MAX_KEYS = 20;      // P2b 项目流水层上限（高频覆盖 + 满载自动归档）
const KEY_MAX = 12;           // key 长度上限（字符）
const VALUE_MAX = 240;        // value 长度上限（漂移 120 + 预填/手动余量）
const P0_MAX = 1200;          // P0 身份锚上限（A 组 7 字段的压缩文本）
const MAX_LOG = 200;          // 变更日志上限（超出裁最旧）
const DRIFT_EVERY = 6;        // 每 6 条用户消息跑一次漂移（与记忆提取同节奏）
const DRIFT_MIN_SINCE = 2;    // 面板打开强制补跑的最低门槛（0 条新消息不烧调用）
// 满载策略（v0.5 M-4，v1.1 拍板「分层 + 高频自动淘汰归档」）：
//   P2b：满即淘汰归档最久未更新的 1 个键（项目流水天然高频，先到先挤没有意义）
//   P2 ：30 天内满载事件 ≥3 次才触发淘汰归档（腾 3 位）——稳定层不轻易动，先告警
//   P1/P3：永不自动淘汰（性格与关系档案误删代价高于腾位收益，护栏 G-2），只拒收+日志
const EVICT_TRIGGER_DAYS = 30;
const P2_EVICT_TRIGGER = 3;
const P2_EVICT_COUNT = 3;
const ARCHIVE_MAX = 500;

function layerCap(layer) { return layer === 'P2b' ? P2B_MAX_KEYS : MAX_KEYS; }

let driftRunning = false;
let seq = 0;

// 斜杠命令识别（渲染层与主进程双端同款正则；主进程兜底防止消息被误发进 LLM/历史）
const PROFILE_COMMAND_RE = /^\s*\/\s*user\s+profile\s*$/i;
function isProfileCommand(text) { return PROFILE_COMMAND_RE.test(String(text || '')); }

function get() { return store.get('user/profile'); }

function newLogId() { return 'pf_' + Date.now().toString(36) + '_' + (++seq); }

function cleanKey(k) { return String(k || '').trim().slice(0, KEY_MAX); }
// 截断可见化（P0-3）：value 被截必须带省略号——面板与注入里可区分完整值与截断值
function cleanValue(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.length > VALUE_MAX ? s.slice(0, VALUE_MAX - 1) + '…' : s;
}
function cleanLayer(obj, cap = MAX_KEYS) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = cleanKey(k), val = cleanValue(v);
    if (key && val && Object.keys(out).length < cap) out[key] = val;
  }
  return out;
}

function pushLog(doc, entry) {
  doc.log = [...(doc.log || []), entry].slice(-MAX_LOG);
}

// key 最近更新时间（注入截断保新 + 满载淘汰的排序依据）；缺失回落到 log 里最近一次生效时间
function touchKey(doc, layer, key) {
  doc.touched = doc.touched || {};
  doc.touched[layer] = doc.touched[layer] || {};
  doc.touched[layer][key] = new Date().toISOString();
}
function keyTouchedAt(doc, layer, key) {
  const t = doc.touched && doc.touched[layer] && doc.touched[layer][key];
  if (t) return String(t);
  const hit = [...(doc.log || [])].reverse().find(e => e.layer === layer && e.key === key && e.applied);
  return hit ? String(hit.at) : '';
}

// 归档（append-only）：满载淘汰的条目移入 user/profile-archive，面板可查可还原。
// 诚实边界：归档条目不进注入面——不还原 = 事实上已退出角色认知；归档的价值是可回溯。
function archivePush(layer, key, value, reason) {
  const a = store.get('user/profile-archive');
  a.items = [...(a.items || []), { at: new Date().toISOString(), layer, key, value, reason, restoredAt: null }];
  if (a.items.length > ARCHIVE_MAX) a.items = a.items.slice(-ARCHIVE_MAX);
  store.replace('user/profile-archive', a);
}

// 层内最久未更新的 n 个键（touched 升序；从未变更的种子键视为最旧、优先淘汰）
function staleKeys(doc, layer, n) {
  const cur = doc[layer] || {};
  return Object.keys(cur)
    .map(k => ({ k, t: keyTouchedAt(doc, layer, k) }))
    .sort((a, b) => String(a.t).localeCompare(String(b.t)))
    .slice(0, n)
    .map(x => x.k);
}

// 30 天内该层满载事件数（从 log 派生，不新增字段）
function fullEvents(doc, layer, days = EVICT_TRIGGER_DAYS) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  return (doc.log || []).filter(e => e.layer === layer && e.applied === false
    && /键数已达上限/.test(e.note || '')
    && new Date(e.at || 0).getTime() >= cutoff).length;
}

// 单条漂移变更落档：非法层级/超限 → 日志记 applied:false（可审计），绝不静默丢弃。
// 满载策略（M-4 修复）：P2b 满即归档腾位；P2 满 + 高频满载（30 天 ≥3 次）才归档腾位；
// P1/P3 永不自动淘汰，只拒收留痕。归档而非丢弃——条目可回溯、可还原。
function applyChange(doc, ch) {
  const layer = LAYERS.includes(ch.layer) ? ch.layer : null;
  const key = cleanKey(ch.key);
  const value = cleanValue(ch.value);
  const entry = {
    id: newLogId(), at: new Date().toISOString(), source: ch.source || 'drift',
    layer: layer || String(ch.layer || ''), key,
    old: null, new: null,
    quote: String(ch.quote || '').slice(0, 60), reason: String(ch.reason || '').slice(0, 40),
    applied: false, revertedAt: null, note: '',
  };
  if (!layer || layer === 'P0') {
    entry.note = layer === 'P0' || String(ch.layer) === 'P0' ? 'P0 身份锚锁定，漂移不可修改' : '非法层级';
  } else if (!key || !value) {
    entry.note = 'key 或 value 为空';
  } else {
    const cur = doc[layer] || {};
    const isNew = !Object.prototype.hasOwnProperty.call(cur, key);
    if (isNew && Object.keys(cur).length >= layerCap(layer)) {
      let evicted = 0;
      if (layer === 'P2b') {
        for (const k of staleKeys(doc, layer, 1)) {
          archivePush(layer, k, cur[k], 'full-eviction');
          delete cur[k];
          evicted++;
        }
        entry.note = `层 P2b 键数已达上限，已归档最久未更新的 ${evicted} 个键后落档（归档可在面板还原）`;
      } else if (layer === 'P2' && fullEvents(doc, layer) >= P2_EVICT_TRIGGER) {
        for (const k of staleKeys(doc, layer, P2_EVICT_COUNT)) {
          archivePush(layer, k, cur[k], 'full-eviction');
          delete cur[k];
          evicted++;
        }
        entry.note = `层 P2 满载高频（30 天内 ≥${P2_EVICT_TRIGGER} 次），已归档最久未更新的 ${evicted} 个键后落档`;
      } else {
        entry.note = `层 ${layer} 键数已达上限 ${layerCap(layer)}`
          + (layer === 'P2' ? `（30 天内满载 ${fullEvents(doc, layer)}/${P2_EVICT_TRIGGER} 次，达到阈值将自动归档腾位）` : '');
      }
      if (!evicted) { pushLog(doc, entry); return entry; }
    }
    entry.old = Object.prototype.hasOwnProperty.call(cur, key) ? cur[key] : null;
    entry.new = value;
    entry.applied = true;
    doc[layer] = { ...cur, [key]: value };
    touchKey(doc, layer, key);
  }
  pushLog(doc, entry);
  return entry;
}

// ---- 漂移提取（LLM → JSON 变更数组 → 逐条落档） ----
async function runDrift() {
  const msgs = sessions.active().messages || [];
  const recent = msgs.slice(-20)
    .map(m => `${m.role === 'user' ? '用户' : '角色'}: ${prompts.stripHarnessNotes(m.content)}`)
    .join('\n');
  const doc = get();
  let changes = [];
  try {
    const out = await llm.genericCompletion(
      [{ role: 'system', content: prompts.userProfileDriftPrompt({ P0: doc.P0, P1: doc.P1, P2: doc.P2, P2b: doc.P2b, P3: doc.P3 }, recent) }],
      { temperature: 0.3, maxTokens: 1024 },
    );
    const m = String(out || '').match(/\[[\s\S]*\]/);
    if (m) {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        changes = arr.filter(x => x && x.layer && x.key && x.value).slice(0, 5)
          .map(x => ({ layer: x.layer, key: x.key, value: x.value, quote: x.quote, reason: x.reason, source: 'drift' }));
      }
    }
  } catch (e) {
    logger.warn('身份档案漂移提取失败: ' + e.message);
    return { changed: 0, error: e.userMsg || e.message };
  }
  if (!changes.length) {
    // 提取已跑过：本轮窗口已审视，计数照清（否则下一条消息就重跑、重复审视同一窗口）
    store.replace('user/profile', { ...doc, driftCountSince: 0, lastDriftAt: new Date().toISOString() });
    return { changed: 0 };
  }
  const applied = changes.map(ch => applyChange(doc, ch));
  store.replace('user/profile', { ...doc, driftCountSince: 0, lastDriftAt: new Date().toISOString() });
  const n = applied.filter(e => e.applied).length;
  if (n) logger.info(`[user-profile] 漂移落档 ${n} 条`);
  return { changed: n, total: applied.length };
}

// 提取节奏（与记忆提取同款三路触发中的两路：节奏阈值 / 面板打开强制；会话冷却补提取共用 memoryTick 的触发点）
async function tick(force = false) {
  if (driftRunning) return false;
  const doc = get();
  if (doc.drift === false) return false; // 漂移总开关关闭
  const since = doc.driftCountSince || 0;
  if (since <= 0) return false;
  if (!force && since < DRIFT_EVERY) return false;
  if (force && since < DRIFT_MIN_SINCE) return false;
  driftRunning = true;
  try {
    return await runDrift();
  } finally {
    driftRunning = false;
  }
}

// 用户消息计数（chat.js bumpUserCount 同步调用；只统计 roleplay）
function bump() {
  const doc = get();
  store.replace('user/profile', { ...doc, driftCountSince: (doc.driftCountSince || 0) + 1 });
}

// ---- 面板操作 ----
function saveDoc(input) {
  const cur = get();
  const doc = {
    enabled: input.enabled !== false,
    drift: input.drift !== false,
    P0: String(input.P0 || '').trim().slice(0, P0_MAX),
    P1: cleanLayer(input.P1),
    P2: cleanLayer(input.P2),
    P2b: cleanLayer(input.P2b, P2B_MAX_KEYS),
    P3: cleanLayer(input.P3),
    log: Array.isArray(input.log) ? input.log.slice(-MAX_LOG) : (cur.log || []),
    // 面板直接编辑视作显式触碰：保留 touched 里仍存在的键时间，新键补当前时间
    touched: cur.touched || {},
    // 计数不进面板编辑面：面板保存不带计数（undefined → 保留当前）；测试/内部可显式置 0
    driftCountSince: Number.isFinite(+input.driftCountSince) ? Math.max(0, Math.round(+input.driftCountSince)) : (cur.driftCountSince || 0),
    lastDriftAt: cur.lastDriftAt || null,
  };
  for (const L of LAYERS) {
    doc.touched[L] = doc.touched[L] || {};
    for (const k of Object.keys(doc[L])) {
      if (!doc.touched[L][k]) doc.touched[L][k] = new Date().toISOString();
    }
  }
  store.replace('user/profile', doc);
  return doc;
}

// 回滚一条漂移：仅当字段当前值仍等于该条写入值（被后续漂移覆盖的不许一键回滚，面板直接编辑）
function revert(logId) {
  const doc = get();
  const entry = (doc.log || []).find(e => e.id === logId);
  if (!entry) throw new Error('找不到这条变更日志');
  if (entry.source !== 'drift' || !entry.applied) throw new Error('该条不是已生效的漂移变更，不能回滚');
  if (entry.revertedAt) throw new Error('该条已回滚过');
  const cur = doc[entry.layer] || {};
  if (cur[entry.key] !== entry.new) throw new Error('该字段已被后续更新覆盖，请直接在面板中编辑为新值');
  if (entry.old == null) { const { [entry.key]: _drop, ...rest } = cur; doc[entry.layer] = rest; }
  else doc[entry.layer] = { ...cur, [entry.key]: entry.old };
  entry.revertedAt = new Date().toISOString();
  pushLog(doc, { id: newLogId(), at: new Date().toISOString(), source: 'user', layer: entry.layer, key: entry.key, old: entry.new, new: entry.old, quote: '', reason: '回滚', applied: true, revertedAt: null, note: '回滚漂移 ' + logId });
  store.replace('user/profile', doc);
  return { ok: true };
}

// ---- 预填（senpai-model 全量字段导入；fill-empty 语义：已有值一律保留，只补空缺） ----
// 预填内容不含假设区/校准日志/来源标注（文档自身规则：假设未验证不得写入结论；
// 引用编号对无文件访问的上下文是噪声）。种子 JSON 经面板文件选择或 seed-profile.js 脚本进入，
// 内容本身不进代码库与 app.asar（隐私边界与 docs/ 移出库同一考量）。
function applySeed(seed) {
  const cur = get();
  const s = seed || {};
  const merged = {
    enabled: cur.enabled !== false,
    drift: cur.drift !== false,
    P0: String(cur.P0 || '').trim() || String(s.P0 || '').trim(),
    P1: { ...(cleanLayer(s.P1 || {})) },
    P2: { ...(cleanLayer(s.P2 || {})) },
    P2b: { ...(cleanLayer(s.P2b || {}, P2B_MAX_KEYS)) },
    P3: { ...(cleanLayer(s.P3 || {})) },
    log: cur.log || [],
    touched: cur.touched || {},
    driftCountSince: cur.driftCountSince || 0,
    lastDriftAt: cur.lastDriftAt || null,
  };
  const added = { P0: 0, P1: 0, P2: 0, P2b: 0, P3: 0 };
  if (!String(cur.P0 || '').trim() && String(s.P0 || '').trim()) added.P0 = 1;
  // 已有字段（含漂移更新过的）一律胜出——预填永不覆盖真实认知
  for (const L of LAYERS) {
    for (const [k, v] of Object.entries(cur[L] || {})) {
      if (v && String(v).trim()) merged[L][k] = String(v).trim();
    }
    added[L] = Object.keys(merged[L]).length - Object.keys(cur[L] || {}).filter(k => String((cur[L] || {})[k] || '').trim()).length;
    for (const k of Object.keys(merged[L])) {
      merged.touched[L] = merged.touched[L] || {};
      if (!merged.touched[L][k]) merged.touched[L][k] = '';
    }
  }
  store.replace('user/profile', merged);
  return { added, total: { P1: Object.keys(merged.P1).length, P2: Object.keys(merged.P2).length, P2b: Object.keys(merged.P2b).length, P3: Object.keys(merged.P3).length } };
}

// ---- 满载淘汰归档（v0.5 M-4）：面板查看 / 还原 ----
function listArchive() {
  return (store.get('user/profile-archive').items || []).slice().reverse();
}
function restoreArchive(index) {
  const a = store.get('user/profile-archive');
  const items = a.items || [];
  // 面板传的是「倒序显示序号」——按显示顺序换算回存储下标
  const viewIdx = items.length - 1 - Math.max(0, Math.round(+index));
  const target = items[viewIdx];
  if (!target || target.restoredAt != null) throw new Error('找不到这条归档条目');
  const doc = get();
  const cur = doc[target.layer] || {};
  if (!Object.prototype.hasOwnProperty.call(cur, target.key) && Object.keys(cur).length >= layerCap(target.layer)) {
    // 目标层已满：同一套淘汰逻辑腾位（不阻塞还原）
    for (const k of staleKeys(doc, target.layer, 1)) {
      archivePush(target.layer, k, cur[k], 'full-eviction');
      delete cur[k];
    }
  }
  doc[target.layer] = { ...cur, [target.key]: target.value };
  touchKey(doc, target.layer, target.key);
  pushLog(doc, { id: newLogId(), at: new Date().toISOString(), source: 'user', layer: target.layer, key: target.key, old: null, new: target.value, quote: '', reason: '归档还原', applied: true, revertedAt: null, note: '还原满载归档条目' });
  store.replace('user/profile', doc);
  target.restoredAt = new Date().toISOString();
  store.replace('user/profile-archive', a);
  return { ok: true };
}

module.exports = { isProfileCommand, get, saveDoc, revert, tick, bump, applyChange, applySeed, listArchive, restoreArchive, LAYERS, MAX_KEYS };
