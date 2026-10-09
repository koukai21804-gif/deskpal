// token 估算（全应用统一口径，spec D14）：CJK 字符 ×0.5 + 其他 ×0.25
// chat.js 上下文裁剪与 net-search 回填记账共用，改口径只改这里。
function tokenEstimate(text) {
  const t = String(text || '');
  const cjk = (t.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  return cjk * 0.5 + Math.max(0, t.length - cjk) * 0.25;
}

// ---- 锚点法计量（P0-2，借鉴 Cortico loop.ts estTokens 的锚点机制）----
// 纯估算的问题：误差随对话增长累积 → 过早/过晚裁剪。锚点法把「最近一次上游
// 成功请求的真实 prompt_tokens」钉在它覆盖的最后一条消息上：锚点之前的消息
// 用真实计数，其后新增的消息才用本地估算——估算漂移不再跨轮累积。
// 注：deskpal 思考模式全程开启且 toolTurns 原样回传 reasoning_content（v0.3.7
// 用户决策），聊天历史不存思考原文，故无 Cortico 的「关闭回传时扣减 reasoning」
// 分支；上游 prompt_tokens 已含系统提示（内嵌当前时间文本，分钟级漂移 ≤ 数十
// token，量级可忽略，锚点按消息 key 匹配、不校验系统提示指纹）。
function createAnchoredEstimator() {
  let anchor = null; // { key, promptTokens }：key = 锚定窗口末条消息的唯一键

  return {
    // 一次成功请求后落锚：messages 末条消息的 key + 上游自报 prompt_tokens
    setAnchor({ key, promptTokens } = {}) {
      anchor = (key && Number.isFinite(+promptTokens) && +promptTokens > 0)
        ? { key: String(key), promptTokens: +promptTokens }
        : null;
    },
    clearAnchor() { anchor = null; },
    hasAnchor() { return !!anchor; },
    // items: [{ key, content }]；systemContent：系统提示文本。
    // 锚点 key 命中 → 锚前真实计数（prompt_tokens 已含当时的 system）+ 锚后本地估算；
    // 未命中（历史裁剪把锚点裁掉了 / 尚无锚）→ system 估算 + 全量消息估算
    estimate(items, systemContent) {
      const list = Array.isArray(items) ? items : [];
      const ai = anchor ? list.findIndex(x => x && x.key === anchor.key) : -1;
      if (ai >= 0) {
        let tail = 0;
        for (let j = ai + 1; j < list.length; j++) tail += tokenEstimate(list[j].content);
        return anchor.promptTokens + tail;
      }
      let total = tokenEstimate(systemContent);
      for (const it of list) total += tokenEstimate(it.content);
      return total;
    },
  };
}

// ---- 用量归一化与逐轮聚合（外显「本轮 API 消耗」，20261002）----
// 归一口径：input=prompt_tokens；output=completion_tokens（含思考）；
// reasoning=completion_tokens_details.reasoning_tokens（思考 token，供应商不报则 null）；
// cacheHit=DeepSeek prompt_cache_hit_tokens 或 OpenAI prompt_tokens_details.cached_tokens。
// 缺维度保持 null（不造数，与锚点法同哲学）。
function normalizeUsage(raw) {
  const u = raw || {};
  const num = (v) => (Number.isFinite(+v) && +v >= 0 ? +v : null);
  return {
    input: num(u.prompt_tokens),
    output: num(u.completion_tokens),
    reasoning: num(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens),
    cacheHit: num(u.prompt_cache_hit_tokens) ?? num(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens),
  };
}

// 一次对话轮（可能含多次 LLM 请求）的用量聚合：逐次 add，snapshot 输出合计。
function createUsageMeter() {
  let sum = { input: null, output: null, reasoning: null, cacheHit: null };
  let requests = 0;
  const add = (acc, v) => (v == null ? acc : ((acc == null ? 0 : acc) + v));
  return {
    add(raw) {
      const u = normalizeUsage(raw);
      if (u.input == null && u.output == null) return; // 上游没报用量：不计数也不计次
      sum = {
        input: add(sum.input, u.input),
        output: add(sum.output, u.output),
        reasoning: add(sum.reasoning, u.reasoning),
        cacheHit: add(sum.cacheHit, u.cacheHit),
      };
      requests++;
    },
    snapshot() { return { ...sum, requests }; },
  };
}

module.exports = { tokenEstimate, createAnchoredEstimator, normalizeUsage, createUsageMeter };
