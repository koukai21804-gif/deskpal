// ★H v0.3 集成自测：agent/loop 执行循环端到端（桩 LLM + 桩权限等待，真实 fs/台账/差分）
// 用法：node scripts/test-agent-e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVC = p => path.join(ROOT, 'src/main/services', p);

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function section(t) { console.log('\n## ' + t); }

function eq(a, b, name) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  ok(ja === jb, `${name}${ja === jb ? '' : `（got ${ja}, want ${jb}）`}`);
}

(async function main() {

// ---- 环境：隔离 userData + 预置 settings/api ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-loop-e2e-'));
const store = require(SVC('store'));
store.init(TMP);
store.set('api', { endpoint: 'http://stub', model: 'stub', params: { maxTokens: 2048 } });
store.set('settings', { agent: { permissionMode: 'full' } }); // 用例 1/2/5/6 走权限卡路径

// ---- 桩：electron 依赖面（BrowserWindow 在纯 Node 下为 undefined）----
const emotion = require(SVC('emotion'));
emotion.broadcastEmotion = () => {}; // 打桩：跳过窗口广播

const llm = require(SVC('llm'));
const permissions = require(SVC('agent/permissions'));

// 每个用例配置一次 LLM 行为脚本（按调用序出牌）
let llmScript = [];
let llmCalls = [];
llm.streamChat = async ({ messages, onChunk, withTools }) => {
  llmCalls.push({ kind: 'stream', withTools, messages });
  const turn = llmScript.shift() || { content: '（空）', toolCalls: [], finishReason: 'stop' };
  // 逐小片喂正文（含跨 chunk 半截标记/标签），驱动剥离器状态机
  for (const piece of splitPieces(turn.content || '')) {
    if (onChunk) onChunk(piece, (turn.content || ''));
  }
  return withTools
    ? { content: turn.content || '', toolCalls: turn.toolCalls || [], finishReason: turn.finishReason || (turn.toolCalls && turn.toolCalls.length ? 'tool_calls' : 'stop') }
    : (turn.content || '');
};
llm.genericCompletion = async (messages, opts) => {
  llmCalls.push({ kind: 'generic', messages });
  const turn = llmScript.shift() || { content: '（空）', toolCalls: [] };
  return { content: turn.content || '', toolCalls: turn.toolCalls || [], finishReason: (turn.toolCalls && turn.toolCalls.length) ? 'tool_calls' : 'stop' };
};
llm.stop = () => {};

// 权限桩：可编程决策（allow_once / deny / hang=挂起 400ms 后按 stopped 了结，供打断测试）
let permDecision = 'allow_once';
let permCaptured = [];
permissions.request = async (opts) => {
  permCaptured.push(opts);
  if (permDecision === 'hang') {
    return new Promise(resolve => setTimeout(() => resolve({ id: 'perm_hang', decision: 'stopped' }), 400));
  }
  return { id: 'perm_stub_' + permCaptured.length, decision: permDecision };
};

function splitPieces(text) {
  // 把文本切成 3 字符一片，模拟慢速流式（半截标签跨 chunk）
  const out = [];
  for (let i = 0; i < text.length; i += 3) out.push(text.slice(i, i + 3));
  return out.length ? out : [''];
}

const loop = require(SVC('agent/loop'));
const runs = require(SVC('agent/runs'));

function baseMsgs() { return [{ role: 'system', content: 'sys' }, { role: 'user', content: '建个文件' }]; }

// ============ 用例 1：允许一次 → 写入 → diff → done ============
section('用例 1：写文件全链路（allow_once）');
{
  const todoPath = path.join(TMP, 'temp', 'todo.md');
  llmScript = [
    { // 第一轮：进展标记（跨 chunk 半截）+ 工具调用
      content: '我先规划一下。\n[进展:设计] 打算建 todo.md 写三条待办\n',
      toolCalls: [{ id: 'c1', name: 'write_file', argsRaw: JSON.stringify({ path: todoPath, content: '- 买牛奶\n- 寄快递\n- 复习日语\n', reason: '用户要求建立今日待办清单' }) }],
      finishReason: 'tool_calls',
    },
    { // 第二轮：最终回复（短标签节拍 + 兜底情绪）
      content: '已经帮你建好啦[开心]！去 temp 里看 todo.md 吧。[情绪:开心]',
      finishReason: 'stop',
    },
  ];
  permDecision = 'allow_once';
  permCaptured = [];
  llmCalls = [];

  let donePayload = null, finalFl = null;
  const p = loop.startRun({
    reqId: 'chat_e2e_1', instruction: '在 temp 建 todo.md', baseMessages: baseMsgs(),
    onFinal: async (fl) => { finalFl = fl; return { msgId: 'm_e2e_1' }; },
    onDone: (x) => { donePayload = x; },
    onAborted: () => { ok(false, '不应触发 abort'); },
    onError: (e) => { ok(false, '不应触发 error: ' + e.message); },
  });
  await p;

  ok(fs.existsSync(todoPath), 'temp/todo.md 真实写入');
  ok(fs.readFileSync(todoPath, 'utf8').includes('买牛奶'), '写入内容正确');
  ok(permCaptured.length === 1 && permCaptured[0].action === '新建文件', '权限卡请求：新建文件');
  ok(String(permCaptured[0].detail).includes('todo.md'), '权限卡 detail 含文件名与字节');
  ok(permCaptured[0].reversibility.includes('可删'), 'reversibility 文案');
  ok(finalFl && finalFl.clean === '我先规划一下。\n已经帮你建好啦！去 temp 里看 todo.md 吧。', '最终 clean（整 run 累积：叙述 + 最终回复，标记与标签全剥离）');
  eq(finalFl.beats, [{ s: 1, e: 'happy' }], '节拍绑定（跨轮累积 clean 的第 2 句）');
  ok(donePayload && donePayload.runId, 'onDone 带 runId');
  const ch = (donePayload.changes || []).find(c => c.path === todoPath);
  ok(ch && ch.origin === 'tool' && ch.kind === 'create', '差分归因 tool/create');
  ok(ch && ch.hunks.some(h => h.bLines.some(l => l.includes('买牛奶'))), 'diff hunk 含新增行');

  const q = runs.query({});
  const rec = q.runs.find(r => r.reqId === 'chat_e2e_1');
  ok(rec && rec.status === 'done', 'run 记录 done');
  ok(rec.steps.some(s => s.kind === 'progress' && s.phase === '设计'), '台账含进展步骤');
  ok(rec.steps.some(s => s.kind === 'permission' && s.decision === 'allow_once'), '台账含权限步骤');
  ok(rec.steps.some(s => s.kind === 'tool' && s.tool === 'write_file' && s.ok === true), '台账含工具步骤');
  ok(rec.finalReply.includes('建好啦'), '台账含最终回复');

  // 工具结果消息格式（role=tool + tool_call_id + 截断 JSON）
  const round2 = llmCalls[1];
  const toolMsg = round2 && round2.messages.find(m => m.role === 'tool');
  ok(toolMsg && toolMsg.tool_call_id === 'c1' && toolMsg.content.includes('已写入'), 'tool result 消息回填');
  const asstMsg = round2 && round2.messages.find(m => m.role === 'assistant' && m.tool_calls);
  ok(asstMsg && asstMsg.tool_calls[0].function.name === 'write_file', 'assistant tool_calls 消息');
}

// ============ 用例 2：拒绝 → 模型收到拒绝 → denied 熔断 ============
section('用例 2：连续拒绝与熔断');
{
  const target = path.join(TMP, 'temp', 'deny.md');
  llmScript = [
    { content: '试试写。', toolCalls: [{ id: 'c1', name: 'write_file', argsRaw: JSON.stringify({ path: target, content: 'x', reason: '测试' }) }], finishReason: 'tool_calls' },
    { content: '再试试。', toolCalls: [{ id: 'c2', name: 'write_file', argsRaw: JSON.stringify({ path: target, content: 'x', reason: '测试2' }) }], finishReason: 'tool_calls' },
    { content: '好的，那我不写了，需要的话你手动来。[情绪:平常]', finishReason: 'stop' },
  ];
  permDecision = 'deny';
  permCaptured = [];
  llmCalls = [];

  let donePayload = null;
  await loop.startRun({
    reqId: 'chat_e2e_2', instruction: '写 deny.md', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: (x) => { donePayload = x; }, onAborted: () => {}, onError: (e) => { ok(false, 'deny 路径不应 error: ' + e.message); },
  });

  ok(!fs.existsSync(target), '拒绝后无文件产生');
  ok(permCaptured.length === 2, '两次权限卡（第三次熔断不再发卡）');
  const r3 = llmCalls[2].messages;
  ok(r3.some(m => m.role === 'tool' && m.content.includes('拒绝了这次写入')), '模型收到拒绝 result');
  ok(r3.some(m => m.role === 'system' && m.content.includes('两次拒绝')), '熔断 system 提示注入');
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_2');
  ok(rec.status === 'denied', 'run 记录 denied');
}

// ============ 用例 3：假完成检测（说做了但没调工具）→ 重试一次 ============
section('用例 3：假完成有界重试');
{
  llmScript = [
    { content: '我已经帮你把文件建好了！[进展:能力] todo.md 已生成\n[情绪:开心]', finishReason: 'stop' }, // 零工具 + 有进展标记 → 触发重试
    { content: '好吧我 actually 还没动手。', toolCalls: [{ id: 'c1', name: 'list_dir', argsRaw: JSON.stringify({ path: path.join(TMP, 'temp') }) }], finishReason: 'tool_calls' },
    { content: '现在真的看过了。[情绪:思考]', finishReason: 'stop' },
  ];
  permDecision = 'allow_once';
  llmCalls = [];
  let finalFl = null;
  await loop.startRun({
    reqId: 'chat_e2e_3', instruction: '整理目录', baseMessages: baseMsgs(),
    onFinal: async (fl) => { finalFl = fl; return {}; }, onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '重试路径不应 error: ' + e.message); },
  });
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_3');
  ok(rec.retries === 1, '重试计数 = 1');
  ok(rec.steps.some(s => s.kind === 'notice' && s.notice === 'retry'), 'notice 步骤入台账');
  ok(llmCalls.length === 3, '共 3 轮 LLM 调用（1 假完成 + 1 重试 + 1 收尾）');
  ok(finalFl.clean.includes('现在真的看过了'), '重试后正文为准');
  ok(rec.steps.some(s => s.kind === 'tool' && s.tool === 'list_dir' && s.ok), '重试轮实际执行了工具');
}

