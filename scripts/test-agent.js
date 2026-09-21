// ★H v0.3 单元自测：progress 剥离器 / 节拍解析 / 差分归因 / run 台账 / 工具注册表
// 用法：node scripts/test-agent.js（纯 Node，不需要 Electron 运行时；electron require 为无害占位）
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function eq(a, b, name) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  ok(ja === jb, `${name}${ja === jb ? '' : `（got ${ja}, want ${jb}）`}`);
}
function section(t) { console.log('\n## ' + t); }

// ============ 1. progress 剥离器 ============
section('agent/progress.js [进展:] 流式剥离');
const { createProgressSplitter } = require(path.join(ROOT, 'src/main/services/agent/progress'));

{
  const sp = createProgressSplitter();
  const r1 = sp.feed('你好[进展:设计] 先读取目录\n接着');
  eq(r1.progress, [{ phase: '设计', text: '先读取目录' }], '完整标记单 chunk 剥离');
  eq(r1.cleanDelta, '你好接着', '标记行不进正文');
  const r2 = sp.flush();
  eq(r2.cleanDelta, '', 'flush 无残余');
}

{
  // 任意字节边界：逐字符喂入，半截标记永不泄漏
  const src = 'A[进展:发现] 意外发现 B\nC[进展:验证] 检查过 D\n尾巴[进';
  const sp = createProgressSplitter();
  let clean = '', progress = [];
  let leak = false;
  for (const ch of src) {
    const r = sp.feed(ch);
    clean += r.cleanDelta;
    if (r.cleanDelta.includes('进展')) leak = true;
    progress.push(...r.progress);
  }
  ok(!leak, '半截标记不泄漏（逐字符）');
  clean += sp.flush().cleanDelta;
  eq(clean, 'AC尾巴[进', '逐字符 clean 拼接正确（标记行整行剥离，说明文字不进正文）');
  eq(progress.map(p => p.phase), ['发现', '验证'], '两条进展均剥出');
}

{
  // 尾巴保留：chunk 恰好断在标记中间
  const sp = createProgressSplitter();
  const r1 = sp.feed('正文[进展:设');
  eq(r1.cleanDelta, '正文', '半截标记留在 buffer');
  const r2 = sp.feed('计] 决定建文件\n完成');
  eq(r2.progress, [{ phase: '设计', text: '决定建文件' }], '跨 chunk 标记补全');
  eq(r2.cleanDelta, '完成', '后续正文正常输出');
}

{
  // flush 残余按正文输出（流结束时不足标记的尾巴不丢字）
  const sp = createProgressSplitter();
  const r0 = sp.feed('abc [进展:能力] 产出 x');
  eq(r0.cleanDelta, 'abc ', '标记前行文在 feed 时先输出');
  const r = sp.flush();
  eq(r.progress, [{ phase: '能力', text: '产出 x' }], '无换行结尾的标记在 flush 剥出');
  eq(r.cleanDelta, '', 'flush 无残余正文');
}

{
  // 同一行多个标记：各自剥出，说明文字互不吞噬
  const sp = createProgressSplitter();
  const r = sp.feed('开始[进展:设计] 决定建文件[进展:能力] 文件已生成\n完成');
  eq(r.progress, [
    { phase: '设计', text: '决定建文件' },
    { phase: '能力', text: '文件已生成' },
  ], '同行双标记各自剥出');
  eq(r.cleanDelta, '开始完成', '同行双标记正文无残留');
}

{
  // 非标记方括号不误伤
  const sp = createProgressSplitter();
  const r = sp.feed('数组 arr[0] 与 arr[1] 的值\n');
  eq(r.progress, [], '普通方括号不误判');
  eq(r.cleanDelta, '数组 arr[0] 与 arr[1] 的值\n', '普通方括号原样输出');
}

// ============ 2. 节拍解析（emotion.js） ============
section('emotion.js createBeatParser 节拍/情绪/日程');
const emotion = require(path.join(ROOT, 'src/main/services/emotion'));

