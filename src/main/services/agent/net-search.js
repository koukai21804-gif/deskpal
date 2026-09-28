// 联网搜索出口层（titor_net_access_spec v2.1 §4/§5）：主进程内服务模块，非 HTTP 服务 / CLI / MCP。
// 职责：持凭证（safeStorage）→ 敏感拦截（PII/回避话题/长度）→ 冷却与日限 → 发起 fetch →
// 结构化结果 → 落账（含被拦截/被拒/失败/缓存）。查询词是唯一外发字段；结果不持久化（仅内存冷却缓存）。
// Agent 侧只经 web_search 工具发起「语义化请求」，不感知源/协议/凭证（R4）。
const { safeStorage } = require('electron');
const store = require('../store');
const logger = require('../../logger');
const windows = require('../../windows');
const ledger = require('./search-ledger');
const permissions = require('./permissions');
const { tokenEstimate } = require('../token-est');

// ---------- 查询词本地拦截规则（规则表不出网） ----------
const PII_RULES = [
  { name: '身份证号', re: /\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]/ },
  { name: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { name: '邮箱地址', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  { name: '住址门牌', re: /[\u4e00-\u9fff]{1,8}(省|市|区|县|路|街|道|巷)[\u4e00-\u9fff0-9]{0,24}\d+号/ },
  { name: '本机路径', re: /[a-z]:[\\/]/i },
];
const QUERY_MAX_LEN = 120;

function hitPII(q) { for (const r of PII_RULES) { if (r.re.test(q)) return r.name; } return null; }
function hitBlockedTopic(q, topics) {
  for (const raw of topics || []) {
    const s = String(raw || '').trim();
    if (!s) continue;
    const m = s.match(/^\/(.+)\/([a-z]*)$/);
    try {
      if (m ? new RegExp(m[1], m[2] || 'i').test(q) : q.toLowerCase().includes(s.toLowerCase())) return s;
    } catch (_) { /* 用户写的坏正则按子串处理 */ if (q.toLowerCase().includes(s.toLowerCase())) return s; }
  }
  return null;
}

// ---------- 凭证（R4：key 只存主进程内存 + safeStorage 密文，不进 schema/prompt/回填/渲染层） ----------
function getSearchConfig() {
  const s = store.get('search');
  let key = '';
  if (s.searchKeyEnc) {
    try { key = safeStorage.decryptString(Buffer.from(s.searchKeyEnc, 'base64')); } catch (_) { key = ''; }
  }
  return { source: String(s.source || ''), endpoint: String(s.endpoint || ''), key };
}

function saveKey(key) {
  let enc = '';
  try {
    if (key) enc = safeStorage.encryptString(String(key)).toString('base64');
  } catch (e) { logger.warn('safeStorage 加密失败: ' + e.message); }
  store.set('search', { searchKeyEnc: enc });
  return { ok: true };
}

// ---------- 供应商注册表（源可换，接口不变：searchOnce({query,maxResults,timeoutMs}) → {results,usage}） ----------
async function fetchJSON(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 }) {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const e = new Error(`搜索源返回 ${res.status}${t ? '：' + t.slice(0, 120) : ''}`);
    e.userMsg = res.status === 401 || res.status === 403 ? '搜索源 API Key 无效或没有权限'
      : res.status === 429 ? '搜索源调用频率/额度超限，请稍后再试'
      : `搜索源接口返回 ${res.status}`;
    throw e;
  }
  return res.json();
}

