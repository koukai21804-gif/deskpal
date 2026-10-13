// ZCode：~/.zcode/cli/db/db.sqlite（turn_usage 每 turn 五项 token + model_usage 模型归属 + session 标题）
const path = require('path');
const fs = require('fs');
const sqlite = require('../sqlite');
const { toMs } = require('../util');

module.exports = {
  id: 'zcode',
  name: 'ZCode',
  dataDirs: (home) => [path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')],
  scan(ctx) {
    const file = this.dataDirs(ctx.home)[0];
    if (!fs.existsSync(file)) return { status: 'missing', sessions: [] };
    if (!sqlite.available()) return { status: 'error', statusNote: '系统缺少 SQLite 运行库（winsqlite3.dll），无法读取', sessions: [] };
    const handle = sqlite.open(file);
    if (!handle) return { status: 'error', statusNote: '数据库被占用且无法复制读取', sessions: [] };
    try {
      const sessions = new Map();
      for (const r of sqlite.query(handle, 'SELECT id, title, directory FROM session', { maxRows: 20000 })) {
        sessions.set(String(r[0]), {
          tool: this.id, sessionId: String(r[0]),
          title: (r[1] && String(r[1]).slice(0, 96)) || '',
          project: r[2] ? String(r[2]) : '',
          firstAt: 0, lastAt: 0, events: [],
        });
      }
      // 每 session 的模型请求分布（用于模型归属：token 只落在 turn 层，按请求数占比分摊）
      const modelReq = new Map(); // sid -> Map(model -> n)
      for (const r of sqlite.query(handle, 'SELECT session_id, model_id, COUNT(*) FROM model_usage GROUP BY session_id, model_id', { maxRows: 50000 })) {
        const sid = String(r[0]);
        if (!modelReq.has(sid)) modelReq.set(sid, new Map());
        modelReq.get(sid).set(String(r[1] || '未知'), +r[2] || 0);
      }
      const dominant = (sid) => {
        const m = modelReq.get(sid);
        if (!m) return null;
        let best = null, n = -1;
        for (const [k, v] of m) if (v > n) { n = v; best = k; }
        return best;
      };
      for (const r of sqlite.query(handle,
        'SELECT session_id, started_at, completed_at, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, model_request_count FROM turn_usage',
        { maxRows: 200000 })) {
        const sid = String(r[0]);
        let s = sessions.get(sid);
        if (!s) { s = { tool: this.id, sessionId: sid, title: '', project: '', firstAt: 0, lastAt: 0, events: [] }; sessions.set(sid, s); }
        const started = toMs(r[1]), done = toMs(r[2]) || started;
        if (!started && !done) continue;
        s.events.push({
          ts: started || done, model: dominant(sid),
          // SELECT 列序：0=sid 1=started_at 2=completed_at 3=input 4=output 5=reasoning 6=cache_creation 7=cache_read 8=model_request_count
          input: +r[3] || 0, output: +r[4] || 0, reasoning: +r[5] || 0,
          cacheWrite: +r[6] || 0, cacheRead: +r[7] || 0,
          requests: Math.max(1, Math.round(+r[8] || 1)),
        });
        s.firstAt = s.firstAt ? Math.min(s.firstAt, started || done) : (started || done);
        s.lastAt = Math.max(s.lastAt, done);
      }
      const out = [...sessions.values()].filter(s => s.events.length);
      return { status: out.length ? 'ok' : 'empty', sessions: out };
    } finally { sqlite.close(handle); }
  },
};
