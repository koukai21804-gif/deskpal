// OpenCode：~/.local/share/opencode/（所有平台走 XDG 约定，Windows 也是 <home>\.local\share\opencode）
// opencode*.db：session(id,title,directory,time_created,time_updated) + message(session_id,time_created,data JSON)
// data.tokens {input,output,reasoning,cache:{read,write}}、data.cost（本地有成本）。
// 注意官方 tokens.total 多算了 reasoning——不用 total，用分量。
const path = require('path');
const fs = require('fs');
const sqlite = require('../sqlite');
const { anyToMs, isNum } = require('../util');

module.exports = {
  id: 'opencode',
  name: 'OpenCode',
  dataDirs: (home) => [path.join(home, '.local', 'share', 'opencode')],
  scan(ctx) {
    const root = this.dataDirs(ctx.home)[0];
    if (!fs.existsSync(root)) return { status: 'missing', sessions: [] };
    const sessions = [];
    let sawDb = false;
    if (sqlite.available()) {
      let dbs;
      try { dbs = fs.readdirSync(root).filter(f => /^opencode.*\.db$/.test(f)); } catch (_) { dbs = []; }
      for (const dbFile of dbs) {
        const handle = sqlite.open(path.join(root, dbFile));
        if (!handle) continue;
        sawDb = true;
        try {
          const meta = new Map();
          for (const r of sqlite.query(handle, 'SELECT id, title, directory FROM session', { maxRows: 20000 })) {
            meta.set(String(r[0]), { title: r[1] ? String(r[1]) : '', directory: r[2] ? String(r[2]) : '' });
          }
          const perSession = new Map();
          for (const r of sqlite.query(handle, 'SELECT session_id, time_created, data FROM message', { maxRows: 200000 })) {
            const sid = String(r[0]);
            let data = r[2];
            if (Buffer.isBuffer(data)) { try { data = JSON.parse(data.toString('utf8')); } catch (_) { continue; } }
            else if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { continue; } }
            if (!data || typeof data !== 'object') continue;
            const tk = data.tokens;
            if (!tk || typeof tk !== 'object') continue;
            const input = isNum(tk.input) ? +tk.input : 0;
            const output = isNum(tk.output) ? +tk.output : 0;
            if (!input && !output) continue;
            let ts = anyToMs(r[1]);
            if (!ts && data.time && data.time.created) ts = anyToMs(data.time.created);
            const cacheRead = tk.cache && isNum(tk.cache.read) ? +tk.cache.read : 0;
            const cacheWrite = tk.cache && isNum(tk.cache.write) ? +tk.cache.write : 0;
            if (!perSession.has(sid)) {
              const m = meta.get(sid) || {};
              perSession.set(sid, {
                tool: this.id, sessionId: sid, title: m.title || '', project: m.directory || '',
                firstAt: 0, lastAt: 0, events: [], costUsd: 0,
              });
            }
            const s = perSession.get(sid);
            s.events.push({
              ts, model: data.model ? String(data.model) : (data.provider ? String(data.provider) : null),
              input, output, cacheRead, cacheWrite,
              reasoning: isNum(tk.reasoning) ? +tk.reasoning : 0, requests: 1,
            });
            if (isNum(data.cost)) s.costUsd = (s.costUsd || 0) + +data.cost;
            if (ts) { s.firstAt = s.firstAt || ts; if (ts > s.lastAt) s.lastAt = ts; }
          }
          for (const s of perSession.values()) if (s.events.length) sessions.push(s);
        } finally { sqlite.close(handle); }
      }
    }
    if (sessions.length) return { status: 'ok', sessions };
    return {
      status: sawDb ? 'empty' : 'meta',
      statusNote: sawDb ? undefined : '检测到 OpenCode 目录，但未找到 opencode.db（旧版 storage 格式未适配）',
      sessions: [],
    };
  },
};
