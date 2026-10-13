// Claude 系 transcript JSONL 读取器（Claude Code / Qoder CN / WorkBuddy 共用格式族）：
// 每行一个 JSON 记录；用量信封挂在 .message.usage（Claude snake_case 语义），ai-title/custom-title 携带标题。
// 旧版（Claude Code / Qoder）：type=assistant 行携带 message.usage；
// 新版（WorkBuddy 5.5+）：type=function_call 行携带 message.usage（信封 id/model 为空，
// 真实模型与唯一消息键在 .providerData），type=message 行仅有 providerData.usage（camelCase）。
// 同一行上 message.usage 与 providerData.usage 是同一次请求的两种表示，只计一次。
// 语义差异经 opts 控制：
//   inputIncludesCache: Qoder 的 input_tokens 已含 cache_read（需减出未缓存部分）
//   skipPlanBilled:     Qoder 第一方 plan-billed 行（token 全 0 但带 credits/context_usage_ratio）跳过
const { jsonlLines, anyToMs, isNum } = require('./util');

// 明细字段求和（如 inputTokensDetails[].cached_tokens）：兼容数组/对象两种形态
function detailSum(v, key) {
  const arr = Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : []);
  let s = 0;
  for (const d of arr) if (d && isNum(d[key])) s += +d[key];
  return s;
}

// 从任意行型提取用量：优先 message.usage（snake_case），缺失时映射 providerData.usage（camelCase）。
// 返回 null 表示该行无可用用量（input/output 均无数值）。
function usageOf(rec) {
  const msg = rec.message && typeof rec.message === 'object' ? rec.message : null;
  const pd = rec.providerData && typeof rec.providerData === 'object' ? rec.providerData : null;
  let u, camel = false;
  if (msg && msg.usage && typeof msg.usage === 'object') u = msg.usage;
  else if (pd && pd.usage && typeof pd.usage === 'object') { u = pd.usage; camel = true; }
  else return null;
  let input, output, cacheRead, cacheWrite, reasoning;
  if (camel) { // OpenAI 风格 camelCase → Claude 语义四项（无缓存写字段）
    input = isNum(u.inputTokens) ? +u.inputTokens : null;
    output = isNum(u.outputTokens) ? +u.outputTokens : null;
    cacheRead = detailSum(u.inputTokensDetails, 'cached_tokens');
    cacheWrite = 0;
    reasoning = detailSum(u.outputTokensDetails, 'reasoning_tokens');
  } else {
    input = isNum(u.input_tokens) ? +u.input_tokens : null;
    output = isNum(u.output_tokens) ? +u.output_tokens : null;
    cacheRead = isNum(u.cache_read_input_tokens) ? +u.cache_read_input_tokens : 0;
    cacheWrite = isNum(u.cache_creation_input_tokens) ? +u.cache_creation_input_tokens : 0;
    const think = u.output_tokens_details && u.output_tokens_details.thinking_tokens;
    reasoning = isNum(think) ? +think : 0;
  }
  if (input == null && output == null) return null; // 无用量（记录不完整）
  return { u, input, output, cacheRead, cacheWrite, reasoning };
}

// 解析单个 transcript 文件 → { sessionId, title, project, firstAt, lastAt, events[] }
// events: [{ts, model, input, output, cacheRead, cacheWrite, reasoning, requests:1}]
function parseClaudeTranscript(text, { fileKey = '', inputIncludesCache = false, skipPlanBilled = false } = {}) {
  let sessionId = '', title = '', project = '';
  let firstAt = 0, lastAt = 0;
  const byKey = new Map(); // 去重键 → event（同键再次落盘=用量更新，保留最后一次、ts 取较新）
  for (const rec of jsonlLines(text)) {
    if (!rec || typeof rec !== 'object') continue;
    const ts = anyToMs(rec.timestamp);
    if (ts) { firstAt = firstAt || ts; if (ts > lastAt) lastAt = ts; }
    if (rec.type === 'ai-title' || rec.type === 'custom-title') {
      const t = rec.title || (rec.data && rec.data.title) || (rec.value && (typeof rec.value === 'string' ? rec.value : rec.value.title));
      if (t) title = String(t);
      continue;
    }
    if (!sessionId && rec.sessionId) sessionId = String(rec.sessionId);
    else if (!sessionId && rec.session_id) sessionId = String(rec.session_id);
    if (!project && rec.cwd) project = String(rec.cwd);
    const got = usageOf(rec); // 任意行型：只要带用量信封就采集（旧 assistant 行 / 新 function_call、message 行）
    if (!got) continue;
    let { input, output, cacheRead, cacheWrite, reasoning } = got;
    if (skipPlanBilled && !(input > 0) && !(output > 0) && (got.u.credits != null || got.u.context_usage_ratio != null)) continue;
    if (inputIncludesCache && input != null) input = Math.max(0, input - cacheRead);
    const msg = rec.message && typeof rec.message === 'object' ? rec.message : null;
    const pd = rec.providerData && typeof rec.providerData === 'object' ? rec.providerData : null;
    const ev = {
      ts: ts || lastAt,
      model: (msg && msg.model ? String(msg.model) : null) || (pd && pd.model ? String(pd.model) : null),
      input: input || 0,
      output: output || 0,
      cacheRead,
      cacheWrite,
      reasoning,
      requests: 1,
    };
    // 去重键链（防 writer 重放 / resume 更新重复计数）：信封 message.id → providerData.messageId
    // （新版唯一消息键）→ 行 rec.id → 旧版 uuid 兜底 → 内容签名（无任何 id 时防整行重放）
    const key = (msg && msg.id && String(msg.id))
      || (pd && pd.messageId && String(pd.messageId))
      || (rec.id != null && rec.id !== '' && String(rec.id))
      || (rec.uuid && 'u:' + rec.uuid)
      || ('sig:' + [ev.model, input, output, cacheRead, cacheWrite, reasoning, ev.ts].join('|'));
    const prev = byKey.get(key);
    if (prev) byKey.set(key, { ...prev, ...ev, ts: Math.max(prev.ts, ev.ts) });
    else byKey.set(key, ev);
  }
  const events = [...byKey.values()].sort((a, b) => a.ts - b.ts);
  if (!sessionId && fileKey) sessionId = fileKey;
  return { sessionId, title, project, firstAt, lastAt, events };
}

module.exports = { parseClaudeTranscript };
