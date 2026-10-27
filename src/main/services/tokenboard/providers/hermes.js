// Hermes：hermes-agent 的 agent 状态库 state.db。
// 根解析（对齐 hermes-agent/hermes_constants.py get_default_hermes_root）：
//   1) HERMES_HOME 环境变量（桌面安装常用用户级 env 指向自定义根）——
//      指向 <root>/profiles/<name> 时归一到 <root>；根级须有 config.yaml/.env/state.db 标记；
//      env 只对本机设备生效（额外设备根走各自标准路径）
//   2) ~/.hermes、%LOCALAPPDATA%\hermes（平台默认）
// 库位置：<root>/state.db + <root>/profiles/<profile>/state.db（多 profile 各一库）。
// 表结构（实测 v2026-10）：sessions 自带五项 token 汇总+started_at/ended_at+title+cwd+成本；
// session_model_usage 提供每会话×模型明细（api_call_count=input 与 cache 分列的 Claude 口径）。
// 用量为会话级汇总（无逐请求时间戳）：时间窗按会话 ended_at（无则 started_at）归属。
const path = require('path');
const fs = require('fs');
const sqlite = require('../sqlite');
const { toMs, isNum } = require('../util');

// HERMES_HOME 归一化：profiles/<name> → 上上级；校验根标记
function resolveEnvHome(raw) {
  let p = String(raw || '').trim();
  if (!p) return null;
  try { p = path.resolve(p); } catch (_) { return null; }
  try { if (path.basename(path.dirname(p)) === 'profiles') p = path.dirname(path.dirname(p)); } catch (_) {}
  const markers = ['config.yaml', '.env', 'state.db'];
  const okMarker = markers.some(m => fs.existsSync(path.join(p, m)));
  const hasProfiles = fs.existsSync(path.join(p, 'profiles'));
  return (okMarker || hasProfiles) ? p : null;
}

function dbFiles(root) {
  const out = [];
  const rootDb = path.join(root, 'state.db');
  if (fs.existsSync(rootDb)) out.push({ file: rootDb, profile: '' });
  const profDir = path.join(root, 'profiles');
  if (fs.existsSync(profDir)) {
    let names = [];
    try { names = fs.readdirSync(profDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch (_) {}
    for (const n of names) {
      const f = path.join(profDir, n, 'state.db');
      if (fs.existsSync(f)) out.push({ file: f, profile: n });
    }
  }
  return out;
}

function scanDb(handle, profile) {
  // 会话主表（容错：列不存在时整表跳过）
  const sessRows = sqlite.query(handle,
    'SELECT id, title, display_name, cwd, model, started_at, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd FROM sessions',
    { maxRows: 20000 });
  if (!sessRows.length) return [];
  // 每会话×模型明细（模型归属 + 真实调用次数）
  const smu = new Map(); // sid -> [{model, requests, input, output, cacheRead, cacheWrite, reasoning}]
  for (const r of sqlite.query(handle,
    'SELECT session_id, model, api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens FROM session_model_usage',
    { maxRows: 50000 })) {
    const sid = String(r[0]);
    if (!smu.has(sid)) smu.set(sid, []);
    smu.get(sid).push({
      model: r[1] ? String(r[1]) : null,
      requests: Math.max(1, Math.round(+r[2] || 1)),
      input: +r[3] || 0, output: +r[4] || 0,
      cacheRead: +r[5] || 0, cacheWrite: +r[6] || 0, reasoning: +r[7] || 0,
    });
  }
  const out = [];
  for (const r of sessRows) {
    const sid = String(r[0]);
    let input = +r[7] || 0, output = +r[8] || 0, cacheRead = +r[9] || 0;
    let cacheWrite = +r[10] || 0, reasoning = +r[11] || 0;
    let models = smu.get(sid) || [];
    if (!(input > 0) && !(output > 0) && !(cacheRead > 0) && models.length) {
      // 老库/未回填：sessions 汇总列全 0 时退回 session_model_usage 合计
      for (const m of models) { input += m.input; output += m.output; cacheRead += m.cacheRead; cacheWrite += m.cacheWrite; reasoning += m.reasoning; }
    }
    if (!(input > 0) && !(output > 0) && !(cacheRead > 0) && !(cacheWrite > 0)) continue;
    const started = toMs(r[5]), ended = toMs(r[6]);
    const cost = (+r[13] > 0 ? +r[13] : 0) || (+r[12] > 0 ? +r[12] : 0) || 0;
    const domModel = models.length
      ? models.slice().sort((a, b) => (b.input + b.output + b.cacheRead) - (a.input + a.output + a.cacheRead))[0].model
      : (r[4] ? String(r[4]) : null);
    const requests = models.reduce((a, m) => a + m.requests, 0) || 1;
    const title = (r[1] && String(r[1])) || (r[2] && String(r[2])) || '';
    const firstAt = started || ended, lastAt = ended || started;
    out.push({
      tool: 'hermes',
      sessionId: profile ? profile + ':' + sid : sid,
      title, project: r[3] ? String(r[3]) : '',
      firstAt, lastAt,
      costUsd: cost,
      events: [{
        ts: lastAt || firstAt, model: domModel,
        input, output, cacheRead, cacheWrite, reasoning, requests,
      }],
    });
  }
  return out;
}

module.exports = {
  id: 'hermes',
  name: 'Hermes',
  candidates(home, useEnv) {
    const out = [];
    if (useEnv) {
      const envRoot = resolveEnvHome(process.env.HERMES_HOME);
      if (envRoot) out.push(envRoot);
    }
    for (const p of [path.join(home, '.hermes'), path.join(home, 'AppData', 'Local', 'hermes')]) {
      if (fs.existsSync(p) && !out.includes(p)) out.push(p);
    }
    return out;
  },
  scan(ctx) {
    const roots = this.candidates(ctx.home, ctx.primary !== false);
    if (!roots.length) return { status: 'missing', sessions: [] };
    if (!sqlite.available()) return { status: 'error', statusNote: '系统缺少 SQLite 运行库，无法读取 state.db', sessions: [] };
    const sessions = [];
    let sawDb = false, profileNames = [];
    for (const root of roots) {
      for (const { file, profile } of dbFiles(root)) {
        const handle = sqlite.open(file);
        if (!handle) continue;
        sawDb = true;
        if (profile) profileNames.push(profile);
        try {
          sessions.push(...scanDb(handle, profile));
        } finally { sqlite.close(handle); }
      }
    }
    if (sessions.length) {
      const note = profileNames.length ? `（profiles：${[...new Set(profileNames)].slice(0, 6).join('、')}${profileNames.length > 6 ? '…' : ''}）` : undefined;
      return { status: 'ok', statusNote: note, sessions };
    }
    if (sawDb) return { status: 'empty', statusNote: '检测到 Hermes state.db，但里面没有带用量的会话', sessions: [] };
    return { status: 'meta', statusNote: '检测到 Hermes 目录，但未找到 state.db（尚未建立会话？）', sessions: [] };
  },
};