const PROVIDERS = {
  tavily: {
    label: 'Tavily', needsKey: true, needsEndpoint: false,
    keyHint: 'app.tavily.com → Overview → API Key（免费档 1000 次/月）',
    async searchOnce({ query, maxResults, timeoutMs, key }) {
      const j = await fetchJSON('https://api.tavily.com/search', {
        method: 'POST',
        body: { api_key: key, query, max_results: maxResults, search_depth: 'basic' },
        timeoutMs,
      });
      return {
        results: (j.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content })),
        usage: j.answer ? { answer: true } : null,
      };
    },
  },
  exa: {
    label: 'Exa', needsKey: true, needsEndpoint: false,
    keyHint: 'dashboard.exa.ai → API Keys（免费档 $10 额度）',
    async searchOnce({ query, maxResults, timeoutMs, key }) {
      const j = await fetchJSON('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'x-api-key': key },
        body: { query, numResults: maxResults, contents: { text: { maxCharacters: 400 } } },
        timeoutMs,
      });
      return {
        results: (j.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.text })),
        usage: null,
      };
    },
  },
  brave: {
    label: 'Brave Search', needsKey: true, needsEndpoint: false,
    keyHint: 'brave.com/search/api → 免费档 2000 次/月，Data for AI Free 计划',
    async searchOnce({ query, maxResults, timeoutMs, key }) {
      const j = await fetchJSON('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=' + maxResults, {
        headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
        timeoutMs,
      });
      return {
        results: ((j.web && j.web.results) || []).map(r => ({ title: r.title, url: r.url, snippet: r.description })),
        usage: null,
      };
    },
  },
  searxng: {
    label: 'SearXNG（自托管）', needsKey: false, needsEndpoint: true,
    keyHint: '无需 Key；endpoint 填自托管实例地址（须开启 JSON format）',
    async searchOnce({ query, maxResults, timeoutMs, endpoint }) {
      const base = String(endpoint || '').replace(/\/+$/, '');
      const j = await fetchJSON(base + '/search?q=' + encodeURIComponent(query) + '&format=json&language=zh-CN', { timeoutMs });
      return {
        results: (j.results || []).slice(0, maxResults).map(r => ({ title: r.title, url: r.url, snippet: r.content })),
        usage: null,
      };
    },
  },
  // 桩源：固定假数据 + query 回显。仅离线开发/测试（管线、账本、面板、守卫全链路），
  // 不出现在设置页供应商清单；结果带明显「[stub]」前缀防被当成真数据。
  stub: {
    label: 'stub（离线测试）', needsKey: false, needsEndpoint: false,
    async searchOnce({ query, maxResults }) {
      return {
        results: [
          { title: '[stub] ' + query + ' —— 概览', url: 'https://example.com/stub/1', snippet: `关于「${query}」的桩结果一：这是离线测试数据，非真实网络内容。` },
          { title: '[stub] ' + query + ' —— 深度解读', url: 'https://example.com/stub/2', snippet: `关于「${query}」的桩结果二：maxResults=${maxResults}，仅用于验证管线与账本。` },
        ],
        usage: { stub: true },
      };
    },
  },
};

// 设置页下拉（stub 不进清单）
function listProviders() {
  return Object.entries(PROVIDERS)
    .filter(([k]) => k !== 'stub')
    .map(([id, p]) => ({ id, label: p.label, needsKey: p.needsKey, needsEndpoint: p.needsEndpoint, keyHint: p.keyHint }));
}

// ---------- 冷却（内存级，不持久化；重启即清） ----------
const cooldownCache = new Map(); // normQuery -> { at, entryId, source, results, usage }
let limitNotifiedDay = '';       // 日限提示「同日一次」标记（YYYY-MM-DD）

function normQuery(q) { return String(q || '').toLowerCase().replace(/\s+/g, ''); }
function wsSettings() {
  const ws = (store.get('settings').agent || {}).webSearch || {};
  return {
    enabled: !!ws.enabled,
    dailyLimit: Number.isFinite(+ws.autonomousDailyLimit) ? Math.max(0, Math.round(+ws.autonomousDailyLimit)) : 100,
    cooldownMin: Number.isFinite(+ws.cooldownMin) ? Math.max(0, Math.round(+ws.cooldownMin)) : 10,
    blockedTopics: Array.isArray(ws.blockedTopics) ? ws.blockedTopics : [],
  };
}