// ============ 用例 4：轮次上限收尾 ============
section('用例 4：maxRounds 上限');
{
  store.set('settings', { agent: { maxRounds: 4, permissionMode: 'full' } }); // clamp 下限为 4
  const endless = { content: '继续。', toolCalls: [{ id: 'cx', name: 'list_dir', argsRaw: JSON.stringify({ path: path.join(TMP, 'temp') }) }], finishReason: 'tool_calls' };
  llmScript = [endless, endless, endless, endless, { content: '收到，基于现有结果作答完毕。[情绪:平常]', finishReason: 'stop' }];
  llmCalls = [];
  let donePayload = null;
  await loop.startRun({
    reqId: 'chat_e2e_4', instruction: '无限工具', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: (x) => { donePayload = x; }, onAborted: () => {}, onError: (e) => { ok(false, '上限路径不应 error: ' + e.message); },
  });
  ok(llmCalls.length === 5, `共 5 轮 LLM 调用（4 决策轮 + 1 收尾轮），got ${llmCalls.length}`);
  const capMsgs = llmCalls[4].messages;
  ok(capMsgs.some(m => m.role === 'system' && m.content.includes('上限')), '超上限注入收尾 system');
  ok(!llmCalls[4].withTools, '收尾轮不带工具（纯流式作答）');
  ok(donePayload && donePayload.clean.includes('作答完毕'), '收尾作答');
  store.set('settings', { agent: { maxRounds: 8, permissionMode: 'full' } });
}

