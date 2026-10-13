// WorkBuddy：~/.workbuddy/projects/**/*.jsonl（WorkBuddy 5.5+ 为 ~/.workbuddy-ai/projects）。
// 与 CodeBuddy 同族 transcript（Claude 兼容信封 + custom-title/ai-title 标题）。
const path = require('path');
const fs = require('fs');
const { walkFiles, fileKey, decodeProjectDir } = require('../util');
const { parseClaudeTranscript } = require('../claude-jsonl');

module.exports = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  dataDirs: (home) => [path.join(home, '.workbuddy', 'projects'), path.join(home, '.workbuddy-ai', 'projects')],
  scan(ctx) {
    const dirs = this.dataDirs(ctx.home).filter(d => fs.existsSync(d));
    if (!dirs.length) {
      // 数据目录不在标准位（如本机：仅工作区内 .workbuddy/memory）→ 报检测状态而非「未安装」
      const hint = [path.join(ctx.home, '.workbuddy'), path.join(ctx.home, '.workbuddy-ai')].some(d => fs.existsSync(d));
      return {
        status: hint ? 'empty' : 'missing',
        statusNote: hint ? '检测到 WorkBuddy，但没有 projects 会话记录（可能尚未产生 AI 对话）' : undefined,
        sessions: [],
      };
    }
    const sessions = [];
    for (const root of dirs) {
      for (const rec of walkFiles(root, { filter: f => f.endsWith('.jsonl'), maxDepth: 6 })) {
        const key = fileKey(rec);
        let parsed = ctx.memo.get(key);
        if (!parsed) {
          let text = '';
          try { text = fs.readFileSync(rec.file, 'utf8'); } catch (_) { continue; }
          const sessionId = path.basename(rec.file).replace(/\.jsonl$/, '');
          parsed = parseClaudeTranscript(text, { fileKey: sessionId });
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
