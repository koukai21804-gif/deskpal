// token 看板服务：编排 12 个 provider（11 个外部 AI 工具 + deskpal 自身），
// 聚合出面板所需的完整快照（时间窗 / 工具 / 模型 / 会话 / 设备 / 限额）。
// 设计约束：纯 Node、无 electron 依赖（测试可直接跑）；文件级 memo 让增量刷新只重解析变化文件。
const os = require('os');
const PROVIDERS = [
  require('./providers/claude-code'),
  require('./providers/codex'),
  require('./providers/cursor'),
  require('./providers/hermes'),
  require('./providers/opencode'),
  require('./providers/openclaw'),
  require('./providers/antigravity'),
  require('./providers/zcode'),
  require('./providers/dsh'),
  require('./providers/qoder'),
  require('./providers/workbuddy'),
  require('./providers/deskpal'),
];

const memo = new Map(); // fileKey → 解析结果（进程内增量；文件不变不重解析）

function emptyBuckets() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0, total: 0, sessions: 0, costUsd: 0 };
}
function addEventTo(b, ev) {
  b.input += ev.input || 0; b.output += ev.output || 0;
  b.cacheRead += ev.cacheRead || 0; b.cacheWrite += ev.cacheWrite || 0;
  b.reasoning += ev.reasoning || 0;
  b.requests += ev.requests == null ? 1 : ev.requests;
  b.total = b.input + b.output + b.cacheRead + b.cacheWrite;
}
function addBuckets(dst, src) {
  dst.input += src.input; dst.output += src.output;
  dst.cacheRead += src.cacheRead; dst.cacheWrite += src.cacheWrite;
  dst.reasoning += src.reasoning; dst.requests += src.requests;
  dst.total += src.total; dst.sessions += src.sessions; dst.costUsd += src.costUsd || 0;
}

