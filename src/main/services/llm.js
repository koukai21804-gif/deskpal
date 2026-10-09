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

// ---- 上下文溢出识别（P0-4，借鉴 Cortico transport/errors.ts isContextOverflow）----
// 同时覆盖三家真实文案：OpenAI context_length_exceeded / DeepSeek maximum context
// length / llama-server exceeds the available context size。命中后带 contextOverflow
// 标记上抛，调用方据此「压缩续跑」而非当普通错误死亡。
function isContextOverflow(status, bodyText) {
  if (![0, 400, 413].includes(status)) return false;
  const t = String(bodyText || '');
  return /context[_\s-]?length[_\s-]?exceeded|maximum\s+context\s+length|exceeds?\s+the\s+available\s+context\s+size|context\s+window\s+is\s+too\s+(small|large)|too\s+many\s+(input\s+)?tokens/i.test(t);
}
function contextOverflowError() {
  const e = friendlyError('对话长度超出模型的上下文窗口，将自动压缩后继续');
  e.contextOverflow = true;
  return e;
}
function httpError(status, bodyText) {
  if (isContextOverflow(status, bodyText)) return contextOverflowError();
  return friendlyError(httpErrorMessage(status, bodyText));
}

// ---- 流式健壮性（P0-3，借鉴 Cortico response-http.ts 的三层空闲 + 失控熔断）----
// 三层空闲：首响应超时（迟迟等不到首字节）/ 帧空闲（连接活着但持续无任何字节）/
// 内容空闲（有字节但没有新内容事件——keepalive 与空 delta 不重置内容层计时，
// 专治「连接活着一直发空帧」）。阈值取 Cortico 同款量级：实测 DeepSeek 思考模式
// 重上下文请求的首字节可迟至 2 分钟+（20261002 run_mupxfru8_1：120s 阈值两次掐断
// 正常请求致续跑链 400），首响应给 300s、帧间 120s、内容间 300s。
const STREAM_LIMITS = { firstResponseMs: 300000, frameIdleMs: 120000, contentIdleMs: 300000 };
// 失控熔断：累计接收字符 > max_tokens × 12（字符/token 上界启发式）→ 中止，
// 防模型陷入重复循环无限吐字
const RUNAWAY_FACTOR = 12;

// 看门狗：定时比对最近活动时间戳，超阈值经 onTrip(layer, userMsg) 上报并自停。
// 导出供单测（真实计时器、小阈值验证分层触发）。
function createStreamWatchdog({ limits, onTrip, intervalMs = 5000 }) {
  const st = { lastFrameAt: Date.now(), lastContentAt: Date.now() };
  let timer = null;
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function check() {
    const now = Date.now();
    if (now - st.lastFrameAt >= limits.frameIdleMs) {
      stop(); onTrip('frame', `网络空闲超时：${Math.round((now - st.lastFrameAt) / 1000)} 秒没有收到任何数据`);
    } else if (now - st.lastContentAt >= limits.contentIdleMs) {
      stop(); onTrip('content', `内容空闲超时：连接保持但 ${Math.round((now - st.lastContentAt) / 1000)} 秒没有新内容（思考/正文/工具参数）`);
    }
  }
  return {
    start() { if (!timer) { timer = setInterval(check, intervalMs); if (timer.unref) timer.unref(); } },
    stop,
    frameActivity() { st.lastFrameAt = Date.now(); },
    contentActivity() { st.lastFrameAt = Date.now(); st.lastContentAt = Date.now(); },
  };
}

