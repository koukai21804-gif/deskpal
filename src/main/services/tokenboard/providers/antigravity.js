// Antigravity：~/.gemini/ 下 antigravity / antigravity-ide / antigravity-backup 三个原生根
// （IDE 扩展为 conversations/*.db 每会话一个 SQLite；CLI 为 antigravity-cli/conversations）。
// token 明细在 token-monitor 里也是靠 RPC 同步到独立缓存——本地 *.db 直接读以枚举与宽松扫描为主。
const path = require('path');
const fs = require('fs');
const { walkFiles, fileKey } = require('../util');
const sqlite = require('../sqlite');
const { parseLooseJsonl, looseSqliteScan } = require('../loose');

module.exports = {
  id: 'antigravity',
  name: 'Antigravity',
  dataDirs: (home) => [
    path.join(home, '.gemini', 'antigravity'),
    path.join(home, '.gemini', 'antigravity-ide'),
    path.join(home, '.gemini', 'antigravity-backup'),
    path.join(home, '.gemini', 'antigravity-cli'),
  ].filter(d => fs.existsSync(d)),
  scan(ctx) {
    const roots = this.dataDirs(ctx.home);
    if (!roots.length) return { status: 'missing', sessions: [] };
    const sessions = [];
    let sawData = false;
    for (const root of roots) {
      // CLI conversations（JSONL，宽松）
      for (const rec of walkFiles(path.join(root, 'conversations'), { filter: f => f.endsWith('.jsonl') || f.endsWith('.json'), maxDepth: 4 })) {
        const key = fileKey(rec);
        let parsed = ctx.memo.get(key);
        if (!parsed) {
          let text = '';
          try { text = fs.readFileSync(rec.file, 'utf8'); } catch (_) { continue; }
          parsed = [...parseLooseJsonl(text, { fallbackSessionId: path.basename(rec.file).replace(/\.(json|jsonl)$/, '') }).values()];
          ctx.memo.set(key, parsed);
        }
        for (const s of parsed) if (s.events.length) { sessions.push({ tool: this.id, ...s }); sawData = true; }
      }
      // IDE 每会话 *.db（SQLite，宽松）
      if (sqlite.available()) {
        for (const rec of walkFiles(root, { filter: f => f.endsWith('.db'), maxDepth: 4 })) {
          const handle = sqlite.open(rec.file);
          if (!handle) continue;
          try {
            for (const s of looseSqliteScan(handle, sqlite).values()) {
              if (s.events.length) { sessions.push({ tool: this.id, ...s }); sawData = true; }
            }
          } finally { sqlite.close(handle); }
        }
      }
    }
    if (sawData) return { status: 'ok', sessions };
    return { status: 'meta', statusNote: '检测到 Antigravity 数据目录；本地未识别出 token 用量（Antigravity 用量主要在 Google 账号侧）', sessions: [] };
  },
};