function petBubble(text) {
  try { windows.broadcastAll('pet:bubble', { kind: 'perm-ask', text }); } catch (_) {}
}

// ---------- 主入口（web_search 工具 handler → 这里） ----------
// 返回体（回填给模型）：{ok, source, query, results, usage, note}；被拦截/被拒/失败时 {ok:false, error, …}
async function execute(args, ctx = {}) {
  const query = String(args.query || '').trim();
  const track = args.track === 'autonomous' ? 'autonomous' : 'designated';
  const reason = String(args.reason || '').trim().slice(0, 60);
  let maxResults = Math.round(+args.maxResults);
  if (!Number.isFinite(maxResults) || maxResults < 1) maxResults = 5;
  maxResults = Math.min(8, maxResults);

  if (!query) return { ok: false, error: '缺少检索词（query 参数不能为空）' };
  if (!reason) return { ok: false, error: '缺少 reason 参数：请说明为什么发起这次检索（≤60字）' };

  const ws = wsSettings();
  const cfg = getSearchConfig();
  const srcLabel = cfg.source || 'unconfigured';
  const entryBase = {
    id: ledger.newEntryId(),
    at: new Date().toISOString(),
    runId: ctx.runId || null,
    reqId: ctx.reqId || null,
    reqText: String(ctx.instruction || '').slice(0, 80),
    track, query, reason,
    source: srcLabel,
    status: 'ok',
    results: 0, resultChars: 0,
    usage: null, estTokens: 0, durationMs: 0,
    verdict: track === 'autonomous' ? 'pending' : null, verdictAt: null,
    blockRule: null,
  };
  const finish = (patch) => {
    const entry = { ...entryBase, ...patch };
    ledger.append(entry);
    return entry;
  };

  // ---- 出口侧三道本地拦截（R1/R3；blocked 也落账） ----
  if (query.length > QUERY_MAX_LEN) {
    finish({ status: 'blocked', blockRule: '长度超120字' });
    return { ok: false, error: `检索词过长（${query.length} 字，上限 ${QUERY_MAX_LEN}）：疑似把大段本地内容当查询词外发，已拦截。请提炼为简短检索词。` };
  }
  const pii = hitPII(query);
  if (pii) {
    finish({ status: 'blocked', blockRule: 'PII:' + pii });
    return { ok: false, error: `查询词疑似包含个人敏感信息（${pii}），已被拦截。请改写为不含任何个人信息/本机路径的检索词。` };
  }
  const topic = hitBlockedTopic(query, ws.blockedTopics);
  if (topic) {
    finish({ status: 'blocked', blockRule: '回避话题' });
    return { ok: false, error: '查询词命中你设置的回避话题表，已被拦截。如需检索该话题，请在设置→联网搜索中调整回避话题表。' };
  }

  // ---- 开关闸（§5.2 决策表：默认关闭，聊天内授权卡开启） ----
  if (!ws.enabled) {
    if (track === 'autonomous') {
      // 不弹卡直接拒（防模型用授权卡试探开启）
      finish({ status: 'denied' });
      return { ok: false, error: '联网搜索未开启，仅用户明确要求的检索可触发开启授权。' };
    }
    const pr = await permissions.request({
      runId: ctx.runId, reqId: ctx.reqId, tool: 'web_search',
      action: '开启联网搜索',
      scopePaths: [query.slice(0, 60)],
      detail: `检索词「${query.slice(0, 40)}」；开启后可随时在 设置→联网搜索 关闭`,
      reason,
      reversibility: '设置页一键关闭（关闭即时生效）',
      timeoutSec: ctx.permTimeoutSec || 120,
    });
    if (pr.decision !== 'allow_once') {
      finish({ status: 'denied' });
      return { ok: false, error: '用户没有同意开启联网搜索，本次不执行。请如实告知用户。' };
    }
    store.set('settings', { agent: { webSearch: { enabled: true } } });
    if (ctx.step) { try { ctx.step({ kind: 'notice', notice: 'search_enabled', text: '联网搜索已开启，可在设置→联网搜索 关闭' }); } catch (_) {} }
  }

  // ---- 源配置闸（开启与配置是两道独立的闸） ----
  const provider = cfg.source ? PROVIDERS[cfg.source] : null;
  if (!provider) {
    finish({ status: 'failed', blockRule: '源未配置' });
    return { ok: false, error: '搜索源未配置：请到 设置→联网搜索 选择供应商并填写 API Key（stub 源仅测试用）。' };
  }
  if (provider.needsKey && !cfg.key) {
    finish({ status: 'failed', blockRule: 'Key未配置' });
    return { ok: false, error: '搜索源已选择但 API Key 未配置，请到 设置→联网搜索 填写。' };
  }
  if (provider.needsEndpoint && !cfg.endpoint) {
    finish({ status: 'failed', blockRule: 'endpoint未配置' });
    return { ok: false, error: 'SearXNG 需要填写自托管实例地址（endpoint）。' };
  }

  // ---- 冷却（命中：不发请求、不重复计费，落账 cached 引用首条） ----
  const norm = normQuery(query);
  const cached = cooldownCache.get(norm);
  if (cached && ws.cooldownMin > 0 && Date.now() - cached.at < ws.cooldownMin * 60000) {
    finish({ status: 'cached', refId: cached.entryId, results: cached.results.length, resultChars: cached.resultChars, estTokens: cached.estTokens });
    return buildBody({ ok: true, source: cached.source, query, results: cached.results, usage: cached.usage, cachedRef: cached.entryId }, track);
  }
  if (cached) cooldownCache.delete(norm);

  // ---- 自主轨：日限（达限拒绝 + 应用提示同日一次）+ 逐次权限卡 ----
  if (track === 'autonomous') {
    const used = ledger.autonomousCountToday();
    if (used >= ws.dailyLimit) {
      const today = new Date().toISOString().slice(0, 10);
      if (limitNotifiedDay !== today) {
        limitNotifiedDay = today;
        petBubble('今日自主检索已达上限');
        if (ctx.step) { try { ctx.step({ kind: 'notice', notice: 'search_limit', text: `今日自主检索已达 ${ws.dailyLimit} 次上限，仅可执行用户明确要求的检索` }); } catch (_) {} }
      }
      finish({ status: 'denied', blockRule: '日限' });
      return { ok: false, error: `今日自主检索额度已用完（${ws.dailyLimit} 次/日），仅可执行用户明确要求的检索。` };
    }
    const pr = await permissions.request({
      runId: ctx.runId, reqId: ctx.reqId, tool: 'web_search',
      action: '自主联网检索',
      scopePaths: [query.slice(0, 60)],
      detail: reason,
      reason,
      reversibility: '仅查询不落盘，账本面板可划除该条',
      timeoutSec: ctx.permTimeoutSec || 120,
    });
    if (pr.decision !== 'allow_once') {
      finish({ status: 'denied' });
      return { ok: false, error: '用户没有批准这次自主检索（未批准/超时/停止均按拒绝），本次不执行。' };
    }
  }

  // ---- 发起检索（超时/网络错误如实回填，绝不编造结果） ----
  const t0 = Date.now();
  let out;
  try {
    out = await provider.searchOnce({ query, maxResults, timeoutMs: 15000, key: cfg.key, endpoint: cfg.endpoint });
    if (!out || !Array.isArray(out.results)) throw new Error('搜索源返回结构异常');
  } catch (e) {
    const msg = e.userMsg || e.message;
    logger.warn('[net-search] 检索失败: ' + msg);
    finish({ status: 'failed', durationMs: Date.now() - t0 });
    return { ok: false, error: '搜索源暂不可用（' + msg + '）。请如实告知用户，不要编造检索结果。' };
  }
  const durationMs = Date.now() - t0;
  const results = out.results.slice(0, maxResults).map(r => ({
    title: String(r.title || '').slice(0, 120),
    url: String(r.url || '').slice(0, 300),
    snippet: String(r.snippet || '').slice(0, 500),
  }));

  const body = buildBody({ ok: true, source: cfg.source, query, results, usage: out.usage || null }, track);
  // 先落账（元数据不存结果全文，R6），再进冷却缓存
  const bodyStr = JSON.stringify(body);
  finish({ status: 'ok', results: results.length, resultChars: bodyStr.length, usage: out.usage || null, estTokens: Math.round(tokenEstimate(bodyStr)), durationMs });
  cooldownCache.set(norm, { at: Date.now(), entryId: entryBase.id, source: cfg.source, results, usage: out.usage || null, resultChars: bodyStr.length, estTokens: Math.round(tokenEstimate(bodyStr)) });
  return body;
}