// SSE 流式：onChunk(delta, fullSoFar) → 返回完整文本
// opts.withTools：附 OpenAI tools + tool_choice（Agent 决策轮）。返回 {content, toolCalls, finishReason, reasoning, streamCut, committed}
// 而非字符串（不带 withTools 的旧调用方零改动）。
// opts.onReasoning(delta)：思考内容增量回调（不上屏，供调用方做「思考中」反馈）
// opts.onUsage(usage)：上游自报用量回调（prompt_tokens 等，锚点法计量据此落锚，P0-2）。
//   DeepSeek 在最后一个 chunk 附 usage；OpenAI 系需 stream_options 才发——为兼容杂牌
//   网关不主动携带该参数，有则用、无则不落锚。
async function streamChat({ messages, onChunk, overrides = {}, reqId = newReqId('req'), withTools = false, onReasoning = null, onUsage = null }) {
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
  if (withTools) {
    body.tools = overrides.tools;
    body.tool_choice = 'auto';
  }
  // deepseek 思考模式（用户决策 v0.3.7：全程开启以保证回复质量）：显式开启。
  // 思考原文经 reasoning_content 流式返回并回传（v0.3.6 修复保证多轮工具循环兼容）；
  // 思考期间不上屏，调用方可经 onReasoning 做「思考中」反馈。仅 deepseek 系携带该参数。
  if (isDeepseek(c.model)) body.thinking = { type: 'enabled' };
  // 工具调用增量累计：index -> {id, name, args}（arguments 字符串跨 chunk 拼接）
  const toolAcc = [];
  let finishReason = null;
  // 传输层状态（P0-3）：committed=正文 delta 已外化（onChunk 已推给用户）；
  // 此后任何失败都不再自动重试——重试会让用户看到重复的半截输出
  let committed = false;
  let emittedChars = 0;
  const maxTok = Number(body.max_tokens) || 2048;
  const tripState = { layer: null, userMsg: null };
  const trip = (layer, userMsg) => {
    if (tripState.layer) return;
    tripState.layer = layer; tripState.userMsg = userMsg;
    try { controller.abort(); } catch (_) {}
  };
  const absorb = (s) => { // 失控熔断口径：接收字符总量（正文+思考+工具参数）
    emittedChars += String(s || '').length;
    if (emittedChars > maxTok * RUNAWAY_FACTOR) {
      trip('runaway', '模型输出超出安全上限，已中止（疑似失控重复）');
    }
  };
  // 首响应超时：迟迟等不到响应头即掐断（fetch 本身无超时）
  const firstTimer = setTimeout(() => trip('first', `等待响应超时（${STREAM_LIMITS.firstResponseMs / 1000} 秒未收到服务端响应）`), STREAM_LIMITS.firstResponseMs);
  if (firstTimer.unref) firstTimer.unref();
  let headersAt = null;
  let res;
  try {
    res = await fetch(normalizeEndpoint(c.endpoint), {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    // 首响应超时（firstTimer 经 trip 中止 fetch）→ 转友好错误；用户主动停止 → 原样上抛
    if (e.name === 'AbortError' && tripState.layer) throw friendlyError(tripState.userMsg || '连接超时');
    throw e;
  }
  headersAt = Date.now();
  try {
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      // 兼容降级：部分网关不支持 stream+tools（400）→ 记标记，此后决策轮走非流式。
      // 例外（不误标 toolsStreamBroken，直接把接口原始报错抛给用户）：
      // ① max_tokens 超上限——与流式工具无关；② thinking 模式要求回传 reasoning_content——
      // 是会话内容问题（loop 已改为回传）；③ 上下文溢出——是容量问题（P0-4 走压缩续跑），
      // 标记只会让此后所有决策轮白白降级非流式。
      if (withTools && res.status === 400
        && !/max[_\s-]?tokens|maximum.{0,20}tokens|too large/i.test(t)
        && !/reasoning_content|thinking/i.test(t)
        && !isContextOverflow(res.status, t)) {
        store.set('api', { toolsStreamBroken: true });
        const e = friendlyError('当前接口不支持流式工具调用，已自动切换为非流式决策轮');
        e.toolsStreamBroken = true;
        throw e;
      }
      throw httpError(res.status, t);
    }
    // 自愈：once stream+tools 成功，清掉历史误标的降级开关（如服务端故障期被误置）
    if (withTools && store.get('api').toolsStreamBroken) store.set('api', { toolsStreamBroken: false });
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '', full = '', reasoning = '';
    let sawDone = false;   // 是否收到 SSE 终止标记 [DONE]
    let usage = null;      // 上游自报用量（DeepSeek 末 chunk 附带）
    // 帧空闲 / 内容空闲双层看门狗（首响应超时由 firstTimer 单独守）
    const watchdog = createStreamWatchdog({ limits: STREAM_LIMITS, onTrip: trip });
    watchdog.start();
    const buildResult = (streamCut, extra = {}) => {
      const calls = toolAcc.filter(Boolean);
      return {
        content: full,
        toolCalls: calls.map(t => ({ id: t.id, name: t.name, argsRaw: t.args })),
        // 个别网关流末不带 finish_reason：按是否累计出工具调用推断
        finishReason: finishReason || (calls.length ? 'tool_calls' : 'stop'),
        reasoning,
        streamCut,
        committed,
        ...extra,
      };
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        watchdog.frameActivity();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 残包回填
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const data = s.slice(5).trim();
          if (data === '[DONE]') { sawDone = true; continue; }
          try {
            const j = JSON.parse(data);
            // usage 必须在 choice 判空前取：DeepSeek 的末 chunk choices 为空数组
            if (j && j.usage && Number.isFinite(+j.usage.prompt_tokens)) usage = j.usage;
            const choice = j.choices && j.choices[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta || {};
            // 思考模型的推理内容：不进正文流（不上屏），仅累计供多轮回传（DeepSeek 思考模式强制要求）
            if (delta.reasoning_content) {
              reasoning += delta.reasoning_content; absorb(delta.reasoning_content); watchdog.contentActivity();
              if (onReasoning) { try { onReasoning(delta.reasoning_content); } catch (_) {} }
            }
            if (delta.content) {
              full += delta.content; absorb(delta.content); watchdog.contentActivity();
              committed = true; // 正文已推给调用方（上屏）→ 之后失败不可自动重试
              if (onChunk) onChunk(delta.content, full);
            }
            if (withTools && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = Number.isFinite(tc.index) ? tc.index : 0;
                const slot = toolAcc[idx] || (toolAcc[idx] = { id: '', name: '', args: '' });
                if (tc.id) slot.id += tc.id;
                if (tc.function && tc.function.name) slot.name += tc.function.name;
                if (tc.function && tc.function.arguments) { slot.args += tc.function.arguments; absorb(tc.function.arguments); watchdog.contentActivity(); }
              }
            }
          } catch (_) { /* 跳过不完整行 */ }
        }
      }
    } catch (e) {
      // 读循环异常三分：用户主动停止（原样上抛）/ 看门狗熔断 / 网络中断。
      // 决策轮（withTools）返回半截 + streamCut + committed，由 loop 决定：
      // 未外化 → 有界续跑；已外化 → 如实收尾（不可重放已示人的半截）。
      if (e.name === 'AbortError' && !tripState.layer) throw e;
      const layer = tripState.layer || 'network';
      const msg = tripState.userMsg || `网络传输中断：${e.message || e.name}`;
      logger.warn(`[llm] 流式读取失败（${layer}），已收正文 ${full.length} 字符${committed ? '（已外化，不可自动重试）' : ''}`);
      if (!withTools) throw friendlyError(msg);
      return buildResult(true, { streamError: { layer, message: msg } });
    } finally {
      watchdog.stop();
    }
    if (usage && onUsage) { try { onUsage(usage); } catch (_) {} }
    if (!withTools) return full;
    // 流完整性：既没有 finish_reason 也没收到 [DONE] = 连接被提前掐断
    // （区别于「网关不发 finish_reason 但正常 [DONE]」的兼容情况）。实测表现：
    // 正文说到一半戛然而止，被当成完整回复交付，用户以为角色卡死。
    const streamCut = !sawDone && finishReason == null;
    if (streamCut) logger.warn(`[llm] 流式响应提前断开（无 finish_reason/[DONE]），已收内容 ${full.length} 字符`);
    return buildResult(streamCut);
  } finally {
    clearTimeout(firstTimer);
    active.delete(reqId);
  }
}

