// Cursor：本地不落 token 明细（用量在账号云端）。
// 数据源：tokscale cursor-cache（~/.config/tokscale/cursor-cache/usage*.json，含 archive/）——
// 装了 token-monitor/tokscale 并同步过即可显示明细；否则退回 vscdb composerHeaders 的会话元信息
// （仅会话数/最近活跃，无 token），并在状态注记里说明。
const path = require('path');
const fs = require('fs');
const { walkFiles, anyToMs, isNum } = require('../util');
const sqlite = require('../sqlite');

function readCursorCache(home) {
  const root = path.join(home, '.config', 'tokscale', 'cursor-cache');
  if (!fs.existsSync(root)) return null;
  const files = walkFiles(root, { filter: f => /usage(\.[^/\\]+)?\.json$/.test(f), maxDepth: 3 });
  const sessions = new Map();
  let any = false;
  for (const f of files) {
    let doc; try { doc = JSON.parse(fs.readFileSync(f.file, 'utf8')); } catch (_) { continue; }
    const events = doc.usageEventsDisplay || doc.usageEvents || [];
    for (const e of events) {
      const tu = e.tokenUsage || {};
      const input = isNum(tu.inputTokens) ? +tu.inputTokens : 0;
      const output = isNum(tu.outputTokens) ? +tu.outputTokens : 0;
      const cacheRead = isNum(tu.cacheReadTokens) ? +tu.cacheReadTokens : 0;
      const cacheWrite = isNum(tu.cacheWriteTokens) ? +tu.cacheWriteTokens : 0;
      if (!input && !output && !cacheRead && !cacheWrite) continue;
      any = true;
      const sid = e.conversationId || 'cursor-' + String(e.accountId || '') + '-' + new Date(+e.timestamp || 0).toISOString().slice(0, 10);
      if (!sessions.has(sid)) sessions.set(sid, { tool: 'cursor', sessionId: String(sid), title: '', project: '', firstAt: 0, lastAt: 0, events: [] });
      const s = sessions.get(sid);
      const ts = +e.timestamp || 0;
      s.events.push({
        ts, model: e.model ? String(e.model) : null,
        input, output, cacheRead, cacheWrite, reasoning: 0, requests: 1,
      });
      if (ts) { s.firstAt = s.firstAt || ts; if (ts > s.lastAt) s.lastAt = ts; }
    }
  }
  return any ? [...sessions.values()] : null;
}

module.exports = {
  id: 'cursor',
  name: 'Cursor',
  dataDirs: (home) => [path.join(home, '.config', 'tokscale', 'cursor-cache')],
  scan(ctx) {
    // 1) tokscale 缓存（有 token 明细）
    const cached = readCursorCache(ctx.home);
    if (cached && cached.length) return { status: 'ok', sessions: cached };
    // 2) 元信息兜底：vscdb composerHeaders（仅会话数/最近活跃）
    const vscdb = path.join(ctx.home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    if (!fs.existsSync(vscdb)) return { status: 'missing', sessions: [] };
    if (!sqlite.available()) return { status: 'meta', statusNote: '检测到 Cursor；本地不含 token 明细（用量在账号云端），且无法读取 SQLite', meta: {} };
    const handle = sqlite.open(vscdb);
    if (!handle) return { status: 'meta', statusNote: '检测到 Cursor；本地不含 token 明细（用量在账号云端）', meta: {} };
    try {
      let n = 0, lastAt = 0;
      for (const r of sqlite.query(handle, 'SELECT lastUpdatedAt FROM composerHeaders', { maxRows: 20000 })) {
        n++;
        const v = +r[0];
        if (Number.isFinite(v) && v > 0) { const ms = v < 1e12 ? v * 1000 : v; if (ms > lastAt) lastAt = ms; }
      }
      return {
        status: 'meta',
        statusNote: `检测到 Cursor（${n} 个会话）；Cursor 的 token 用量只存账号云端，本地无法解析。装 token-monitor 并运行 tokscale cursor sync 后这里可显示明细`,
        meta: { sessions: n, lastAt },
        sessions: [],
      };
    } finally { sqlite.close(handle); }
  },
};