// 返回体组装 + 自截（RESULT_CAPS 语义：超限先截 snippet 再减条目，自带提示绝不静默截断）
const BODY_BUDGET = 11500; // 预留给 loop 侧 jstr 引号/转义余量（cap 12000）
function buildBody({ ok, source, query, results, usage, cachedRef }, track) {
  const note = `本条 ${track === 'autonomous' ? '自主轨' : '指定轨'} · 源 ${source} · ${results.length} 条` + (cachedRef ? ` · 冷却命中（ref ${cachedRef}，未重复请求）` : '');
  let body = { ok, source, query, results, usage: usage || null, ...(cachedRef ? { cachedRef } : {}), note };
  let s = JSON.stringify(body);
  if (s.length <= BODY_BUDGET) return body;
  // 第一轮：逐条把 snippet 砍半
  const shrink = (snipLen) => {
    body = { ...body, results: body.results.map(r => ({ ...r, snippet: r.snippet.slice(0, snipLen) })) };
    return JSON.stringify(body).length;
  };
  for (const half of [240, 120, 60, 0]) {
    if (shrink(half) <= BODY_BUDGET) return body;
  }
  // 第二轮：从末尾减条目，至少留 1 条
  while (body.results.length > 1) {
    body.results = body.results.slice(0, body.results.length - 1);
    if (JSON.stringify(body).length <= BODY_BUDGET - 60) break;
  }
  body.note = note + '｜【结果过长已截断，如需更多请缩小查询词或减少 maxResults 后重查】';
  return body;
}

