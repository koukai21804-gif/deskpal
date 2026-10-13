// Qoder（CN）：~/.qoder-cn/projects/**/*.jsonl（旧名 ~/.qoder；legacy SQLite %APPDATA%\QoderCN 未适配）。
// Claude 兼容信封，两点语义差异：input_tokens 已含 cache_read（减出未缓存部分）；
// 第一方 plan-billed 行 token 全 0 只带 credits/context_usage_ratio（跳过，credits 属限额面）。
const path = require('path');
const fs = require('fs');
const { walkFiles, fileKey, decodeProjectDir } = require('../util');
const { parseClaudeTranscript } = require('../claude-jsonl');

module.exports = {
  id: 'qoder',
  name: 'Qoder',
  dataDirs: (home) => [path.join(home, '.qoder-cn', 'projects'), path.join(home, '.qoder', 'projects')],
  scan(ctx) {
    const dirs = this.dataDirs(ctx.home).filter(d => fs.existsSync(d));
    if (!dirs.length) return { status: 'missing', sessions: [] };
    const sessions = [];
    for (const root of dirs) {
      for (const rec of walkFiles(root, { filter: f => f.endsWith('.jsonl'), maxDepth: 6 })) {
        const key = fileKey(rec);
        let parsed = ctx.memo.get(key);
        if (!parsed) {
          let text = '';
          try { text = fs.readFileSync(rec.file, 'utf8'); } catch (_) { continue; }
          const sessionId = path.basename(rec.file).replace(/\.jsonl$/, '');
          parsed = parseClaudeTranscript(text, {
            fileKey: sessionId, inputIncludesCache: true, skipPlanBilled: true,
          });
          parsed.sessionId = parsed.sessionId || sessionId;
          if (!parsed.project) parsed.project = decodeProjectDir(path.basename(path.dirname(rec.file)));
          ctx.memo.set(key, parsed);
        }
        if (!parsed.events.length) continue;
        sessions.push({
          tool: this.id, sessionId: parsed.sessionId, title: parsed.title,
          project: parsed.project, firstAt: parsed.firstAt, lastAt: parsed.lastAt, events: parsed.events,
        });
      }
    }
    return { status: sessions.length ? 'ok' : 'empty', sessions };
  },
};
