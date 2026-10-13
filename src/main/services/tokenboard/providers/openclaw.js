// OpenClaw：~/.openclaw/agents/<agentId>/（历史别名 .clawdbot/.moltbot/.moldbot 同样识别）。
// 会话 transcript 在 agents/*/sessions/*.jsonl；新版本为 per-agent openclaw-agent.sqlite。
// 官方记录格式未公开（token-monitor 的解析在闭源 tokscale 里）——JSONL 走宽松扫描，
// SQLite 挂 busy_timeout 只读 + 宽松表扫描；读不出就如实标注。
const path = require('path');
const fs = require('fs');
const { walkFiles, fileKey } = require('../util');
const sqlite = require('../sqlite');
const { parseLooseJsonl, looseSqliteScan } = require('../loose');

const ALIASE = ['.openclaw', '.clawdbot', '.moltbot', '.moldbot'];

module.exports = {
  id: 'openclaw',
  name: 'OpenClaw',
  dataDirs: (home) => ALIASE.map(a => path.join(home, a)).filter(d => fs.existsSync(d)),
  scan(ctx) {
    const roots = this.dataDirs(ctx.home);
    if (!roots.length) return { status: 'missing', sessions: [] };
    const sessions = [];
    let sawAgentDir = false, sawData = false;
    for (const root of roots) {
      const agentsDir = path.join(root, 'agents');
      if (!fs.existsSync(agentsDir)) continue;
      let agents;
      try { agents = fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory()); } catch (_) { continue; }
      for (const ag of agents) {
        sawAgentDir = true;
        const agDir = path.join(agentsDir, ag.name);
        // 1) JSONL transcript（宽松）
        for (const rec of walkFiles(path.join(agDir, 'sessions'), { filter: f => f.endsWith('.jsonl'), maxDepth: 4 })) {
          const key = fileKey(rec);
          let parsed = ctx.memo.get(key);
          if (!parsed) {
            let text = '';
            try { text = fs.readFileSync(rec.file, 'utf8'); } catch (_) { continue; }
            parsed = [...parseLooseJsonl(text, { fallbackSessionId: path.basename(rec.file, '.jsonl') }).values()];
            ctx.memo.set(key, parsed);
          }
          for (const s of parsed) if (s.events.length) { sessions.push({ tool: this.id, ...s }); sawData = true; }
        }
        // 2) per-agent SQLite（宽松）
        const dbFile = path.join(agDir, 'openclaw-agent.sqlite');
        if (fs.existsSync(dbFile) && sqlite.available()) {
          const handle = sqlite.open(dbFile);
          if (handle) {
            try {
              for (const s of looseSqliteScan(handle, sqlite).values()) {
                if (s.events.length) { sessions.push({ tool: this.id, ...s }); sawData = true; }
              }
            } finally { sqlite.close(handle); }
          }
        }
      }
    }
    if (sawData) return { status: 'ok', sessions };
    if (sawAgentDir) return { status: 'meta', statusNote: '检测到 OpenClaw agents，但未在会话文件中识别出 token 用量（格式可能已变化或尚无对话）', sessions: [] };
    return { status: 'empty', statusNote: '检测到 OpenClaw，暂无 agents 会话数据', sessions: [] };
  },
};