// ============ 用例 5：epoch 打断（权限挂起中点停止） ============
section('用例 5：epoch 打断');
{
  const target = path.join(TMP, 'temp', 'abort-test.md');
  llmScript = [
    { content: '准备写入。', toolCalls: [{ id: 'c1', name: 'write_file', argsRaw: JSON.stringify({ path: target, content: 'half', reason: '打断测试' }) }], finishReason: 'tool_calls' },
  ];
  permDecision = 'hang'; // 权限卡永不决 → 挂起等待
  let abortedPayload = null, doneCalled = false;
  const p = loop.startRun({
    reqId: 'chat_e2e_5', instruction: '写入后打断', baseMessages: baseMsgs(),
    onFinal: async () => { ok(false, 'abort 后不应 onFinal'); return {}; },
    onDone: () => { doneCalled = true; },
    onAborted: (x) => { abortedPayload = x; },
    onError: () => { ok(false, 'abort 不应走 error'); },
  });
  await new Promise(r => setTimeout(r, 150)); // 等 loop 进入权限等待
  loop.abortRun('chat_e2e_5');
  await p; // 权限桩 400ms 后按 stopped 了结 → loop 检测 stale 静默退出

  ok(!!abortedPayload, 'onAborted 被调用');
  ok(!doneCalled, 'abort 后不再 onDone');
  ok(!fs.existsSync(target), '挂起的写入未发生');
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_5');
  ok(rec && rec.status === 'aborted', 'run 记录 aborted');
}

// ============ 用例 6：fs-guard 黑名单写入被拒 ============
section('用例 6：fs-guard 越界写入');
{
  llmScript = [
    { content: '试图写系统盘。', toolCalls: [{ id: 'c1', name: 'write_file', argsRaw: JSON.stringify({ path: 'C:\\Windows\\dp-test-x.md', content: 'x', reason: '越界' }) }], finishReason: 'tool_calls' },
    { content: '好吧，写不了。[情绪:悲伤]', finishReason: 'stop' },
  ];
  permDecision = 'allow_once'; // 即使用户允许，fs-guard 仍拒绝（双保险）
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_e2e_6', instruction: '写系统目录', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '越界路径不应炸 run: ' + e.message); },
  });
  const toolMsg = llmCalls[1].messages.find(m => m.role === 'tool');
  ok(toolMsg && toolMsg.content.includes('写入被拒绝'), 'fs-guard 拒绝作为工具 result 回填');
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_6');
  ok(rec.status === 'done', '越界拒绝后 run 正常收尾');
}