function localMidnight(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 一次完整扫描 + 聚合。deps: { home, dataDir, deskpalModel, config, hostname }
// config: { devices: [{label, path}], limits: { [toolId]: { hour5, daily, weekly } } }
function query(deps) {
  const t0 = Date.now();
  const now = Date.now();
  const home = deps.home || os.homedir();
  const hostname = deps.hostname || os.hostname() || '本机';
  const config = deps.config || {};
  const winStart = {
    today: localMidnight(now),
    d7: now - 7 * 86400e3,
    d30: now - 30 * 86400e3,
    all: 0,
  };
  // 设备根：本机 + 用户添加的额外根（如同步盘/WSL 挂载，标设备名）
  const devices = [{ label: hostname, home }];
  for (const d of (config.devices || [])) {
    if (d && d.path && d.label && !devices.some(x => x.home === d.path)) devices.push({ label: d.label, home: d.path });
  }

  const toolsOut = new Map(); // toolId → { id,name,status,statusNote,meta,lastActive,sessions, windows, rates }
  const deviceOut = new Map(); // deviceLabel → windows
  const modelOut = new Map();  // model → { byTool:Set, windows }
  const sessionsOut = [];
  const seenCost = new Set(); // 只有部分工具报 cost，跨设备去重用 toolId 维度即可（每工具唯一行）

  for (const p of PROVIDERS) {
    const row = {
      id: p.id, name: p.name,
      status: 'missing', statusNote: undefined, meta: undefined,
      lastActive: 0, sessions: 0,
      windows: { today: emptyBuckets(), d7: emptyBuckets(), d30: emptyBuckets(), all: emptyBuckets() },
      rates: { h1: 0, h5: 0 }, // 近1h / 近5h token（燃烧速率与 5h 限额窗）
    };
    toolsOut.set(p.id, row);
    for (const dev of devices) deviceOut.set(dev.label, deviceOut.get(dev.label) || {
      label: dev.label, windows: { today: emptyBuckets(), d7: emptyBuckets(), d30: emptyBuckets(), all: emptyBuckets() }, tools: {},
    });
  }

  for (const p of PROVIDERS) {
    for (const dev of devices) {
      // deskpal 自身只随本机数据目录扫描一次（跟「设备根」无关）
      if (p.usesDataDir && dev.home !== home) continue;
      let res;
      try {
        res = p.scan({
          home: dev.home, dataDir: deps.dataDir, deskpalModel: deps.deskpalModel,
          memo, hostname, now,
          primary: dev.home === home, // env 类根（如 HERMES_HOME）只对本机设备生效
        });
      } catch (e) {
        res = { status: 'error', statusNote: '扫描失败：' + (e && e.message), sessions: [] };
      }
      const row = toolsOut.get(p.id);
      if (dev.home === home || p.usesDataDir) {
        // 主设备的状态以本机为准；额外设备只加数不改状态
        if (dev.home === home) {
          row.status = res.status;
          row.statusNote = res.statusNote;
          row.meta = res.meta;
        }
      }
      const devRow = deviceOut.get(dev.label);
      const devTool = devRow.tools[p.id] = (devRow.tools[p.id] || 0);
      for (const s of (res.sessions || [])) {
        if (!s.events || !s.events.length) continue;
        row.sessions++;
        if (s.lastAt > row.lastActive) row.lastActive = s.lastAt;
        // 会话级各窗口
        const sw = { today: emptyBuckets(), d7: emptyBuckets(), d30: emptyBuckets(), all: emptyBuckets() };
        const models = new Map();
        for (const ev of s.events) {
          const mk = ev.model || '（未记录）';
          if (!models.has(mk)) models.set(mk, { total: 0, requests: 0 });
          const mm = models.get(mk);
          mm.total += (ev.input || 0) + (ev.output || 0) + (ev.cacheRead || 0) + (ev.cacheWrite || 0);
          mm.requests += ev.requests == null ? 1 : ev.requests;
          // 时间窗为嵌套关系（今日 ⊂ 7天 ⊂ 30天 ⊂ 全部）：各窗口独立过滤，事件可同时计入多档
          for (const w of ['today', 'd7', 'd30']) {
            if (ev.ts >= winStart[w]) addEventTo(sw[w], ev);
          }
          addEventTo(sw.all, ev);
          // 模型聚合（全局；byTool 按工具分桶，供模型页同名模型跨工具合并时的占比提示）
          if (!modelOut.has(mk)) modelOut.set(mk, {
            model: mk, tools: new Set(),
            byTool: { today: new Map(), d7: new Map(), d30: new Map(), all: new Map() },
            windows: { today: emptyBuckets(), d7: emptyBuckets(), d30: emptyBuckets(), all: emptyBuckets() },
          });
          const mo = modelOut.get(mk);
          mo.tools.add(p.id);
          const tot = (ev.input || 0) + (ev.output || 0) + (ev.cacheRead || 0) + (ev.cacheWrite || 0);
          for (const w of ['today', 'd7', 'd30']) if (ev.ts >= winStart[w]) {
            addEventTo(mo.windows[w], ev);
            mo.byTool[w].set(p.id, (mo.byTool[w].get(p.id) || 0) + tot);
          }
          addEventTo(mo.windows.all, ev);
          mo.byTool.all.set(p.id, (mo.byTool.all.get(p.id) || 0) + tot);
          // 燃烧速率（滚动 1h / 5h）
          if (ev.ts >= now - 3600e3) row.rates.h1 += tot;
          if (ev.ts >= now - 5 * 3600e3) row.rates.h5 += tot;
        }
        for (const w of ['today', 'd7', 'd30', 'all']) {
          addBuckets(row.windows[w], sw[w]);
          addBuckets(devRow.windows[w], sw[w]);
          if (w === 'all') devRow.tools[p.id] = devTool + sw[w].total;
        }
        if (s.costUsd) { row.windows.all.costUsd += s.costUsd; if (!seenCost.has(p.id)) seenCost.add(p.id); }
        sessionsOut.push({
          tool: p.id, toolName: p.name, device: dev.label,
          sessionId: s.sessionId, title: s.title || '', project: s.project || '',
          firstAt: s.firstAt, lastAt: s.lastAt,
          requests: sw.all.requests, costUsd: s.costUsd || 0,
          models: [...models.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 3)
            .map(([m, v]) => ({ model: m, total: v.total, requests: v.requests })),
          windows: sw,
        });
      }
    }
  }

  // 限额（用户在面板配置的本地限额；窗口=滚动 5 小时 / 本地自然日 / 滚动 7 天）
  const limitsCfg = config.limits || {};
  for (const [toolId, row] of toolsOut) {
    const cfg = limitsCfg[toolId] || {};
    const out = {};
    if (cfg.hour5 > 0) {
      const pct = Math.min(100, row.rates.h5 / cfg.hour5 * 100);
      const rate = row.rates.h1 / 60; // token/min
      out.hour5 = {
        limit: cfg.hour5, used: row.rates.h5, pct,
        etaMin: (rate > 0 && row.rates.h5 < cfg.hour5) ? Math.round((cfg.hour5 - row.rates.h5) / rate) : null,
      };
    }
    if (cfg.daily > 0) {
      out.daily = { limit: cfg.daily, used: row.windows.today.total, pct: Math.min(100, row.windows.today.total / cfg.daily * 100), resetAt: localMidnight(now) + 86400e3 };
    }
    if (cfg.weekly > 0) {
      out.weekly = { limit: cfg.weekly, used: row.windows.d7.total, pct: Math.min(100, row.windows.d7.total / cfg.weekly * 100) };
    }
    row.limits = out;
  }

  sessionsOut.sort((a, b) => b.lastAt - a.lastAt);
  return {
    scannedAt: new Date(now).toISOString(),
    scanMs: Date.now() - t0,
    hostname,
    zstd: require('./zstd').implName(),
    devices: [...deviceOut.values()].map(d => ({
      label: d.label, windows: d.windows,
      tools: Object.entries(d.tools).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ tool: k, total: v })),
    })),
    tools: [...toolsOut.values()],
    models: [...modelOut.values()]
      .map(m => ({
        model: m.model, tools: [...m.tools], windows: m.windows,
        // byTool：同名模型跨工具合并展示时的占比提示（各时间窗一分桶，total 口径与 windows 一致）
        byTool: Object.fromEntries(['today', 'd7', 'd30', 'all'].map(w => [w,
          [...m.byTool[w]].sort((a, b) => b[1] - a[1]).map(([tool, total]) => ({ tool, total })),
        ])),
      }))
      .sort((a, b) => b.windows.all.total - a.windows.all.total)
      .slice(0, 60),
    sessions: sessionsOut.slice(0, 400),
  };
}

module.exports = { query, PROVIDERS, _memo: memo, _localMidnight: localMidnight };