// deepseek 系模型（如 deepseek-flash）默认可能开启思考模式：
// 思考 token 计入 max_tokens，会把大纲/剧本这类 JSON 输出挤截断 → 解析失败。
// 工具类补全不需要推理，对 deepseek 显式关闭；其他服务商不支持该参数则不加，避免 400。
function isDeepseek(model) { return /deepseek/i.test(String(model || '')); }

// 非流式：记忆提取 / 日程解析 / 大纲等内部任务
// opts.tools：附工具定义（Agent 非流式决策轮），返回 {content, toolCalls, finishReason}
// opts.onUsage(usage)：上游自报用量回调（锚点法计量，P0-2）
async function genericCompletion(messages, { temperature = 0.3, maxTokens = 1024, tools = null, onUsage = null } = {}) {
  const c = assertConfigured();
  const body = { model: c.model, messages, temperature, max_tokens: maxTokens, stream: false };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  // 内部实用任务（记忆提取/日程解析/大纲等 JSON 输出）关思考：非角色对话，
  // 无质量收益且拖慢耗时（角色对话的思考开启见 streamChat，v0.3.7 用户决策）
  if (isDeepseek(c.model)) body.thinking = { type: 'disabled' };
  const res = await fetch(normalizeEndpoint(c.endpoint), {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw httpError(res.status, t);
  }
  const j = await res.json();
  if (j.usage && Number.isFinite(+j.usage.prompt_tokens) && onUsage) { try { onUsage(j.usage); } catch (_) {} }
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  // 思考型模型可能把内容放在 reasoning_content（content 被截断为空时兜底）
  const reasoningContent = String(msg.reasoning_content || '');
  const content = String(msg.content || '') || reasoningContent;
  if (!tools) return content;
  return {
    content,
    toolCalls: (msg.tool_calls || []).map(t => ({
      id: t.id, name: t.function && t.function.name, argsRaw: (t.function && t.function.arguments) || '',
    })),
    finishReason: (j.choices && j.choices[0] && j.choices[0].finish_reason) || 'stop',
    // 思考模式的推理原文：多轮工具循环必须原样回传（DeepSeek 思考模式强制要求），与流式分支对齐
    reasoning: reasoningContent,
  };
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

// stream+tools 是否已被 400 判定不可用（决策轮据此降级非流式）
function isToolsStreamBroken() { return !!store.get('api').toolsStreamBroken; }

module.exports = { streamChat, genericCompletion, testConnection, listModels, stop, newReqId, getConfig, saveKey, assertConfigured, normalizeEndpoint, isToolsStreamBroken, isDeepseek, isContextOverflow, createStreamWatchdog, STREAM_LIMITS, RUNAWAY_FACTOR };
