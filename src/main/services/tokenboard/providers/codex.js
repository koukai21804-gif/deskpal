// Codex：~/.codex/{sessions,archived_sessions}/**/rollout-*.jsonl（rollout 记录 {timestamp,type,payload}）
// 用量在 payload.type=token_count 的 info.total_token_usage（会话累计）——按相邻记录差分还原每次增量；
// OpenAI 口径 inputTokens 含 cachedInputTokens → 减出未缓存部分。会话身份取首行 session_meta.id。
const path = require('path');
const fs = require('fs');
const { walkFiles, fileKey, jsonlLines, anyToMs, isNum } = require('../util');

function parseRollout(text, fallbackId) {
  let sessionId = fallbackId, model = null, title = '';
  let firstAt = 0, lastAt = 0;
  const deltas = [];
  let prevTotal = { input: 0, cached: 0, output: 0 }; // 基线 0：首条 token_count 即首个 turn 的增量
  for (const rec of jsonlLines(text)) {
    if (!rec || typeof rec !== 'object') continue;
    const ts = anyToMs(rec.timestamp);
    if (ts) { firstAt = firstAt || ts; if (ts > lastAt) lastAt = ts; }
    const p = rec.payload;
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'session_meta' && p.id) sessionId = String(p.id);
    if (p.type === 'turn_context' || p.type === 'session_meta') {
      if (!model && p.model) model = String(p.model);
    }
    if (!title && (p.title || p.name)) title = String(p.title || p.name);
    if (p.type === 'token_count' && p.info && typeof p.info === 'object') {
      const t = p.info.total_token_usage;
      if (t && typeof t === 'object') {
        const cur = {
          input: isNum(t.input_tokens) ? +t.input_tokens : 0,
          cached: isNum(t.cached_input_tokens) ? +t.cached_input_tokens : 0,
          output: isNum(t.output_tokens) ? +t.output_tokens : 0,
        };
        if (prevTotal) {
          const dIn = Math.max(0, cur.input - prevTotal.input);
          const dCached = Math.max(0, cur.cached - prevTotal.cached);
          const dOut = Math.max(0, cur.output - prevTotal.output);
          if (dIn > 0 || dOut > 0) {
            deltas.push({
              ts, model: model || (p.info.model ? String(p.info.model) : null),
              input: Math.max(0, dIn - dCached), output: dOut, cacheRead: dCached,
              cacheWrite: 0, reasoning: 0, requests: 1,
            });
          }
        }
        prevTotal = cur;
      }
    }
  }
  return { sessionId, model, title, firstAt, lastAt, events: deltas };
}

module.exports = {
  id: 'codex',
  name: 'Codex',
  dataDirs: (home) => [
    path.join(home, '.codex', 'sessions'),
    path.join(home, '.codex', 'archived_sessions'),
  ],
  scan(ctx) {
    const dirs = this.dataDirs(ctx.home).filter(d => fs.existsSync(d));
    if (!dirs.length) return { status: 'missing', sessions: [] };
    const sessions = [];
    for (const root of dirs) {
      for (const rec of walkFiles(root, { filter: f => path.basename(f).startsWith('rollout-') && f.endsWith('.jsonl'), maxDepth: 6 })) {
        const key = fileKey(rec);
        let parsed = ctx.memo.get(key);
        if (!parsed) {
          let text = '';
          try { text = fs.readFileSync(rec.file, 'utf8'); } catch (_) { continue; }
          parsed = parseRollout(text, path.basename(rec.file).replace(/\.jsonl$/, ''));
          ctx.memo.set(key, parsed);
        }
        if (!parsed.events.length) continue;
        sessions.push({
          tool: this.id, sessionId: parsed.sessionId, title: parsed.title,
          project: '', firstAt: parsed.firstAt, lastAt: parsed.lastAt, events: parsed.events,
        });
      }
    }
    return { status: sessions.length ? 'ok' : 'empty', sessions };
  },
};
