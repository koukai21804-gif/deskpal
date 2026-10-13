// 宽松扫描器：面向格式未公开/无本地样例的工具（OpenClaw / Antigravity / Hermes 兜底）。
// 策略：逐行 JSON，浅层找「token 样数字段」（util.looseUsage），命中即认作用量事件；
// 时间/模型/会话 id 同样按常见字段名宽松提取。宁可漏读不可误读——
// 命中不了就返回空，工具行会如实显示「格式未适配/无数据」。
const { jsonlLines, looseUsage, looseModel, looseTs, looseSessionId, isNum } = require('./util');

// 在对象浅层（本体 + 常见嵌套位）找用量块
function findUsageBlock(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [obj, obj.data, obj.info, obj.usage, obj.message, obj.payload, obj.meta];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const u = looseUsage(c);
    if (u) return { block: c, usage: u };
  }
  return null;
}

// 解析一整个「未知格式」jsonl 文本 → sessions map（sessionId → 聚合）
function parseLooseJsonl(text, { fallbackSessionId = '' } = {}) {
  const sessions = new Map();
  const ensure = (sid) => {
    const key = sid || fallbackSessionId || 'unknown';
    if (!sessions.has(key)) sessions.set(key, {
      sessionId: key, title: '', project: '', firstAt: 0, lastAt: 0, events: [],
    });
    return sessions.get(key);
  };
  for (const rec of jsonlLines(text)) {
    if (!rec || typeof rec !== 'object') continue;
    const hit = findUsageBlock(rec);
    if (!hit) continue;
    const ts = looseTs(rec) || looseTs(hit.block) || 0;
    const sid = looseSessionId(rec) || looseSessionId(hit.block) || '';
    const s = ensure(sid);
    const ev = {
      ts, model: looseModel(rec) || looseModel(hit.block),
      ...hit.usage, requests: 1,
    };
    s.events.push(ev);
    if (ts) { s.firstAt = s.firstAt || ts; if (ts > s.lastAt) s.lastAt = ts; }
    if (!s.title) {
      const t = rec.title || (rec.data && rec.data.title) || hit.block.title;
      if (t && typeof t === 'string') s.title = t;
    }
    if (!s.project) {
      const p = rec.cwd || rec.directory || rec.project || (rec.data && (rec.data.cwd || rec.data.directory));
      if (p && typeof p === 'string') s.project = p;
    }
  }
  return sessions;
}

// SQLite 宽松扫描：找带 token 样列名的表，整表读出按行宽松解析
function looseSqliteScan(handle, sqlite) {
  const out = new Map(); // sessionId → session
  const tables = sqlite.listTables(handle);
  for (const t of tables.slice(0, 40)) {
    let cols;
    try { cols = sqlite.query(handle, 'PRAGMA table_info(' + sqlite.quoteIdent(t) + ')', { maxRows: 200 }); } catch (_) { continue; }
    if (!cols.length) continue;
    const names = cols.map(c => String(c[1]));
    const tokenCols = names.filter(n => /token|usage|prompt|completion/i.test(n));
    if (!tokenCols.length) continue;
    const timeCol = names.find(n => /time|date|_at$/i.test(n));
    const modelCol = names.find(n => /^model|model_id|model_name$/i.test(n));
    const sessCol = names.find(n => /session|thread|conv/i.test(n));
    let rows;
    try { rows = sqlite.query(handle, 'SELECT * FROM ' + sqlite.quoteIdent(t), { maxRows: 20000 }); } catch (_) { continue; }
    for (const row of rows) {
      const obj = {};
      names.forEach((n, i) => {
        let v = row[i];
        if (Buffer.isBuffer(v)) { try { v = JSON.parse(v.toString('utf8')); } catch (_) { v = v.toString('utf8'); } }
        obj[n] = v;
      });
      // 展平一层 JSON 值列再找用量
      const hit = findUsageBlock(obj) || (() => {
        for (const v of Object.values(obj)) {
          if (v && typeof v === 'object') { const h = findUsageBlock(v); if (h) return h; }
        }
        return null;
      })();
      if (!hit) continue;
      const sid = String((sessCol && obj[sessCol]) || t + ':' + (row[0] != null ? row[0] : 'x'));
      const tsRaw = timeCol ? obj[timeCol] : 0;
      let ts = 0;
      if (typeof tsRaw === 'string') { const p = Date.parse(tsRaw); ts = Number.isFinite(p) ? p : 0; }
      else if (isNum(tsRaw)) ts = +tsRaw < 1e12 ? +tsRaw * 1000 : +tsRaw;
      if (!out.has(sid)) out.set(sid, { sessionId: sid, title: '', project: '', firstAt: ts, lastAt: ts, events: [] });
      const s = out.get(sid);
      s.events.push({ ts, model: (modelCol && obj[modelCol]) || looseModel(obj) || null, ...hit.usage, requests: 1 });
      if (ts) { s.firstAt = Math.min(s.firstAt || ts, ts); s.lastAt = Math.max(s.lastAt, ts); }
    }
  }
  return out;
}

module.exports = { parseLooseJsonl, looseSqliteScan, findUsageBlock };
