// token 看板回归测试（/tokens 面板数据源，开发版）
// 覆盖：claude 系 transcript 解析（去重/标题/缓存语义/plan-billed 跳过）、dsh zstd 会话、
// codex rollout 差分、zcode 列序、时间窗聚合（all 无条件累加/嵌套互斥）、限额计算、
// 设备维度、deskpal 自身读取。纯 Node，无 electron 依赖。
// 用法：node scripts/test-tokenboard.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SVC = p => path.join(ROOT, 'src/main/services/tokenboard', p);

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function eq(a, b, name) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  ok(ja === jb, `${name}${ja === jb ? '' : `（got ${String(ja).slice(0, 90)}, want ${String(jb).slice(0, 90)}）`}`);
}
function section(t) { console.log('\n## ' + t); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-tokenboard-test-'));
const HOME = path.join(TMP, 'home');
const DATADIR = path.join(TMP, 'data');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(DATADIR, { recursive: true });
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// ---------- fixture：Claude Code transcript ----------
{
  const projDir = path.join(HOME, '.claude', 'projects', 'D--test-proj');
  fs.mkdirSync(projDir, { recursive: true });
  const usage = (i, o, cr, ccw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: ccw });
  const lines = [
    JSON.stringify({ type: 'ai-title', title: '会话标题A' }),
    JSON.stringify({ type: 'user', message: { role: 'user' }, timestamp: iso(2 * 86400e3) }),
    // 同一 message.id 两次落盘（resume 更新）：只计最后一次
    JSON.stringify({ type: 'assistant', timestamp: iso(2 * 86400e3), sessionId: 'sess-a', cwd: 'D:\\test\\proj', message: { id: 'msg_1', model: 'm-x', usage: usage(100, 50, 10, 5) } }),
    JSON.stringify({ type: 'assistant', timestamp: iso(2 * 86400e3), sessionId: 'sess-a', cwd: 'D:\\test\\proj', message: { id: 'msg_1', model: 'm-x', usage: usage(200, 80, 20, 8) } }),
    JSON.stringify({ type: 'assistant', timestamp: iso(3600e3), sessionId: 'sess-a', message: { id: 'msg_2', model: 'm-y', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: 120 } } } }),
  ];
  fs.writeFileSync(path.join(projDir, 'aaa.jsonl'), lines.join('\n') + '\n');
}

// ---------- fixture：DSH（一个明文 + 一个 zstd） ----------
{
  const sessDir = path.join(HOME, '.dsh', 'sessions', '--D-testapp--', 'session-abc');
  fs.mkdirSync(sessDir, { recursive: true });
  const recs = [
    { type: 'session', time: iso(3 * 86400e3), data: { title: 'DSH 会话', id: 'session-abc' } },
    { type: 'usage', seq: 1, time: iso(3 * 86400e3), data: { usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 30, reasoningTokens: 50 }, message: { source: { model: 'deepseek-chat' } } } },
    { type: 'usage', seq: 1, time: iso(3 * 86400e3), data: { usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 400 }, message: { source: { model: 'deepseek-chat' } } } }, // seq 重放 → 去重
    { type: 'usage', seq: 2, time: iso(2 * 3600e3), data: { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 } } },
  ];
  fs.writeFileSync(path.join(sessDir, 'session.jsonl'), recs.map(r => JSON.stringify(r)).join('\n') + '\n');
  const zst = require('zlib');
  if (typeof zst.zstdCompressSync === 'function') {
    fs.writeFileSync(path.join(sessDir, 'session.v2.jsonl.zstd'),
      zst.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'usage', seq: 3, time: iso(30 * 60e3), data: { usage: { inputTokens: 777, outputTokens: 111, cacheReadTokens: 77 } } }) + '\n')));
  }
}

// ---------- fixture：Codex rollout（累计 token_count 差分） ----------
{
  const dir = path.join(HOME, '.codex', 'sessions', '2026', '01', '01');
  fs.mkdirSync(dir, { recursive: true });
  const recs = [
    { timestamp: iso(26 * 3600e3), type: 'session_meta', payload: { type: 'session_meta', id: 'codex-s1', model: 'gpt-x' } },
    { timestamp: iso(26 * 3600e3), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 300 } } } },
    { timestamp: iso(25 * 3600e3), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 3000, cached_input_tokens: 1000, output_tokens: 800 } } } },
  ];
  fs.writeFileSync(path.join(dir, 'rollout-2026-01-01T00-00-00-codex-s1.jsonl'), recs.map(r => JSON.stringify(r)).join('\n') + '\n');
}

