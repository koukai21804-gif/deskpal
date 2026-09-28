// websearch/ledger.jsonl 搜索台账（spec §9.1，照 runs.js 四件套模式）：
// 追加式记录每一次 web_search（含被拦截 blocked / 被拒 denied / 失败 failed / 缓存命中 cached——
// 红线的可验证性依赖「拒绝也有记录」）。写方只有主进程出口层；Agent 侧无任何写通道
// （工具面无写账本工具 + fs-guard 拒写名单双保险）。启动时校验末行完整性并裁剪超限旧条目。
const fs = require('fs');
const path = require('path');
const store = require('../store');
const logger = require('../../logger');

// 斜杠命令识别（渲染层与主进程双端同款正则；主进程兜底防止消息被误发进 LLM/历史）
const LEDGER_COMMAND_RE = /^\s*\/\s*search\s+ledger\s*$/i;
function isLedgerCommand(text) { return LEDGER_COMMAND_RE.test(String(text || '')); }

const MAX_ENTRIES = 1000; // 搜索条目比 run 密，启动重写时裁最旧的
let seq = 0;

function ledgerFile() { return path.join(store.getDataDir(), 'websearch', 'ledger.jsonl'); }

function newEntryId() { return 'ws_' + Date.now().toString(36) + '_' + (++seq); }

function append(entry) {
  try {
    fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
    fs.appendFileSync(ledgerFile(), JSON.stringify(entry) + '\n', 'utf8');
    notifyChanged();
  } catch (e) { logger.error(e); }
}

function readAll() {
  const out = [];
  try {
    const text = fs.readFileSync(ledgerFile(), 'utf8');
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch (_) { /* 跳过坏行 */ }
    }
  } catch (_) { /* 文件不存在 */ }
  return out;
}

// 用户后置裁决（✓ 认可 / ✗ 划除）：按 id 整行重写，原子落盘
function update(id, patch) {
  const all = readAll();
  const i = all.findIndex(e => e && e.id === id);
  if (i < 0) return null;
  all[i] = { ...all[i], ...patch };
  try {
    fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
    const tmp = ledgerFile() + '.rewrite.tmp';
    fs.writeFileSync(tmp, all.map(e => JSON.stringify(e)).join('\n') + (all.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, ledgerFile());
    notifyChanged();
  } catch (e) { logger.error(e); return null; }
  return all[i];
}

// 启动恢复：搜索无长事务，只做超限裁剪 + 坏行自然跳过（readAll 已容忍）
function trimOnBoot() {
  let all = readAll();
  if (all.length <= MAX_ENTRIES) return { trimmed: 0 };
  all = all.slice(all.length - MAX_ENTRIES);
  try {
    fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
    const tmp = ledgerFile() + '.tmp';
    fs.writeFileSync(tmp, all.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, ledgerFile());
  } catch (e) { logger.error(e); return { trimmed: 0 }; }
  return { trimmed: MAX_ENTRIES };
}

// ---- 面板查询（spec §9.3）：range 过滤 + 分账汇总 + 轨道存疑启发式 ----
function dayStart(offsetDays = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return d.getTime();
}

// 轨道存疑（spec §5.4 X1 缓解）：自报 designated 但当轮用户指令与 query 字符重合度过低。
// 启发式而非判定——只打标记供用户抽查，不改判、不拦截。
function overlapRatio(a, b) {
  const A = new Set(String(a || '').replace(/\s/g, '').split(''));
  const B = new Set(String(b || '').replace(/\s/g, '').split(''));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const ch of B) if (A.has(ch)) hit++;
  return hit / B.size;
}

function summarize(entries) {
  const sum = {
    designated: { count: 0, estTokens: 0 },
    autonomous: { count: 0, estTokens: 0, rejected: 0 },
    blocked: 0, denied: 0, failed: 0, cached: 0,
  };
  for (const e of entries) {
    if (e.track === 'autonomous') {
      sum.autonomous.count++;
      sum.autonomous.estTokens += e.estTokens || 0;
      if (e.verdict === 'rejected') sum.autonomous.rejected++;
    } else if (e.track === 'designated') {
      sum.designated.count++;
      sum.designated.estTokens += e.estTokens || 0;
    }
    if (e.status === 'blocked') sum.blocked++;
    else if (e.status === 'denied') sum.denied++;
    else if (e.status === 'failed') sum.failed++;
    else if (e.status === 'cached') sum.cached++;
  }
  return sum;
}

function query({ range = 'all', track } = {}) {
  let all = readAll();
  const since = range === 'today' ? dayStart(0) : range === 'week' ? dayStart(6) : range === 'month' ? dayStart(29) : 0;
  if (since) all = all.filter(e => new Date(e.at || 0).getTime() >= since);
  if (track) all = all.filter(e => e.track === track);
  const entries = all.slice(-300).reverse().map(e => ({
    ...e,
    suspect: e.track === 'designated' && e.status === 'ok' && overlapRatio(e.reqText, e.query) < 0.34 ? true : undefined,
  }));
  return { entries, summary: summarize(all) };
}

// 当日自主轨成功条数（日限计数口径：track=autonomous 且 status=ok）
function autonomousCountToday() {
  const since = dayStart(0);
  return readAll().filter(e => e.track === 'autonomous' && e.status === 'ok' && new Date(e.at || 0).getTime() >= since).length;
}

// ---- 面板打开时增量刷新（spec §8：search:ledger-changed 推送） ----
let onChange = null;
function notifyChanged() {
  if (!onChange) return;
  try { onChange(); } catch (_) {}
}
function setChangeListener(fn) { onChange = fn; }

module.exports = { newEntryId, append, readAll, update, trimOnBoot, query, autonomousCountToday, setChangeListener, isLedgerCommand };
