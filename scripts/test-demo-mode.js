// ★v0.6.2 回归测试：演示模式（/demo 族命令、会话级状态机、system 末尾状态块注入、
// 行为差异注入、canon 前缀不变、打字机速度持久化、重启状态重置、记忆 demo 来源标记）。
// 用法：node scripts/test-demo-mode.js（纯 Node，LLM/electron 依赖打桩）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SVC = p => path.join(ROOT, 'src/main/services', p);

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); }
  return fn();
}

(async function main() {

// ---- 环境：隔离 userData ----
const store = require(SVC('store'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-demo-test-'));
store.init(dataDir);
store.flushAll();

const chat = require(SVC('chat'));
const prompts = require(SVC('prompts'));
const memory = require(SVC('memory'));
const sessions = require(SVC('sessions'));
const demoMode = require(SVC('demo-mode'));
const llm = require(SVC('llm'));
const emotion = require(SVC('emotion'));
const hindsight = require(SVC('hindsight-bridge'));

// 打桩：纯 Node 环境不出网、不碰 electron 窗口；agent 关闭走 plainTurn（streamChat 打桩只喂 onChunk）
store.set('settings', { agent: { enabled: false } });
llm.streamChat = async (o) => { mainLastMessages = o.messages; o.onChunk && o.onChunk('收到，说事！[情绪:平常]'); };
llm.genericCompletion = async () => '[]';
emotion.broadcastEmotion = () => {};
hindsight.recall = async () => [];
hindsight.retain = async () => {};
let mainLastMessages = null;
const MAIN = sessions.active().id;
chat.getHistory('roleplay'); // 触发 sessions.ensure()

// ============ 1. 命令识别 ============
section('isCommand：/demo 族命中与不命中');
{
  ok(demoMode.isCommand('/demo') === true, '标准形式命中');
  ok(demoMode.isCommand('/ demo') === true, '斜杠后带空格命中');
  ok(demoMode.isCommand('  /DEMO  ') === true, '大小写/首尾空白命中');
  ok(demoMode.isCommand('/demo off') === true, 'off 子命令命中');
  ok(demoMode.isCommand('/demo speed -150') === true, 'speed 子命令命中');
  ok(demoMode.isCommand('/demo status') === true, 'status 子命令命中');
  ok(demoMode.isCommand('/demox') === false, '无空格后缀不命中（防误伤 /demox 之类输入）');
  ok(demoMode.isCommand('/demoff') === false, '连写不命中');
  ok(demoMode.isCommand('demo') === false, '缺斜杠不命中');
  ok(demoMode.isCommand('/demo一下') === false, '中文直连后缀不命中');
  ok(demoMode.isCommand('') === false, '空串不命中');
}

// ============ 2. 状态机：进入/退出/status/轮次 ============
section('execute：进入与不重复进入');
{
  const r1 = demoMode.execute('/demo');
  ok(r1.ok && r1.changed && r1.transition === 'on', '进入演示模式（transition=on）');
  ok(r1.state.on === true && r1.state.rounds === 0, '进入后 rounds=0');
  ok(r1.message.includes('演示模式已开启'), '回执说明已开启');
  const r2 = demoMode.execute('/demo');
  ok(r2.ok && !r2.changed && !r2.transition, '已在演示中 → 不重复进入');
  ok(r2.message.includes('已在演示模式'), '回执提示当前状态');
}

section('execute：轮次计数与 /demo status');
{
  eq(demoMode.bumpRound(), 1, '演示中 bumpRound → 1');
  eq(demoMode.bumpRound(), 2, '再 bump → 2');
  const rs = demoMode.execute('/demo status');
  ok(rs.message.includes('已持续 2 轮'), 'status 回执带轮次');
  ok(rs.message.includes('/demo off'), 'status 回执带退出方式');
  eq(rs.state.rounds, 2, 'state.rounds=2');
}

section('execute：退出与重复退出');
{
  const r = demoMode.execute('/demo off');
  ok(r.ok && r.changed && r.transition === 'off', '退出（transition=off）');
  ok(r.message.includes('共 2 轮'), '退出回执汇总轮次');
  const r2 = demoMode.execute('/demo off');
  ok(r2.ok && !r2.changed, '不在演示中再 off → 无变化');
  ok(r2.message.includes('当前不在演示模式'), '重复退出有提示');
  demoMode.execute('/demo'); demoMode.execute('/demo off'); // 回到干净态
}

// ============ 3. 打字机速度（持久化设置） ============
section('speed：设置/夹取/非法值');
{
  eq(demoMode.getSpeed(), 300, '缺省速度 300 字/分钟');
  const r = demoMode.execute('/demo speed -150');
  ok(r.ok && !r.changed, 'speed 命令不切换演示状态');
  eq(demoMode.getSpeed(), 150, '/demo speed -150 → 150');
  ok(r.message.includes('150') && r.message.includes('重启'), '回执说明全局生效且重启保持');
  demoMode.execute('/demo speed 150'); // 不带 - 同样接受
  eq(demoMode.getSpeed(), 150, '/demo speed 150（无横线）同样接受');
  demoMode.execute('/demo speed 999999');
  eq(demoMode.getSpeed(), 3000, '超上限夹取到 3000');
  demoMode.execute('/demo speed 1');
  eq(demoMode.getSpeed(), 20, '低于下限夹取到 20');
  const bad = demoMode.execute('/demo speed abc');
  ok(bad.ok === false && bad.message.includes('失败'), '非法速度回执失败（不落入「进入演示」分支）');
  store.flushAll(); // 防抖落盘（200ms）→ 强制写出后再读
  const settingsDoc = JSON.parse(fs.readFileSync(path.join(dataDir, 'config', 'settings.json'), 'utf8'));
  eq(settingsDoc.demo && settingsDoc.demo.speed, 20, '速度落盘 settings.json（重启保持的数据源）');
  ok(!('on' in (settingsDoc.demo || {})) && !('rounds' in (settingsDoc.demo || {})), '开关/轮次不落盘（会话级内存态）');
  demoMode.setSpeed(300);
}

// ============ 4. 会话隔离 ============
section('会话级状态：A 会话演示、B 会话不受影响');
{
  demoMode.execute('/demo', 's_A');
  ok(demoMode.isOn('s_A') === true && demoMode.isOn('s_B') === false, 'A 开 B 不开');
  demoMode.bumpRound('s_A'); demoMode.bumpRound('s_A');
  const snapB = demoMode.snapshot('s_B');
  ok(snapB.on === false && snapB.rounds === 0, 'B 的快照干净');
  eq(demoMode.snapshot('s_A').rounds, 2, 'A 计 2 轮');
  demoMode.execute('/demo off', 's_A');
  ok(demoMode.isOn('s_A') === false, 'A 退出');
}

// ============ 5. 状态块注入（system 末尾 + 完全移除 + canon 前缀不变） ============
section('buildMessages：演示中状态块在 system 最末');
{
  demoMode.execute('/demo', MAIN);
  demoMode.bumpRound(MAIN);
  const hist = [
    { id: 'm1', role: 'user', content: '你好' },
    { id: 'm2', role: 'assistant', content: '嗯，说事。' },
  ];
  const out = chat.buildMessages('roleplay', hist);
  const sys = out[0].content;
  ok(sys.includes('[DEMO_MODE: ON | 已持续 1 轮 | 退出命令 /demo off]'), '状态行格式正确且轮次对齐');
  const lines = sys.trimEnd().split('\n');
  eq(lines[lines.length - 1].trim(), '[DEMO_MODE: ON | 已持续 1 轮 | 退出命令 /demo off]', '状态行是 system 的最后一段');
  ok(sys.includes('主动推进') && sys.includes('术语'), '行为差异（主动推进/术语降级）注入');
  ok(sys.includes('压缩约 30%'), '节奏加快注入');
  ok(sys.includes('打字机'), '打字机标识注入');
  ok(sys.includes('诚实高于顺从不变') && sys.includes('不得为了演示效果编造事实'), '红线重申（不是表演模式）');
  ok(sys.includes('演示模式') && sys.includes('/demo off'), '自述口径与退出方式可供模型回答「你现在处于什么模式」');
}
section('buildMessages：四条差异之外 system 前缀完全一致（canon/记忆/档案不动）');
{
  const hist = [{ id: 'm1', role: 'user', content: '你好' }];
  const withDemo = chat.buildMessages('roleplay', hist, { demo: demoMode.blockFor(MAIN) })[0].content;
  const off = demoMode.execute('/demo off', MAIN);
  ok(off.transition === 'off', '先退出');
  const without = chat.buildMessages('roleplay', hist, { demo: demoMode.blockFor(MAIN) })[0].content;
  ok(withDemo.startsWith(without), '演示版 system = 普通版 + 末尾追加（前缀逐字节一致）');
  ok(without.includes('禁忌条款') && without.includes('人格宪法'), '普通版仍含宪法锁层');
  eq(without.includes('DEMO_MODE'), false, '关闭后状态块完全移除');
  eq(without.includes('演示模式'), false, '关闭后无「演示模式」字样残留');
  eq(without.includes('demo off'), false, '关闭后无退出命令残留');
  const quick = chat.buildMessages('quick', hist)[0].content;
  eq(quick.includes('DEMO_MODE'), false, '速问标签永不注入（演示模式仅 roleplay）');
  demoMode.execute('/demo', MAIN); // 回到开启供后续用例
}

// ============ 6. chat.send 集成：轮次自增 + 消息带 demo 标 ============
section('send：演示中一轮对话（轮次/消息标/状态块随轮更新）');
{
  const rounds0 = demoMode.snapshot(MAIN).rounds;
  const p = chat.send('roleplay', '演示第一轮：介绍一下你自己');
  await p; // send 本身同步返回 reqId；流式轮后台跑
  ok(await waitFor(() => chat.getHistory('roleplay').some(m => m.role === 'assistant')), '回复落史');
  const h = chat.getHistory('roleplay');
  const lastUser = [...h].reverse().find(m => m.role === 'user');
  const lastAsst = [...h].reverse().find(m => m.role === 'assistant');
  ok(lastUser && lastUser.demo === true, '用户消息带 demo 标');
  ok(lastAsst && lastAsst.demo === true, '回复消息带 demo 标');
  eq(demoMode.snapshot(MAIN).rounds, rounds0 + 1, '轮次 +1');
  ok(Array.isArray(mainLastMessages) && mainLastMessages[0].content.includes(`已持续 ${rounds0 + 1} 轮`), '请求 system 带最新轮次的状态块');
}

// ============ 7. 开/关系统事件入史 ============
section('pushDemoNote：切换入史且进入角色上下文');
{
  chat.pushDemoNote('off');
  const h = chat.getHistory('roleplay');
  const note = h[h.length - 1];
  ok(note && note.demoNote === 'off' && note.role === 'user', 'off 注入为 user 消息（随历史进上下文）');
  ok(note.content.includes('演示模式已退出') && note.content.includes('普通模式'), 'off 注内容含「恢复普通模式」——关闭后模型仍能自述正确的模式');
  const out = chat.buildMessages('roleplay', h, { demo: demoMode.blockFor(MAIN) });
  ok(out.some(m => m.role === 'user' && m.content.includes('演示模式已退出')), 'off 注未被上下文组装剥离');
  chat.pushDemoNote('on');
  const h2 = chat.getHistory('roleplay');
  ok(h2[h2.length - 1].demoNote === 'on' && h2[h2.length - 1].content.includes('演示模式已开启'), 'on 注同样入史');
}

// ============ 8. 记忆 demo 来源标记 ============
section('memory：addMemory/mergeExtracted 带 demo 标');
{
  const it1 = memory.addMemory({ type: 'fact', content: '演示轮写入的记忆', importance: 3 }, { demo: true });
  ok(it1.demo === true, 'save_memory 路径（addMemory opts.demo）条目带 demo');
  const it2 = memory.addMemory({ type: 'fact', content: '普通记忆', importance: 3 });
  eq(it2.demo, undefined, '非演示写入不带 demo');
  memory.mergeExtracted([{ type: 'fact', content: '提取自演示窗口', importance: 3 }], { demo: true });
  const items = memory.listMemories();
  ok(items.some(i => i.content === '提取自演示窗口' && i.demo === true), '自动提取路径（mergeExtracted opts.demo）条目带 demo');
  memory.mergeExtracted([{ type: 'fact', content: '提取自普通窗口', importance: 3 }]);
  ok(memory.listMemories().some(i => i.content === '提取自普通窗口' && !i.demo), '普通提取不带 demo');
}
section('memoryTick：提取窗口含 demo 消息 → 落库带标；系统事件注不进提取输入');
{
  let extractPrompt = '';
  llm.genericCompletion = async (msgs) => {
    extractPrompt = msgs[0].content;
    return JSON.stringify([{ type: 'fact', content: '演示对话里的事实', importance: 4 }]);
  };
  const now = new Date().toISOString();
  const past = new Date(Date.now() - 3600e3).toISOString();
  const sess = sessions.active();
  sess.messages = [
    { id: 'x0', role: 'user', content: '演示前的旧消息', at: past },
    { id: 'x1', role: 'user', content: '演示中的消息', demo: true, at: now },
    { id: 'x2', role: 'assistant', content: '好', demo: true, at: now },
  ];
  sess.userCountSince = 6;
  sess.lastExtractAt = new Date(Date.now() - 1800e3).toISOString(); // 上次提取在演示消息之前
  store.replace('memory/roleplay', { items: [], archive: [] });
  await chat.memoryTick(true);
  const items = memory.listMemories();
  ok(items.some(i => i.content === '演示对话里的事实' && i.demo === true), '窗口内有 demo 消息 → 提取条目带 demo 标');
  ok(extractPrompt.includes('演示中的消息'), '演示消息进提取输入');
  ok(!extractPrompt.includes('[系统事件'), '系统事件注入（demoNote）不进提取输入');
  // 对照：无 demo 消息的窗口不标
  llm.genericCompletion = async () => JSON.stringify([{ type: 'fact', content: '普通窗口事实', importance: 4 }]);
  const sess2 = sessions.active();
  sess2.messages = [{ id: 'y1', role: 'user', content: '普通消息', at: now }];
  sess2.userCountSince = 6;
  sess2.lastExtractAt = new Date(Date.now() - 60e3).toISOString();
  await chat.memoryTick(true);
  ok(memory.listMemories().some(i => i.content === '普通窗口事实' && !i.demo), '普通窗口条目不带 demo');
  llm.genericCompletion = async () => '[]';
}

// ============ 9. 重启语义：状态重置、速度保持（子进程模拟重启） ============
section('重启：演示状态归零、速度从盘上恢复');
{
  demoMode.execute('/demo', MAIN);
  demoMode.bumpRound(MAIN); demoMode.bumpRound(MAIN);
  demoMode.execute('/demo speed -420', MAIN);
  store.flushAll();
  const probe = spawnSync(process.execPath, ['-e', `
    const store = require(${JSON.stringify(SVC('store'))});
    store.init(${JSON.stringify(dataDir)});
    const demoMode = require(${JSON.stringify(SVC('demo-mode'))});
    const s = demoMode.snapshot();
    console.log(JSON.stringify({ on: s.on, rounds: s.rounds, speed: s.speed }));
  `], { encoding: 'utf8' });
  if (probe.status !== 0) { ok(false, '子进程模拟重启失败：' + probe.stderr.slice(0, 200)); }
  else {
    const r = JSON.parse(probe.stdout.trim().split('\n').pop());
    eq(r.on, false, '重启后演示状态=关（内存态归零）');
    eq(r.rounds, 0, '重启后轮次=0');
    eq(r.speed, 420, '重启后速度仍为设置的 420（settings.json 恢复）');
  }
}

// ============ 10. 红线：宪法段不受演示影响（直接断言 demoBlock 独立成段） ============
section('红线：demoBlock 只增不改，canon 文本零触碰');
{
  const block = prompts.demoBlock({ on: true, rounds: 3 });
  ok(block.startsWith('\n【演示模式'), '注入段以【演示模式】开头（独立段落）');
  ok(block.trimEnd().endsWith('[DEMO_MODE: ON | 已持续 3 轮 | 退出命令 /demo off]'), '注入段以固定状态行收尾');
  eq(prompts.demoBlock(null), '', 'demo=null → 空串（完全移除的实现基础）');
  ok(!block.includes('宪法') || block.includes('完全不变'), '提及宪法只以「完全不变」的口径出现（不得暗示可绕过）');
  const canonView = require(SVC('canon')).view();
  ok(!!canonView.pet && !!canonView.user, 'canon 视图照常可读（未受演示模式影响）');
}

// ---- 收尾 ----
console.log(`\n========== 演示模式测试: ${passed} 通过, ${failed} 失败 ==========`);
if (failed) { process.exitCode = 1; }
})().catch(e => { console.error('测试运行异常:', e); process.exitCode = 1; });