{
  // 旧格式兼容：仅末尾 [情绪:XX]
  const r = emotion.parseAndStrip('今天也要加油哦！\n[情绪:开心]');
  eq(r.clean, '今天也要加油哦！', '旧格式 clean');
  eq(r.emotion, 'happy', '旧格式兜底情绪');
  eq(r.beats, [], '旧格式无节拍');
}

{
  // 旧格式 + 日程标签
  const r = emotion.parseAndStrip('好呀，那就明天见！\n[日程:{"title":"见面","kind":"event","start":"2026-09-23 10:00"}]\n[情绪:开心]');
  eq(r.emotion, 'happy', '日程+情绪共存');
  eq(r.schedule && r.schedule.title, '见面', '日程解析');
  ok(!r.clean.includes('日程'), '日程标签已剥离');
}

{
  // 新节拍协议：按句绑定（协议式摆法：标签在句末标点前）
  const r = emotion.parseAndStrip('今天天气真好[开心]！我们出去玩吧[思考]。去哪里好呢？[情绪:思考]');
  eq(r.clean, '今天天气真好！我们出去玩吧。去哪里好呢？', '短标签从正文剥离');
  eq(r.beats, [{ s: 0, e: 'happy' }, { s: 1, e: 'thinking' }], '节拍按句落位');
  eq(r.emotion, 'thinking', '末尾兜底保留');
}

{
  // 边界摆法（标签在句号后）：归刚结束的前一句（显示完成时刻即触发）
  const r = emotion.parseAndStrip('第一句。[开心]第二句呢[思考]，继续。[情绪:开心]');
  eq(r.clean, '第一句。第二句呢，继续。', '边界标签剥离');
  eq(r.beats, [{ s: 0, e: 'happy' }, { s: 1, e: 'thinking' }], '句号后标签归前句、句中标签归所在句');
}

{
  // 流式逐字符：半截标签不泄漏（句中错置标签在流式 hint 中照样实时触发）
  const src = '第一句。[开心]第二句呢[思考]，继续。[情绪:开心]';
  const p = emotion.createBeatParser();
  let clean = '', hints = [];
  for (const ch of src) {
    const r = p.feed(ch);
    clean += r.cleanDelta;
    hints.push(...r.beatHints);
  }
  const fl = p.flush();
  clean += fl.cleanDelta;
  eq(clean, '第一句。第二句呢，继续。', '流式 clean 无标签泄漏');
  eq(hints, ['happy', 'thinking'], '流式节拍 hint 实时剥出');
  eq(fl.emotion, 'happy', '流式兜底情绪');
  eq(fl.beats, [{ s: 0, e: 'happy' }, { s: 1, e: 'thinking' }], '流式句归属与非流式一致');
}

{
  // 日程 JSON 跨 chunk
  const p = emotion.createBeatParser();
  const r1 = p.feed('定了哦[日程:{"title":"牙医","kind":"event","start":"2026-09-2');
  eq(r1.cleanDelta, '定了哦', '日程 JSON 模式 hold（不泄漏半截）');
  const r2 = p.feed('3 14:30"}]到时候叫我\n[情绪:平常]');
  ok(r2.cleanDelta.startsWith('到时候叫我'), '日程标签闭合后正文放行');
  const fl = p.flush();
  eq(fl.schedule && fl.schedule.start, '2026-09-23 14:30', '跨 chunk 日程完整解析');
  eq(fl.clean, '定了哦到时候叫我', '最终 clean');
}

{
  // 同句多标签取最后一个
  const r = emotion.parseAndStrip('哇[惊讶][开心]太棒了！');
  eq(r.beats, [{ s: 0, e: 'happy' }], '同句多标签取最后');
}

{
  // 超长未闭合 [日程: 放行为正文（>500）
  const p = emotion.createBeatParser();
  p.feed('x[日程: ' + 'y'.repeat(600));
  const fl = p.flush();
  ok(fl.clean.includes('[日程:'), '超长未闭合日程按正文放行');
  eq(fl.schedule, null, '未闭合不产生日程');
}

