// DeepSeek Harness（DSH）：~/.dsh/sessions/<编码cwd>/<session-id>/session[.vN].jsonl[.zstd]
// 记录信封 {type, seq, time, data}；用量 data.usage.*（DeepSeek 口径：inputTokens 含缓存命中，
// 减出未缓存部分）；标题 data.title；模型 data.message.source.model。
// writer 会重放已 flush 的行：按 seq 去重，无 seq 再按内容签名。
const path = require('path');
const fs = require('fs');
const zstd = require('../zstd');
const { jsonlLines, anyToMs, isNum, decodeProjectDir } = require('../util');

function scanSessionDir(dir, sessionId, project) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(f)); } catch (_) { return null; }
  if (!files.length) return null;
  // 版本化文件是活文件，但旧版本文件里仍有历史用量——全读并按 seq/签名去重
  const events = new Map();
  let title = '', firstAt = 0, lastAt = 0;
  for (const f of files) {
    const text = zstd.readMaybeZstd(path.join(dir, f));
    if (!text) continue;
    for (const rec of jsonlLines(text)) {
      if (!rec || typeof rec !== 'object') continue;
      const data = rec.data;
      if (!data || typeof data !== 'object') continue;
      if ((rec.type === 'session' || rec.type === 'title') && data.title) { title = String(data.title); continue; }
      const u = data.usage;
      if (!u || typeof u !== 'object') continue;
      const input = isNum(u.inputTokens) ? +u.inputTokens : 0;
      const cacheRead = isNum(u.cacheReadTokens) ? +u.cacheReadTokens : 0;
      const output = isNum(u.outputTokens) ? +u.outputTokens : 0;
      if (!(input > 0) && !(output > 0) && !(cacheRead > 0)) continue;
      const ts = anyToMs(rec.time) || anyToMs(data.time);
      const model = data.message && data.message.source && data.message.source.model ? String(data.message.source.model) : null;
      const ev = {
        ts, model,
        input: Math.max(0, input - cacheRead), // DeepSeek 口径：inputTokens 含缓存命中
        output, cacheRead,
        cacheWrite: isNum(u.cacheWriteTokens) ? +u.cacheWriteTokens : 0,
        reasoning: isNum(u.reasoningTokens) ? +u.reasoningTokens : 0,
        requests: 1,
      };
      const sig = rec.seq != null ? 'q:' + rec.seq : 's:' + ts + ':' + input + ':' + output + ':' + cacheRead + ':' + (model || '');
      const prev = events.get(sig);
      if (!prev) events.set(sig, ev);
      if (ts) { firstAt = firstAt || ts; if (ts > lastAt) lastAt = ts; }
    }
  }
  if (!events.size) return null;
  return {
    tool: 'dsh', sessionId, title, project, firstAt, lastAt,
    events: [...events.values()].sort((a, b) => a.ts - b.ts),
  };
}

module.exports = {
  id: 'dsh',
  name: 'DeepSeek Harness',
  dataDirs: (home) => [path.join(home, '.dsh', 'sessions')],
  scan(ctx) {
    const root = this.dataDirs(ctx.home)[0];
    if (!fs.existsSync(root)) return { status: 'missing', sessions: [] };
    const sessions = [];
    const zstdNote = !zstd.available() ? '（未配置 zstd 解压组件，压缩会话无法读取明细）' : '';
    let anyZstd = false;
    for (const encCwd of fs.readdirSync(root, { withFileTypes: true })) {
      if (!encCwd.isDirectory()) continue;
      const project = decodeProjectDir(encCwd.name);
      const projDir = path.join(root, encCwd.name);
      for (const ent of fs.readdirSync(projDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || !ent.name.startsWith('session-')) continue;
        if (fs.readdirSync(path.join(projDir, ent.name)).some(f => f.endsWith('.zstd'))) anyZstd = true;
        const s = scanSessionDir(path.join(projDir, ent.name), ent.name, project);
        if (s && s.events.length) sessions.push(s);
      }
    }
    let note = '';
    if (anyZstd && !zstd.available()) note = zstdNote;
    return { status: sessions.length ? 'ok' : 'empty', statusNote: note || undefined, sessions };
  },
};