// ============ 用例 7：三档权限模式 ============
section('用例 7a：userData 模式——数据目录内直写（无权限卡）');
{
  store.set('settings', { agent: { permissionMode: 'userData' } });
  const target = path.join(TMP, 'temp', 'mode-ud.md');
  let cardAsked = 0;
  const origReq = permissions.request;
  permissions.request = async (opts) => { cardAsked++; return { id: 'p', decision: 'allow_once' }; };
  llmScript = [
    { content: '写入。', toolCalls: [{ id: 'c1', name: 'write_file', argsRaw: JSON.stringify({ path: target, content: 'ud-mode', reason: '模式测试' }) }], finishReason: 'tool_calls' },
    { content: '写好了。[情绪:开心]', finishReason: 'stop' },
  ];
  llmCalls = [];
  let donePayload = null;
  await loop.startRun({
    reqId: 'chat_e2e_7a', instruction: '建 mode-ud.md', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: (x) => { donePayload = x; }, onAborted: () => {}, onError: (e) => { ok(false, '7a 不应 error: ' + e.message); },
  });
  ok(fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'ud-mode', '数据目录内文件直写成功');
  ok(cardAsked === 0, '不弹权限卡（模式选择即授权）');
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_7a');
  ok(rec && !rec.steps.some(s => s.kind === 'permission'), '台账无权限步骤');
  ok(rec && rec.steps.some(s => s.kind === 'tool' && s.ok === true), '工具步骤 ok');
  ok(rec && rec.mode === 'userData', 'run 记录 mode=userData');
  ok(!!(donePayload.changes || []).find(c => c.path === target), 'diff 卡照常带出变更');

  // 数据目录外目标：无卡直接被 fs-guard 拒
  const outside = path.join(TMP, '..', 'mode-escape.md');
  llmScript = [
    { content: '试试外面。', toolCalls: [{ id: 'c2', name: 'write_file', argsRaw: JSON.stringify({ path: outside, content: 'x', reason: '越界' }) }], finishReason: 'tool_calls' },
    { content: '不行。[情绪:悲伤]', finishReason: 'stop' },
  ];
  await loop.startRun({
    reqId: 'chat_e2e_7a2', instruction: '写数据目录外', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '7a2 不应 error: ' + e.message); },
  });
  const rec2 = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_7a2');
  const t2 = rec2 && rec2.steps.find(s => s.kind === 'tool' && s.tool === 'write_file');
  ok(t2 && t2.ok === false, '数据目录外写入被 fs-guard 拒（ok=false）');
  ok(!fs.existsSync(outside), '越界文件未产生');
  permissions.request = origReq;
}

section('用例 7b：read 模式——write 工具不下发 + 兜底拦截');
{
  store.set('settings', { agent: { permissionMode: 'read' } });
  const target = path.join(TMP, 'temp', 'mode-read.md');
  llmScript = [
    // 模型幻觉调用 write_file（正常情况下 schema 里没有，这里测兜底）
    { content: '我写一下。', toolCalls: [{ id: 'c1', name: 'write_file', argsRaw: JSON.stringify({ path: target, content: 'x', reason: 'r' }) }], finishReason: 'tool_calls' },
    { content: '好的，只读模式下我说明情况。[情绪:平常]', finishReason: 'stop' },
  ];
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_e2e_7b', instruction: '写 mode-read.md', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '7b 不应 error: ' + e.message); },
  });
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_7b');
  ok(rec && rec.mode === 'read', 'run 记录 mode=read');
  const t = rec && rec.steps.find(s => s.kind === 'tool' && s.tool === 'write_file');
  ok(t && t.ok === false, '幻觉写调用被兜底拦截（ok=false）');
  ok(!fs.existsSync(target), 'read 模式无文件产生');
  const toolMsg = llmCalls[1] && llmCalls[1].messages.find(m => m.role === 'tool');
  ok(toolMsg && toolMsg.content.includes('只读'), '模型收到只读模式说明');
  store.set('settings', { agent: { permissionMode: 'full' } }); // 还原
}

function eq(a, b, name) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  ok(ja === jb, `${name}${ja === jb ? '' : `（got ${ja}, want ${jb}）`}`);
}

console.log(`\n========== 集成测试结果：${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
})();