// ============ 3. 差分归因（trace.js） ============
section('agent/trace.js 快照/差分/ambiguous');
const guard = require(path.join(ROOT, 'src/main/services/fs-guard'));
const traceMod = require(path.join(ROOT, 'src/main/services/agent/trace'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-agent-test-'));
guard.setUserDataDir(TMP);
fs.mkdirSync(path.join(TMP, 'temp'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'config'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'temp', 'a.md'), 'line1\nline2\nline3\n', 'utf8');
fs.writeFileSync(path.join(TMP, 'config', 'settings.json'), '{"v":1}', 'utf8');

{
  const tr = traceMod.createTracer();
  tr.captureBaseline();
  // 工具写：覆盖 a.md
  tr.captureBeforeWrite(path.join(TMP, 'temp', 'a.md'));
  fs.writeFileSync(path.join(TMP, 'temp', 'a.md'), 'line1\nCHANGED\nline3\n', 'utf8');
  tr.recordToolWrite(path.join(TMP, 'temp', 'a.md'));
  // 工具外变更：新建 b.txt
  fs.writeFileSync(path.join(TMP, 'temp', 'b.txt'), 'new file', 'utf8');
  const r = tr.finalizeRun();
  eq(r.changed.length, 2, '两条变更（工具+工具外）');
  const a = r.changed.find(c => c.path.endsWith('a.md'));
  const b = r.changed.find(c => c.path.endsWith('b.txt'));
  eq(a.origin, 'tool', '工具写入归因 tool');
  eq(a.kind, 'overwrite', '覆盖类型');
  eq(a.hunks, [{ aStart: 1, aLines: ['line2'], bStart: 1, bLines: ['CHANGED'] }], 'LCS 行级 hunk');
  eq(b.origin, 'ambiguous', '工具外变更标 ambiguous');
  eq(b.kind, 'create', '新建类型');
  eq(r.hasAmbiguous, true, 'ambiguous 警示位');
}

{
  // 新建文件 diff：before 不存在
  const tr = traceMod.createTracer();
  tr.captureBaseline();
  const p2 = path.join(TMP, 'temp', 'new.md');
  tr.captureBeforeWrite(p2);
  fs.writeFileSync(p2, '- 买牛奶\n- 买咖啡\n', 'utf8');
  tr.recordToolWrite(p2);
  const r = tr.finalizeRun();
  const c = r.changed[0];
  eq(c.kind, 'create', '新建 kind');
  eq(c.hunks, [{ aStart: 0, aLines: [], bStart: 0, bLines: ['- 买牛奶', '- 买咖啡', ''] }], '新建全文为增行（含末行换行的空尾行）');
}

// ============ 3.5 权限模式（fs-guard 三档） ============
section('fs-guard 三档权限模式');
{
  const os = require('os');
  const udFile = path.join(TMP, 'temp', 'x.md');
  guard.setWriteMode('read');
  ok(guard.canWrite(udFile) === false, 'read：数据目录内也不可写');
  guard.setWriteMode('userData');
  ok(guard.canWrite(udFile) === true, 'userData：数据目录内可写');
  ok(guard.canWrite('C:\\Windows\\notepad.exe') === false, 'userData：系统目录不可写');
  guard.setWriteMode('full');
  ok(guard.canWrite(udFile) === true, 'full：数据目录内仍可写');
  ok(guard.canWrite('C:\\Windows\\system32\\evil.dll') === false, 'full：Windows 目录拒绝');
  ok(guard.canWrite('C:\\Program Files\\app\\x.dll') === false, 'full：Program Files 拒绝');
  ok(guard.canWrite('C:\\ProgramData\\app\\cfg.json') === false, 'full：ProgramData 拒绝');
  ok(guard.canWrite('C:\\autoexec.bat') === false, 'full：盘根直下文件拒绝');
  ok(guard.canWrite('\\\\server\\share\\f.txt') === false, 'full：UNC 网络路径拒绝');
  ok(guard.canWrite(path.join(TMP, '..', 'another-app', 'cfg.ini')) === true, 'full：数据目录外的本机用户区（LOCALAPPDATA）可写');
  const home = os.homedir();
  ok(guard.canWrite(path.join(home, 'Desktop', 'note.txt')) === true, 'full：当前用户桌面可写');
  // 其他用户 profile（构造一个不存在的用户名路径，不会命中 realpath）
  const drive = home.slice(0, 2);
  ok(guard.canWrite(drive + '\\Users\\someotheruser\\Documents\\x.txt') === false, 'full：其他用户目录拒绝');
  ok(guard.canWrite(path.join(TMP, 'books', 'normal.txt')) === true, 'full：普通文件可写（对照）');
  ok(guard.canWrite(path.join(home, 'Login Data')) === false, 'full：敏感文件（Login Data）任何模式拒绝');
  guard.setWriteMode('read'); // 还原，避免影响后续断言
}

// ============ 4. run 台账（runs.js） ============
section('agent/runs.js 台账与中断恢复');
const store = require(path.join(ROOT, 'src/main/services/store'));
store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-store-test-')));
const runs = require(path.join(ROOT, 'src/main/services/agent/runs'));

{
  const id1 = runs.newRunId(), id2 = runs.newRunId();
  runs.append({ id: id1, status: 'running', instruction: '任务A' });
  runs.append({ id: id2, status: 'done', instruction: '任务B' });
  runs.update({ id: id1, status: 'done', instruction: '任务A', finalReply: 'ok' });
  const q = runs.query({});
  eq(q.runs.length, 2, 'update 不增加行数');
  ok(q.runs[0].id === id2 || q.runs[0].id === id1, '查询返回记录');
  eq(q.runs.find(r => r.id === id1).status, 'done', 'update 按 id 替换');

  // 中断恢复：手工塞一条 running（模拟崩溃残留）
  runs.append({ id: 'run_x', status: 'running', instruction: '崩溃任务' });
  const rec = runs.markInterruptedOnBoot();
  eq(rec.interrupted, 1, 'running 记录数');
  const q2 = runs.query({});
  eq(q2.runs.find(r => r.id === 'run_x').status, 'interrupted', 'running → interrupted');
}

// ============ 5. 工具注册表 ============
section('agent/tools.js+builtin.js 注册表');
const tools = require(path.join(ROOT, 'src/main/services/agent/builtin'));

{
  const list = tools.list();
  eq(list.map(t => t.name).sort(), ['list_dir', 'read_file', 'write_file'], '三件套注册');
  const wf = list.find(t => t.name === 'write_file');
  ok(wf.enabled, 'write_file 已转正启用');
  ok(wf.params.reason, 'write_file 含 reason 参数');
  const schemas = tools.openAiSchemas();
  eq(schemas.length, 3, 'OpenAI schema 数量');
  const wfSchema = schemas.find(s => s.function.name === 'write_file');
  ok(wfSchema.function.parameters.properties.reason, 'schema 含 reason');
  ok(wfSchema.function.parameters.required.includes('reason'), 'reason 为必填');
}

// ============ 6. 熔断/权限纯逻辑（间接：denyStreak 语义在 loop，这里验证 permissions fail-closed） ============
section('agent/permissions.js fail-closed（超时路径）');
// permissions 依赖 windows(electron)，纯 Node 下 getWindow 返回 null → send 安全跳过；
// 超时最小 10s，这里只验证「未注册请求 resolve 返回 false」的幂等性。
{
  const permissions = require(path.join(ROOT, 'src/main/services/agent/permissions'));
  ok(permissions.resolveRequest('nope', 'allow_once') === false, '未知请求结算返回 false');
  ok(permissions.countPending() === 0, '无挂起请求');
}

console.log(`\n========== 测试结果：${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