// ---------- fixture：deskpal 自身 ----------
{
  fs.mkdirSync(path.join(DATADIR, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(DATADIR, 'chats'), { recursive: true });
  fs.appendFileSync(path.join(DATADIR, 'agent', 'runs.jsonl'), JSON.stringify({
    id: 'run_1', at: iso(2 * 3600e3), instruction: '测试任务', channel: 'work',
    usage: { input: 3000, output: 400, reasoning: 100, cacheHit: 2000, requests: 4 },
  }) + '\n');
  fs.writeFileSync(path.join(DATADIR, 'chats', 'roleplay.json'), JSON.stringify({
    schema: 2, sessions: [{ id: 's1', name: '主对话', messages: [
      { id: 'm1', role: 'user', content: 'hi', at: iso(3 * 3600e3) },
      { id: 'm2', role: 'assistant', content: 'ok', at: iso(3 * 3600e3 - 1000), usage: { input: 800, output: 200, reasoning: 50, cacheHit: 100, requests: 1 } },
    ] }],
  }));
}

// ---------- fixture：Hermes（HERMES_HOME 自定义根 + profiles/*/state.db，winsqlite3 动态建库） ----------
let HERMES_FIX = null; // { root } 或 null（无 winsqlite3 时跳过）
{
  try {
    const koffi = require('koffi');
    const lib = koffi.load('winsqlite3.dll');
    const openW = lib.func('int sqlite3_open_v2(const char*, _Out_ void**, int, const char*)');
    const prepW = lib.func('int sqlite3_prepare_v2(void*, const char*, int, _Out_ void**, _Out_ void*)');
    const stepW = lib.func('int sqlite3_step(void*)');
    const finW = lib.func('int sqlite3_finalize(void*)');
    const closeW = lib.func('int sqlite3_close(void*)');
    const run = (db, sql) => { const s = [null]; if (prepW(db, sql, -1, s, null) !== 0) throw new Error('prepare fail: ' + sql); stepW(s[0]); finW(s[0]); };
    const mkDb = (file, rows, smu) => {
      const p = [null];
      if (openW(file, p, 6, null) !== 0) throw new Error('create fail');
      const db = p[0];
      run(db, 'CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, display_name TEXT, cwd TEXT, model TEXT, started_at REAL, ended_at REAL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL)');
      run(db, 'CREATE TABLE session_model_usage (session_id TEXT, model TEXT, api_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER)');
      for (const r of rows) run(db, `INSERT INTO sessions VALUES ('${r.id}', ${r.title ? "'" + r.title + "'" : 'NULL'}, NULL, 'D:\\\\test', '${r.model || 'glm-x'}', ${r.started}, ${r.ended}, ${r.i || 0}, ${r.o || 0}, ${r.cr || 0}, ${r.cw || 0}, ${r.rr || 0}, ${r.cost || 0}, NULL)`);
      for (const r of smu || []) run(db, `INSERT INTO session_model_usage VALUES ('${r.sid}', '${r.model}', ${r.api}, ${r.i}, ${r.o}, ${r.cr}, 0, 0)`);
      closeW(db);
    };
    const root = path.join(TMP, 'hermes-home');
    fs.mkdirSync(path.join(root, 'profiles', 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(root, 'profiles', 'beta'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config.yaml'), '# test\n');
    const sec = (msAgo) => (NOW - msAgo) / 1000;
    mkDb(path.join(root, 'profiles', 'alpha', 'state.db'),
      [
        { id: 's1', title: '甲会话', started: sec(2 * 3600e3), ended: sec(1.5 * 3600e3), i: 1200, o: 250, cr: 5100, cost: 0.12 },
        { id: 's2', started: sec(3 * 3600e3), ended: sec(2.8 * 3600e3) }, // 汇总列全 0 → SMU fallback
      ],
      [
        { sid: 's1', model: 'glm-x', api: 3, i: 1000, o: 200, cr: 5000 },
        { sid: 's1', model: 'glm-y', api: 1, i: 200, o: 50, cr: 100 },
        { sid: 's2', model: 'glm-x', api: 2, i: 700, o: 90, cr: 300 },
      ]);
    mkDb(path.join(root, 'profiles', 'beta', 'state.db'), [], []); // 空库
    HERMES_FIX = { root };
  } catch (e) { console.log('（winsqlite3 不可用，hermes fixture 节跳过：' + e.message + '）'); }
}

const tb = require(SVC('index'));

// ============ 1. claude-jsonl 解析语义 ============
section('claude 系 transcript：去重/标题/缓存/思考');
{
  const { parseClaudeTranscript } = require(SVC('claude-jsonl'));
  const text = fs.readFileSync(path.join(HOME, '.claude', 'projects', 'D--test-proj', 'aaa.jsonl'), 'utf8');
  const p = parseClaudeTranscript(text, { fileKey: 'aaa' });
  eq(p.title, '会话标题A', 'ai-title 标题提取');
  eq(p.events.length, 2, '同名 message.id 去重后剩 2 条');
  const e1 = p.events[0];
  eq([e1.input, e1.output, e1.cacheRead, e1.cacheWrite], [200, 80, 20, 8], '保留最后一次 usage');
  eq(p.events[1].reasoning, 120, 'thinking_tokens 归 reasoning');
  // Qoder 语义：input 含 cache_read
  const q = parseClaudeTranscript(JSON.stringify({ type: 'assistant', timestamp: iso(1000), message: { id: 'x', model: 'm', usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 700 } } }), { inputIncludesCache: true });
  eq(q.events[0].input, 300, 'inputIncludesCache：减出未缓存输入');
  const plan = parseClaudeTranscript(JSON.stringify({ type: 'assistant', timestamp: iso(1000), message: { id: 'y', usage: { input_tokens: 0, output_tokens: 0, credits: 5, context_usage_ratio: 0.2 } } }), { skipPlanBilled: true });
  eq(plan.events.length, 0, 'plan-billed 行（token 全 0 带 credits）跳过');
}

// ============ 2. 整板扫描（本机 fixture 家目录） ============
section('全量 query：工具状态与窗口聚合');
let snap;
{
  snap = tb.query({ home: HOME, dataDir: DATADIR, deskpalModel: 'glm-test', config: { devices: [], limits: {} }, hostname: 'test-host' });
  const by = Object.fromEntries(snap.tools.map(t => [t.id, t]));
  ok(by['claude-code'].status === 'ok', 'claude-code ok');
  ok(by.codex.status === 'ok', 'codex ok');
  ok(by.dsh.status === 'ok', 'dsh ok');
  ok(by.deskpal.status === 'ok', 'deskpal ok');
  ok(by.cursor.status === 'missing', 'cursor 未安装 → missing');
  ok(by.zcode.status === 'missing', 'zcode 未装（fixture 家目录）→ missing');
  ok(by.workbuddy.status === 'missing', 'workbuddy 未装 → missing');

  // claude-code 窗口（嵌套语义：今日 ⊂ 7天 ⊂ 30天 ⊂ 全部，各窗口独立过滤）
  // 事件1（2天前）：200+80+20+8=308；事件2（1h前）：1000+500+100=1600
  const cc = by['claude-code'].windows;
  eq(cc.all.total, 308 + 1600, 'claude all=两条去重事件合计');
  eq(cc.d30.total, 308 + 1600, '两条都在 30 天内 → d30=同值');
  eq(cc.d7.total, 308 + 1600, 'd7 同值（嵌套含今日）');
  eq(cc.today.total, 1600, '今日只含 1h 前事件');
  eq(cc.all.requests, 2, '请求数=去重消息数');

  // dsh：明文 + zstd。input 已减 cacheRead（DeepSeek 口径）：
  // seq1: (500-400)+200+400+30=730；seq2: 150；zstd seq3: (777-77)+111+77=888
  const dshS = by.dsh;
  const dshAllNoZ = 730 + 150;
  if (typeof require('zlib').zstdCompressSync === 'function') {
    eq(dshS.windows.all.total, dshAllNoZ + 888, 'dsh 明文+zstd 合计（input 减缓存口径）');
  } else {
    eq(dshS.windows.all.total, dshAllNoZ, 'dsh 明文合计（本运行时无 zstd 压缩 fixture）');
  }
  eq(dshS.windows.all.input, 100 + 100 + (typeof require('zlib').zstdCompressSync === 'function' ? 700 : 0), 'dsh input 已减 cacheRead（DeepSeek 口径）');
  const dshSess = snap.sessions.find(s => s.tool === 'dsh');
  eq(dshSess.title, 'DSH 会话', 'dsh 标题来自 session/title 事件');
  eq(dshSess.project, 'D:\\testapp', 'dsh 项目目录解码（含首尾 -- 剥离）');

  // codex：基线 0 差分。首条 (1000,600,300)+二条差分 (2000,400,500)
  // → input=(1000-600)+(2000-400)=2000、output=800、cacheRead=1000
  const cx = by.codex.windows.all;
  eq([cx.input, cx.output, cx.cacheRead], [2000, 800, 1000], 'codex 累计值差分（含首条）');

  // deskpal：runs + 聊天 usage
  const dpw = by.deskpal.windows.all;
  eq(dpw.input, 3000 + 800, 'deskpal 输入=run+聊天消息');
  eq(dpw.requests, 4 + 1, 'deskpal 调用=run.requests+消息数');
  const dpChat = snap.sessions.find(s => s.tool === 'deskpal' && s.sessionId === 'chat:s1');
  ok(dpChat && dpChat.windows.all.total > 0, 'deskpal 聊天会话入列');
}

// ============ 3. 模型维度 ============
section('模型聚合');
{
  const m = snap.models.find(x => x.model === 'm-x');
  ok(m && m.windows.all.total === 308, '模型 m-x 归属 claude-code（200+80+20+8）');
  const mz = snap.models.find(x => x.model === 'glm-test');
  ok(mz && mz.tools.includes('deskpal'), 'deskpal 模型按当前配置模型标注');
}

// ============ 4. 限额 ============
section('限额计算');
{
  const s2 = tb.query({
    home: HOME, dataDir: DATADIR, deskpalModel: null,
    config: { devices: [], limits: { dsh: { hour5: 1000, daily: 0, weekly: 5000 } } },
    hostname: 'test-host',
  });
  const dsh = s2.tools.find(t => t.id === 'dsh');
  // 近 5h：seq2(150) + zstd seq3(888)（若运行时支持）
  const exp5h = 150 + (typeof require('zlib').zstdCompressSync === 'function' ? 888 : 0);
  eq(Math.round(dsh.limits.hour5.used), exp5h, '5h 窗口用量只算近 5 小时');
  ok(dsh.limits.hour5.pct <= 100, '5h 百分比封顶 100');
  ok(dsh.limits.hour5.etaMin == null || dsh.limits.hour5.etaMin >= 0, 'eta 非负或空');
  eq(dsh.limits.daily, undefined, 'daily=0 不生成');
  ok(dsh.limits.weekly && dsh.limits.weekly.limit === 5000, 'weekly 限额生成');
  const noLim = s2.tools.find(t => t.id === 'claude-code');
  eq(noLim.limits, {}, '未配置的工具 limits 为空对象');
}

// ============ 5. 设备维度 ============
section('设备：本机 + 额外根');
{
  const extraHome = path.join(TMP, 'home2');
  const projDir = path.join(extraHome, '.claude', 'projects', 'E--other');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'bbb.jsonl'), JSON.stringify({ type: 'assistant', timestamp: iso(1000), sessionId: 'sess-b', message: { id: 'm9', model: 'm-x', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n');
  const s3 = tb.query({
    home: HOME, dataDir: DATADIR, deskpalModel: null,
    config: { devices: [{ label: 'PC-2', path: extraHome }], limits: {} },
    hostname: 'test-host',
  });
  eq(s3.devices.length, 2, '两台设备');
  const cc = s3.tools.find(t => t.id === 'claude-code');
  eq(cc.windows.all.total, 308 + 1600 + 15, 'claude all 含额外设备会话');
  const pc2 = s3.devices.find(d => d.label === 'PC-2');
  eq(pc2.windows.all.total, 15, 'PC-2 只含自己的会话');
  const sB = s3.sessions.find(x => x.sessionId === 'sess-b');
  eq(sB.device, 'PC-2', '会话行带设备标注');
}

// ============ 6. memo 增量（文件不变不重解析，变了重解析） ============
section('memo 增量');
{
  const m = tb._memo;
  const before = m.size;
  tb.query({ home: HOME, dataDir: DATADIR, deskpalModel: null, config: { devices: [], limits: {} }, hostname: 'h' });
  eq(m.size, before, '无变化时不新增解析条目');
  const f = path.join(HOME, '.claude', 'projects', 'D--test-proj', 'aaa.jsonl');
  fs.appendFileSync(f, JSON.stringify({ type: 'assistant', timestamp: iso(500), sessionId: 'sess-a', message: { id: 'msg_3', model: 'm-x', usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n');
  const s4 = tb.query({ home: HOME, dataDir: DATADIR, deskpalModel: null, config: { devices: [], limits: {} }, hostname: 'h' });
  const cc = s4.tools.find(t => t.id === 'claude-code');
  eq(cc.windows.all.total, 308 + 1600 + 10, '追加后重解析新行');
}

// ============ 7. fzstd 兜底路径（如果装了 fzstd，强制走它验证与 zlib 同构） ============
section('zstd 双实现一致性');
{
  const zstd = require(SVC('zstd'));
  if (typeof require('zlib').zstdCompressSync === 'function') {
    const zlib = require('zlib');
    const payload = Buffer.from('{"type":"usage","seq":9,"data":{"usage":{"inputTokens":1}}}\n'.repeat(50));
    const zbuf = zlib.zstdCompressSync(payload);
    const viaZlib = zstd.decompress(zbuf);
    let viaFz = null;
    try {
      const fzstd = require('fzstd');
      // 手工按 fzstd 单帧解（与 zstd.js 内部 splitFrames+逐帧同思路）
      viaFz = Buffer.from(fzstd.decompress(zbuf));
    } catch (_) { /* fzstd 未安装则跳过 */ }
    ok(viaZlib && viaZlib.equals(payload), 'zlib 路径解压正确');
    if (viaFz) ok(viaFz.equals(payload), 'fzstd 路径解压与 zlib 一致');
    else console.log('  - fzstd 未安装，跳过该子项');
    ok(zstd.decompress(Buffer.from('not-zstd')) === null, '坏输入返回 null 不抛异常');
  } else {
    console.log('  - 本运行时无 zlib zstd，跳过');
  }
}

// ============ 8. Hermes（HERMES_HOME 根解析 + 双表解析） ============
section('Hermes：env 根 / profiles / 双表 / SMU fallback');
{
  if (HERMES_FIX) {
    const hermes = require(SVC('providers/hermes'));
    const prevEnv = process.env.HERMES_HOME;
    process.env.HERMES_HOME = HERMES_FIX.root;
    try {
      const res = hermes.scan({ home: path.join(TMP, 'nowhere'), primary: true });
      eq(res.status, 'ok', 'HERMES_HOME 指向自定义根 → ok');
      eq(res.sessions.length, 2, 'alpha 2 会话（beta 空库不计）');
      const s1 = res.sessions.find(s => s.sessionId === 'alpha:s1');
      ok(s1, 'sessionId 带 profile 前缀');
      if (s1) {
        eq(s1.title, '甲会话', 'title 提取');
        const ev = s1.events[0];
        eq([ev.input, ev.output, ev.cacheRead], [1200, 250, 5100], 'sessions 汇总列优先');
        eq(ev.requests, 4, 'requests=SMU api_call_count 合计');
        eq(ev.model, 'glm-x', '主模型按 SMU 用量取优势模型');
        ok(Math.abs(s1.costUsd - 0.12) < 1e-9, '成本取 estimated（actual 空）');
      }
      const s2 = res.sessions.find(s => s.sessionId === 'alpha:s2');
      if (s2) {
        const ev = s2.events[0];
        eq([ev.input, ev.output, ev.cacheRead], [700, 90, 300], 'sessions 全 0 → SMU fallback 合计');
        eq(ev.requests, 2, 'fallback requests');
      }
      // env 指向 profiles/<name> → 归一到根
      process.env.HERMES_HOME = path.join(HERMES_FIX.root, 'profiles', 'alpha');
      const res2 = hermes.scan({ home: path.join(TMP, 'nowhere'), primary: true });
      eq(res2.status, 'ok', 'HERMES_HOME 指向 profiles/<name> → 归一到根');
      // 非本机设备不吃 env
      process.env.HERMES_HOME = HERMES_FIX.root;
      const res3 = hermes.scan({ home: path.join(TMP, 'nowhere'), primary: false });
      eq(res3.status, 'missing', '额外设备根不吃 HERMES_HOME');
      // env 指向无标记的空目录 → 忽略
      const fake = path.join(TMP, 'fake-hermes');
      fs.mkdirSync(fake, { recursive: true });
      process.env.HERMES_HOME = fake;
      const res4 = hermes.scan({ home: path.join(TMP, 'nowhere'), primary: true });
      eq(res4.status, 'missing', '无 config.yaml/state.db 标记的目录不算 hermes 根');
    } finally { process.env.HERMES_HOME = prevEnv; }
  } else {
    console.log('  - 跳过（fixture 未建）');
  }
}

// ============ 9. 目录名解码 ============
section('工具函数');
{
  const { decodeProjectDir } = require(SVC('util'));
  eq(decodeProjectDir('D--CC-project-deskpal'), 'D:\\CC\\project\\deskpal', '盘符路径解码');
  ok(String(decodeProjectDir('C--Users-webuser')).startsWith('C:\\'), 'C 盘解码');
}

// ============ 10. WorkBuddy 新版 transcript（type:message / function_call 行族） ============
section('WorkBuddy 新版：function_call 信封 / 双表示去重 / messageId 重放 / 模型回退');
{
  const { parseClaudeTranscript } = require(SVC('claude-jsonl'));
  const L = (o) => JSON.stringify(o);
  const text = [
    L({ type: 'ai-title', title: 'PDF 识别' }),
    // 新版 message 行（role=assistant）：message.usage 缺 → 回退 providerData.usage（camelCase）
    L({ type: 'message', role: 'assistant', timestamp: iso(2 * 3600e3), message: { role: 'assistant' }, providerData: { model: 'step-5-preview', usage: { inputTokens: 500, outputTokens: 60, inputTokensDetails: [{ cached_tokens: 200 }] } } }),
    // 新版 function_call 行：用量信封挂 message.usage（snake_case，实测样例口径；信封 id/model 为空）
    L({ type: 'function_call', timestamp: iso(3600e3), message: { id: '', model: '', usage: { input_tokens: 36544, output_tokens: 302, total_tokens: 36846, cache_read_input_tokens: 7680 } }, providerData: { messageId: 'pm_001', model: 'step-5-preview' } }),
    // 同行双表示（message.usage 与 providerData.usage 并存且量不同）→ 只计 message.usage 一次
    L({ type: 'function_call', timestamp: iso(3600e3), message: { id: '', model: '', usage: { input_tokens: 100, output_tokens: 10 } }, providerData: { messageId: 'pm_002', model: 'hy4-preview', usage: { inputTokens: 999, outputTokens: 99 } } }),
    // 同 providerData.messageId 重放两行（resume 更新）→ 只计最后一次、ts 取较新
    L({ type: 'function_call', timestamp: iso(3 * 3600e3), message: { usage: { input_tokens: 11, output_tokens: 1 } }, providerData: { messageId: 'pm_003', model: 'deepseek-v4.1-flash' } }),
    L({ type: 'function_call', timestamp: iso(3 * 3600e3 - 5000), message: { usage: { input_tokens: 22, output_tokens: 2 } }, providerData: { messageId: 'pm_003', model: 'deepseek-v4.1-flash' } }),
    // 与用量无关的新版行型：不采集、不报错
    L({ type: 'reasoning', timestamp: iso(2 * 3600e3), data: { text: '…' } }),
    L({ type: 'file-history-snapshot', timestamp: iso(2 * 3600e3) }),
    L({ type: 'session-meta', timestamp: iso(2 * 3600e3), sessionId: 'wb-1' }),
  ].join('\n') + '\n';
  const p = parseClaudeTranscript(text, { fileKey: 'wb' });
  eq(p.title, 'PDF 识别', '新版 ai-title 行照常采到标题');
  eq(p.sessionId, 'wb-1', 'session-meta 行的 sessionId 照常提取');
  eq(p.events.length, 4, '事件数=4（message 行 + 三个唯一 messageId）');
  const eCamel = p.events.find(e => e.input === 500);
  ok(eCamel && eCamel.output === 60 && eCamel.cacheRead === 200, 'message 行回退 providerData.usage：camelCase 四项映射（cached_tokens→cacheRead）');
  ok(eCamel && eCamel.model === 'step-5-preview', '模型回退链：信封 model 空 → providerData.model');
  const eEnv = p.events.find(e => e.input === 36544);
  ok(eEnv && eEnv.output === 302 && eEnv.cacheRead === 7680 && eEnv.cacheWrite === 0, 'function_call 行 message.usage（snake_case）全量采集，input 不含缓存无需减法');
  ok(eEnv && eEnv.model === 'step-5-preview', 'function_call 行模型同走回退链');
  const eDual = p.events.find(e => e.input === 100);
  ok(eDual && eDual.output === 10, '同行双表示只计 message.usage');
  ok(!p.events.some(e => e.input === 999), 'providerData.usage 表示未产生第二条事件');
  const eRe = p.events.find(e => e.input === 22);
  ok(eRe && eRe.output === 2, '同 messageId 重放两行只计最后一次');
  eq(p.events.filter(e => e.input === 11).length, 0, '被顶替的旧量不再出现');
  const sum = p.events.reduce((s, e) => s + e.input + e.output + e.cacheRead + e.cacheWrite, 0);
  eq(sum, (500 + 60 + 200) + (36544 + 302 + 7680) + (100 + 10) + (22 + 2), '总量=四条事件四项之和');
}

// ============ 11. 模型 byTool 分桶（模型页跨工具占比提示数据面） ============
section('模型 byTool 分桶');
{
  const m = snap.models.find(x => x.model === 'm-x');
  ok(m && Array.isArray(m.byTool && m.byTool.all) && m.byTool.all.length === 1
    && m.byTool.all[0].tool === 'claude-code' && m.byTool.all[0].total === 308,
    'byTool.all 按工具分桶（m-x 全部来自 claude-code=308）');
  const mz = snap.models.find(x => x.model === 'glm-test');
  ok(mz && mz.byTool && mz.byTool.all.some(t => t.tool === 'deskpal'),
    'deskpal 模型 byTool 含 deskpal 桶');
}

// ============ 12. hindsight provider（usage 台账解析） ============
section('hindsight 记忆 token（代理 usage 台账）');
{
  const usageFile = path.join(TMP, 'usage.jsonl');
  const now = Date.now();
  fs.writeFileSync(usageFile, [
    JSON.stringify({ ts: now - 3600e3, bank: 'deskpal-tito', input: 3000, output: 100, cached: 500, requests: 1 }),
    JSON.stringify({ ts: now, bank: 'hermes-main', input: 2000, output: 50, cached: 0, requests: 1 }),
    'not-json-line',
  ].join('\n'));
  process.env.HINDSIGHT_USAGE_LOG = usageFile;
  delete require.cache[require.resolve(SVC('providers/hindsight.js'))];
  const hp = require(SVC('providers/hindsight.js'));
  const res = hp.scan({});
  eq(res.status, 'ok', '台账存在 → status ok');
  eq(res.sessions.length, 2, '两个 bank → 两个会话');
  const tito = res.sessions.find(x => x.id === 'hindsight:deskpal-tito');
  ok(tito && tito.events.length === 1 && tito.events[0].input === 3000 && tito.events[0].cacheRead === 500,
    'deskpal-tito 事件 input=3000 cacheRead=500（cached→cacheRead 映射）');
  ok(res.sessions[0].lastAt >= res.sessions[1].lastAt, '会话按最近活跃降序');
  eq(res.sessions.reduce((n, x) => n + x.events.length, 0), 2, '坏 JSON 行被跳过');
  const snapH = tb.query({ home: HOME, dataDir: DATADIR, deskpalModel: null, config: { devices: [{ label: 'PC-2', path: path.join(TMP, 'home2') }], limits: {} } });
  const hrow = (snapH.tools || []).find(t => t.id === 'hindsight');
  ok(hrow && hrow.windows.all.input === 5000, 'hindsight 只计一次（input=3000+2000，不随设备翻倍）');
  process.env.HINDSIGHT_USAGE_LOG = path.join(TMP, 'no-such.jsonl');
  delete require.cache[require.resolve(SVC('providers/hindsight.js'))];
  const res2 = require(SVC('providers/hindsight.js')).scan({});
  eq(res2.status, 'missing', '台账不存在 → status missing');
  delete process.env.HINDSIGHT_USAGE_LOG;
}
console.log(`\n========== token 看板测试: ${passed} 通过, ${failed} 失败 ==========`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(failed ? 1 : 0);
