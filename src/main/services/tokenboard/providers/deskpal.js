// deskpal 自身：agent/runs.jsonl（每 run 的 usage 汇总）+ chats/*.json（每条 assistant 消息的 usage）
const path = require('path');
const fs = require('fs');
const { anyToMs, isNum } = require('../util');

module.exports = {
  id: 'deskpal',
  name: 'deskpal',
  // deskpal 不随设备根走：数据目录由 ctx.dataDir 注入（与被扫描的其他设备无关）
  usesDataDir: true,
  scan(ctx) {
    const dir = ctx.dataDir;
    if (!dir || !fs.existsSync(dir)) return { status: 'missing', sessions: [] };
    const sessions = [];
    const model = ctx.deskpalModel || null;

    // 1) agent 台账：每个 run 一个「会话」
    const runsFile = path.join(dir, 'agent', 'runs.jsonl');
    if (fs.existsSync(runsFile)) {
      const runs = new Map();
      try {
        const lines = fs.readFileSync(runsFile, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          let o; try { o = JSON.parse(line); } catch (_) { continue; }
          if (!o || !o.id) continue;
          const u = o.usage || {};
          const ts = anyToMs(o.at);
          if (!ts && !u.requests) continue;
          const prev = runs.get(o.id);
          const ev = {
            ts, model,
            input: isNum(u.input) ? +u.input : 0,
            output: isNum(u.output) ? +u.output : 0,
            reasoning: isNum(u.reasoning) ? +u.reasoning : 0,
            cacheRead: isNum(u.cacheHit) ? +u.cacheHit : 0,
            cacheWrite: 0,
            requests: isNum(u.requests) ? +u.requests : 1,
          };
          if (prev) prev.events[0] = ev; // update 型重写：整行替换
          else runs.set(o.id, {
            tool: 'deskpal', sessionId: o.id,
            title: (o.channel === 'work' ? '⚙ ' : '') + String(o.instruction || '(任务)').slice(0, 96),
            project: 'deskpal', firstAt: ts, lastAt: ts, events: [ev],
          });
        }
      } catch (_) {}
      for (const r of runs.values()) if (r.events[0].requests || r.events[0].input || r.events[0].output) sessions.push(r);
    }

    // 2) 聊天历史（多会话）：usage 挂在 assistant 消息上
    for (const chatFile of ['chats/roleplay.json', 'chats/quick.json']) {
      const f = path.join(dir, chatFile);
      if (!fs.existsSync(f)) continue;
      let doc; try { doc = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
      const addMessages = (sessId, sessName, msgs) => {
        const s = {
          tool: 'deskpal', sessionId: 'chat:' + sessId, title: '💬 ' + (sessName || sessId),
          project: 'deskpal', firstAt: 0, lastAt: 0, events: [],
        };
        for (const m of (msgs || [])) {
          const u = m && m.usage;
          if (!u || (!isNum(u.input) && !isNum(u.output))) continue;
          const ts = anyToMs(m.at);
          s.events.push({
            ts, model,
            input: isNum(u.input) ? +u.input : 0,
            output: isNum(u.output) ? +u.output : 0,
            reasoning: isNum(u.reasoning) ? +u.reasoning : 0,
            cacheRead: isNum(u.cacheHit) ? +u.cacheHit : 0,
            cacheWrite: 0, requests: 1,
          });
          if (ts) { s.firstAt = s.firstAt || ts; if (ts > s.lastAt) s.lastAt = ts; }
        }
        if (s.events.length) sessions.push(s);
      };
      if (doc && Array.isArray(doc.sessions)) {
        for (const sess of doc.sessions) addMessages(sess.id, sess.name, sess.messages);
      } else if (Array.isArray(doc.messages)) {
        addMessages(chatFile.includes('quick') ? 'quick' : 'chat', chatFile.includes('quick') ? '快问' : '聊天', doc.messages);
      }
    }
    return { status: sessions.length ? 'ok' : 'empty', sessions };
  },
};
