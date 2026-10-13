// hindsight-bridge.js — Hindsight 语义记忆桥（v0.6，Hindsight 集成 M3）
// 职责：deskpal 主进程与过滤代理（127.0.0.1:8890 → hindsight-api 8888）的 REST 交互。
// 延迟注记（M4 实测）：hindsight recall 全链路 3-8s（四路检索+GPU 重排）；recallTimeoutMs 默认 8s，
// send 入口 await 上限即此值——语义记忆注入以秒级首响应延迟为代价，可在 config/hindsight.json 调小。
// 设计纪律（评审 v1.3 §6.3 / bridge 设计备忘 §1）：
//   · 零 npm 依赖（原生 fetch + AbortController）；一切失败静默降级（logger.warn），绝不阻塞聊天主流程；
//   · recall 1.2s 超时；retain fire-and-forget（不 await 主链）；
//   · 过滤职能主责在服务侧代理（L1/L2/L3），本模块只做「本地 L1 纵深」（N-8，bridge 备忘 §5 可选纵深）：
//     注入前正则黑名单，命中不注入并留痕；
//   · bank 隔离（硬约束）：只读写 deskpal-tito，绝不触碰 hermes-*；
//   · attribution 三档（评审 §7.1）：A=user（用户亲历陈述）/B=external/C=unknown——
//     本桥两条写入通道（memoryTick 提取 / save_memory 工具）内容均源自用户对话陈述，标 user（A 档）。
'use strict';
const store = require('./store');
const logger = require('../logger');

function config() {
  const def = (store.DEFAULTS && store.DEFAULTS.hindsight) || {};
  const cur = store.get('hindsight') || {};
  return { ...def, ...cur };
}

let failCount = 0;
let lastFailAt = null;
let lastOkAt = null;

function timeoutSignal(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

async function rawFetch(url, opts = {}, timeoutMs = 1500) {
  const { signal, clear } = timeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { ok: res.ok, status: res.status, json, text };
  } finally { clear(); }
}

// 服务健康（探测 8890 代理；代理健康=全链路健康）
async function isUp() {
  try {
    const cfg = config();
    const r = await rawFetch(cfg.apiUrl + '/__proxy/health', {}, 800);
    return !!(r.ok && r.json && r.json.proxy === 'ok');
  } catch (_) { return false; }
}

// N-8 本地 L1 纵深（bridge 备忘 §2.2 必拦清单）：命中=不注入，留痕；与代理规则语义一致但独立维护——
// 代理规则文件改版不影响本地兜底。命中仅本地日志，不上传。
const LOCAL_L1 = [
  { name: 'sk-key', re: /sk-[A-Za-z0-9]{16,}/ },
  { name: 'apikey', re: /api[_-]?key\s*[:=]\s*\S{8,}/i },
  { name: 'bearer', re: /bearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'userpath', re: /C:\\\\Users\\\\[A-Za-z0-9_]+/ },
  { name: 'canon-kw', re: /宪法|锁层|禁忌条款|canon-chain/ },
];

function localFilter(text) {
  const hits = LOCAL_L1.filter(p => p.re.test(String(text || '')));
  return { clean: hits.length === 0, hits: hits.map(h => h.name) };
}

// 语义召回：query=当前用户消息；返回 ≤k 条干净文本（全部失败→[]）
async function recall(query, k) {
  const cfg = config();
  if (!cfg.enabled) return [];
  try {
    const r = await rawFetch(
      `${cfg.apiUrl}/v1/default/banks/${cfg.bank}/memories/recall`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: String(query || '') }) },
      cfg.recallTimeoutMs || 1200,
    );
    if (!r.ok || !r.json) throw new Error('recall HTTP ' + r.status);
    const results = Array.isArray(r.json.results) ? r.json.results : [];
    const out = [];
    for (const item of results) {
      const text = String(item.text || '').trim();
      if (!text) continue;
      const f = localFilter(text);
      if (!f.clean) { logger.warn('[hindsight] 本地 L1 拦截召回条目(' + f.hits.join(',') + '): ' + text.slice(0, 40)); continue; }
      // 归属未定前缀（评审 §7.1 C 档铁律：unknown 永不冒充 user）
      const attr = item.metadata && item.metadata.attribution;
      out.push((attr === 'unknown' ? '（归属未定）' : '') + text);
      if (out.length >= (k || cfg.recallK || 6)) break;
    }
    failCount = 0; lastOkAt = new Date().toISOString();
    return out;
  } catch (e) {
    failCount++; lastFailAt = new Date().toISOString();
    if (failCount <= 3 || failCount % 20 === 0) logger.warn('[hindsight] recall 失败(×' + failCount + '): ' + e.message);
    return [];
  }
}

// 写入（fire-and-forget）。items: [{content, context, metadata}]
// 失败仅计数+日志（静默降级）；全链路写入健康由服务侧 canary（doctor）闭环验证兜底。
async function retain(items, meta = {}) {
  const cfg = config();
  if (!cfg.enabled || !Array.isArray(items) || !items.length) return false;
  const payload = {
    items: items.map(it => ({
      content: String(it.content || ''),
      context: it.context != null ? String(it.context) : undefined,
      metadata: { ...(it.metadata || {}), source: meta.source || 'deskpal', attribution: (it.metadata && it.metadata.attribution) || 'user' },
      timestamp: it.timestamp || undefined,
    })),
    async: false,
  };
  try {
    const r = await rawFetch(
      `${cfg.apiUrl}/v1/default/banks/${cfg.bank}/memories`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
      8000,
    );
    if (!r.ok) throw new Error('retain HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 120));
    failCount = 0; lastOkAt = new Date().toISOString();
    return true;
  } catch (e) {
    failCount++; lastFailAt = new Date().toISOString();
    logger.warn('[hindsight] retain 失败(×' + failCount + '): ' + e.message);
    return false;
  }
}

function status() {
  return { failCount, lastFailAt, lastOkAt, config: config() };
}

// 启动询问链路（main.js 调用）：返回需要执行的提示动作，Electron API 留在 main 侧
async function startupCheck() {
  const cfg = config();
  if (!cfg.enabled || cfg.autoPrompt === false) return { prompt: false };
  const up = await isUp();
  return { prompt: !up, cfg };
}

module.exports = { config, isUp, recall, retain, localFilter, status, startupCheck };