// ---------- 设置页测试连接（search:test，仿 llm:test） ----------
async function testConnection({ source, endpoint, key } = {}) {
  const cfg = getSearchConfig();
  const src = source || cfg.source;
  const ep = endpoint != null ? endpoint : cfg.endpoint;
  const k = key != null ? key : cfg.key;
  const t0 = Date.now();
  if (!src) return { ok: false, error: '请先选择搜索源供应商' };
  const p = PROVIDERS[src];
  if (!p) return { ok: false, error: '未知供应商：' + src };
  if (p.needsKey && !k) return { ok: false, error: '该供应商需要 API Key' };
  if (p.needsEndpoint && !ep) return { ok: false, error: 'SearXNG 需要填写实例地址' };
  try {
    const out = await p.searchOnce({ query: 'connectivity test', maxResults: 3, timeoutMs: 15000, key: k, endpoint: ep });
    return { ok: true, latencyMs: Date.now() - t0, results: (out.results || []).length, source: src };
  } catch (e) {
    return { ok: false, error: e.userMsg || e.message };
  }
}

// 测试钩子：清内存态（冷却缓存/日限提示标记）
function _resetState() { cooldownCache.clear(); limitNotifiedDay = ''; }

module.exports = { execute, saveKey, testConnection, listProviders, getSearchConfig, _resetState, PROVIDERS };
