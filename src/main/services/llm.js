// OpenAI 兼容 LLM 客户端：fetch + SSE 手动解析 + AbortController；safeStorage 加密 API key
const { safeStorage } = require('electron');
const store = require('./store');
const logger = require('../logger');

const active = new Map(); // reqId -> AbortController
let reqSeq = 0;
function newReqId(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + (++reqSeq); }

function getConfig() {
  const api = store.get('api');
  let apiKey = '';
  if (api.apiKeyEnc) {
    try {
      const buf = Buffer.from(api.apiKeyEnc, 'base64');
      apiKey = safeStorage.decryptString(buf);
    } catch (_) { apiKey = ''; }
  }
  return { endpoint: api.endpoint, model: api.model, apiKey, params: api.params || {} };
}

// 端点归一化：允许填 base 地址（如 https://api.deepseek.com）或完整 chat/completions 地址
// 已含 /chat/completions 的地址原样保留（含 query，如 Azure api-version）
function normalizeEndpoint(ep) {
  let s = String(ep || '').trim();
  if (!s) return '';
  const m = s.match(/^([^?#]*)([?#].*)?$/);
  const base = (m[1] || '').replace(/\/+$/, '');
  const tail = m[2] || '';
  if (/\/chat\/completions$/i.test(base)) return base + tail;
  return base + '/chat/completions' + tail;
}

// 从 base 地址推导 OpenAI 兼容的 GET /models 地址
function modelsUrlOf(ep) {
  const m = String(ep || '').trim().match(/^([^?#]*)/);
  const base = (m[1] || '').replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return base + '/models';
}

function assertConfigured() {
  const c = getConfig();
  if (!c.endpoint || !c.model || !c.apiKey) {
    const e = new Error('还没有配置 API，请到 设置→API 填写');
    e.userMsg = '还没有配置 API，请到 设置→API 填写';
    throw e;
  }
  return c;
}

function saveKey(key) {
  let enc = '';
  try {
    if (key) enc = safeStorage.encryptString(key).toString('base64');
  } catch (e) { logger.warn('safeStorage 加密失败: ' + e.message); }
  store.set('api', { apiKeyEnc: enc });
}

function httpErrorMessage(status, bodyText) {
  if (status === 401) return 'API Key 无效或没有权限';
  if (status === 404) return '接口地址不存在（检查 endpoint 是否正确）';
  if (status === 429) return '调用频率/额度超限，请稍后再试';
  let detail = '';
  try { const j = JSON.parse(bodyText); detail = (j.error && (j.error.message || j.error.code)) || ''; } catch (_) { detail = bodyText && bodyText.slice(0, 120); }
  return `接口返回 ${status}${detail ? '：' + detail : ''}`;
}

// SSE 流式：onChunk(delta, fullSoFar) → 返回完整文本
async function streamChat({ messages, onChunk, overrides = {}, reqId = newReqId('req') }) {
  const c = assertConfigured();
  const controller = new AbortController();
  active.set(reqId, controller);
  const p = c.params;
  const body = {
    model: c.model,
    messages,
    temperature: p.temperature ?? 0.8,
    max_tokens: p.maxTokens ?? 2048,
    top_p: p.topP ?? 0.9,
    frequency_penalty: p.frequencyPenalty ?? 0,
    presence_penalty: p.presencePenalty ?? 0,
    stream: true,
    ...overrides,
  };
  try {
    const res = await fetch(normalizeEndpoint(c.endpoint), {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw friendlyError(httpErrorMessage(res.status, t));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '', full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 残包回填
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (delta) { full += delta; if (onChunk) onChunk(delta, full); }
        } catch (_) { /* 跳过不完整行 */ }
      }
    }
    return full;
  } finally {
    active.delete(reqId);
  }
}

// deepseek 系模型（如 deepseek-flash）默认可能开启思考模式：
// 思考 token 计入 max_tokens，会把大纲/剧本这类 JSON 输出挤截断 → 解析失败。
// 工具类补全不需要推理，对 deepseek 显式关闭；其他服务商不支持该参数则不加，避免 400。
function isDeepseek(model) { return /deepseek/i.test(String(model || '')); }

// 非流式：记忆提取 / 日程解析 / 大纲等内部任务
async function genericCompletion(messages, { temperature = 0.3, maxTokens = 1024 } = {}) {
  const c = assertConfigured();
  const body = { model: c.model, messages, temperature, max_tokens: maxTokens, stream: false };
  if (isDeepseek(c.model)) body.thinking = { type: 'disabled' };
  const res = await fetch(normalizeEndpoint(c.endpoint), {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw friendlyError(httpErrorMessage(res.status, t));
  }
  const j = await res.json();
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  // 思考型模型可能把内容放在 reasoning_content（content 被截断为空时兜底）
  return String(msg.content || '') || String(msg.reasoning_content || '');
}

// 拉取 OpenAI 兼容模型列表（GET {base}/models），供设置页下拉选择
// endpoint/key 可传设置页当前表单值（key 未保存时也能查询）
async function listModels({ endpoint, key } = {}) {
  const cfg = getConfig();
  const ep = (endpoint || cfg.endpoint || '').trim();
  if (!ep) throw friendlyError('请先填写接口地址');
  const apiKey = String(key || cfg.apiKey || '').trim();
  if (!apiKey) throw friendlyError('请先填写 API Key');
  let res;
  try {
    res = await fetch(modelsUrlOf(ep), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw friendlyError('无法连接接口地址：' + e.message);
  }
  if (!res.ok) throw friendlyError(httpErrorMessage(res.status, await res.text().catch(() => '')));
  const j = await res.json();
  const ids = ((j && (j.data || j.models)) || [])
    .map(m => (typeof m === 'string' ? m : m && (m.id || m.name)))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return { models: ids };
}

async function testConnection() {
  const t0 = Date.now();
  try {
    assertConfigured();
    await genericCompletion([{ role: 'user', content: '你好' }], { maxTokens: 8, temperature: 0 });
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e.userMsg || e.message };
  }
}

function stop(reqId) {
  const ctrl = active.get(reqId);
  if (ctrl) ctrl.abort();
}

function friendlyError(msg) {
  const e = new Error(msg);
  e.userMsg = msg;
  return e;
}

module.exports = { streamChat, genericCompletion, testConnection, listModels, stop, newReqId, getConfig, saveKey, assertConfigured, normalizeEndpoint };
