// token 看板公共工具：文件遍历 / JSONL 逐行 / 数值清洗 / 宽松用量识别 / 目录名解码
// 全部纯 Node（无 electron 依赖），providers 与聚合层共用。
const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 64 * 1024 * 1024; // 单文件超 64MB 跳过（防异常巨型 transcript 拖死扫描）

function isNum(v) { return Number.isFinite(+v) && +v >= 0; }
function num(v) { return isNum(v) ? +v : 0; }
function numOrNull(v) { return isNum(v) ? +v : null; }
// 秒/毫秒 epoch 自适应 → 毫秒
function toMs(v) {
  const n = +v;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}
// 时间字段（ISO 字符串 / epoch）→ 毫秒
function anyToMs(v) {
  if (v == null) return 0;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : toMs(Number(v));
  }
  return toMs(v);
}

// 递归收集文件（带上限与跳过规则）；返回 [{file, size, mtimeMs}]
function walkFiles(root, { maxFiles = 5000, maxDepth = 8, filter } = {}) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < maxFiles) {
    const { dir, depth } = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth + 1 > maxDepth) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile()) {
        if (filter && !filter(full)) continue;
        try {
          const st = fs.statSync(full);
          if (st.size > MAX_FILE_BYTES) continue;
          out.push({ file: full, size: st.size, mtimeMs: st.mtimeMs });
        } catch (_) {}
      }
    }
  }
  return out;
}

// 逐行读 JSONL：容忍坏行/半行（返回 {obj, raw} 中的 obj 可能为 null）
function* jsonlLines(buffer) {
  let start = 0;
  const s = buffer;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      const line = s.slice(start, i).trim();
      if (line) { try { yield JSON.parse(line); } catch (_) {} }
      start = i + 1;
    }
  }
  const tail = s.slice(start).trim();
  if (tail) { try { yield JSON.parse(tail); } catch (_) {} }
}

// 文件身份指纹（内存级增量：文件没变就不重解析）
function fileKey(rec) { return rec.file + '::' + rec.size + '::' + Math.round(rec.mtimeMs); }

// Claude 系目录名解码：'D--CC-project-deskpal' → 'D:\CC\project\deskpal'（尽力还原，原名含 '-' 时有歧义）
function decodeSlashedDir(name) {
  let s = String(name || '').replace(/^-+|-+$/g, ''); // DSH 会把整段 cwd 首尾各多压出 '-'（如 '--D-app--'）
  const m = /^([A-Za-z])-+(.*)$/.exec(s);
  if (!m) return s;
  let rest = m[2];
  const drive = m[1].toUpperCase() + ':\\';
  if (/^-/.test(rest)) rest = rest.slice(1); // 原路径里 ':' 与 '\' 双双被压成 '--'
  return drive + rest.replace(/-+/g, '\\');
}

// Claude 系 unc 路径（UNC 目录名以 //- 开头）
function decodeProjectDir(name) {
  const s = String(name || '');
  if (s.startsWith('//')) return '\\\\' + s.slice(2).replace(/-+/g, '\\');
  return decodeSlashedDir(s);
}

// 宽松用量行识别（用于格式未公开的工具：OpenClaw / Antigravity / Hermes 等兜底扫描）：
// 判据与 token-monitor 的 looksLikeUsageRow 同思路——有 token 样数字段且带模型/会话/时间之一。
const TOKEN_FIELD_ALIAS = [
  ['input', ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'input_token_count']],
  ['output', ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'output_token_count']],
  ['cacheRead', ['cache_read_input_tokens', 'cacheReadTokens', 'cached_tokens', 'cachedTokens', 'cache_read', 'cacheRead', 'prompt_cache_hit_tokens']],
  ['cacheWrite', ['cache_creation_input_tokens', 'cacheWriteTokens', 'cache_creation', 'cacheWrite', 'cache_write_input_tokens']],
  ['reasoning', ['reasoning_tokens', 'reasoningTokens', 'thinking_tokens', 'thinkingTokens']],
];
function looseUsage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let found = 0;
  for (const [key, aliases] of TOKEN_FIELD_ALIAS) {
    for (const a of aliases) {
      if (obj[a] != null && isNum(obj[a])) { out[key] = +obj[a]; found++; break; }
    }
  }
  if (!found) return null;
  const total = out.input + out.output + out.cacheRead + out.cacheWrite;
  if (total <= 0) return null;
  return out;
}
function looseModel(obj) {
  return obj.model || obj.modelId || obj.model_id || obj.modelName || obj.model_name || null;
}
function looseTs(obj) {
  return anyToMs(obj.timestamp || obj.ts || obj.time || obj.createdAt || obj.created_at || obj.time_created);
}
function looseSessionId(obj) {
  return obj.sessionId || obj.session_id || obj.conversationId || obj.conversation_id || obj.threadId || obj.thread_id || null;
}

// 会话累加器：providers 共用的聚合小对象
function newAcc() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 }; }
function accAdd(acc, ev) {
  acc.input += ev.input || 0; acc.output += ev.output || 0;
  acc.cacheRead += ev.cacheRead || 0; acc.cacheWrite += ev.cacheWrite || 0;
  acc.reasoning += ev.reasoning || 0;
  acc.requests += ev.requests == null ? 1 : ev.requests;
}
function accTotal(a) { return a.input + a.output + a.cacheRead + a.cacheWrite; }

module.exports = {
  MAX_FILE_BYTES, isNum, num, numOrNull, toMs, anyToMs,
  walkFiles, jsonlLines, fileKey, decodeProjectDir, decodeSlashedDir,
  looseUsage, looseModel, looseTs, looseSessionId,
  newAcc, accAdd, accTotal,
};
