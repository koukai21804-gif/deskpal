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
llm.streamChat = async ({ messages, onChunk, withTools, overrides, onUsage }) => {
  llmCalls.push({ kind: 'stream', withTools, overrides, messages });
  const turn = llmScript.shift() || { content: '（空）', toolCalls: [], finishReason: 'stop' };
  // 故障注入（P1-8）：__throwOverflow 模拟上游 400 上下文溢出（带 contextOverflow 标记）
  if (turn.__throwOverflow) {
    const e = new Error('对话长度超出模型的上下文窗口');
    e.contextOverflow = true;
    throw e;
  }
  // DeepSeek 思考模式服务端校验（20261002 run_mupxfru8_1 事故回归闸）：
  // 最后一条 user 之后的 assistant 消息缺失非空 reasoning_content → 400。
  // 零字节断流轮若被推成空 assistant，这里立即复现真实故障。
  {
    let lastUser = -1;
    messages.forEach((m, i) => { if (m.role === 'user') lastUser = i; });
    for (let i = lastUser + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'assistant' && !String(m.reasoning_content || '').trim()) {
        const e = new Error('接口返回 400：The `reasoning_content` in the thinking mode must be passed back to the API.');
        e.userMsg = e.message;
        throw e;
      }
    }
  }
  // 逐小片喂正文（含跨 chunk 半截标记/标签），驱动剥离器状态机
  for (const piece of splitPieces(turn.content || '')) {
    if (onChunk) onChunk(piece, (turn.content || ''));
  }
  // 用量回传（P0-2 锚点）：turn.usage 模拟上游自报 prompt_tokens
  if (turn.usage && onUsage) onUsage(turn.usage);
  // 思考模式全程开启（v0.3.7 用户决策）：真实模型轮必产 reasoning，桩默认补齐；
  // turn.reasoning === '' 显式表示零字节/无思考轮
  const reasoning = turn.reasoning !== undefined ? turn.reasoning : '（思考）';
  return withTools
    ? { content: turn.content || '', toolCalls: turn.toolCalls || [], finishReason: turn.finishReason || (turn.toolCalls && turn.toolCalls.length ? 'tool_calls' : 'stop'), reasoning, streamCut: !!turn.streamCut, committed: !!turn.committed, ...(turn.streamError ? { streamError: turn.streamError } : {}) }
    : (turn.content || '');
};
llm.genericCompletion = async (messages, opts) => {
  llmCalls.push({ kind: 'generic', messages, opts });
  const turn = llmScript.shift() || { content: '（空）', toolCalls: [] };
  return { content: turn.content || '', toolCalls: turn.toolCalls || [], finishReason: (turn.toolCalls && turn.toolCalls.length) ? 'tool_calls' : 'stop', reasoning: turn.reasoning || '' };
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
    reqId: 'chat_e2e_1', instruction: '/order 在 temp 建 todo.md', baseMessages: baseMsgs(),
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
    reqId: 'chat_e2e_2', instruction: '/order 写 deny.md', baseMessages: baseMsgs(),
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
    reqId: 'chat_e2e_3', instruction: '/order 整理目录', baseMessages: baseMsgs(),
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
    reqId: 'chat_e2e_4', instruction: '/order 无限工具', baseMessages: baseMsgs(),
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
    reqId: 'chat_e2e_5', instruction: '/order 写入后打断', baseMessages: baseMsgs(),
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
    reqId: 'chat_e2e_6', instruction: '/order 写系统目录', baseMessages: baseMsgs(),
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
    reqId: 'chat_e2e_7a', instruction: '/order 建 mode-ud.md', baseMessages: baseMsgs(),
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
    reqId: 'chat_e2e_7a2', instruction: '/order 写数据目录外', baseMessages: baseMsgs(),
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
    reqId: 'chat_e2e_7b', instruction: '/order 写 mode-read.md', baseMessages: baseMsgs(),
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

// ============ 用例 8：write_file 被 max_tokens 截断（复现实测 run 16）→ 截断重试 + 分段写入 ============
section('用例 8：finishReason=length 截断重试与分段写入');
{
  store.set('settings', { agent: { permissionMode: 'userData' } }); // 数据目录直写，聚焦截断逻辑
  const doc = path.join(TMP, 'proj-doc.md');
  llmScript = [
    { content: '先看一眼目录。', toolCalls: [{ id: 'c1', name: 'list_dir', argsRaw: JSON.stringify({ path: TMP }) }], finishReason: 'tool_calls' },
    // 复现实测：叙述「我把文档写进数据目录根」+ write_file 参数超长被 max_tokens 腰斩
    { content: '我把文档写进数据目录根，命名 proj-doc.md。内容按 front-matter → 背景 → TODO 组织。', finishReason: 'length' },
    { content: '分段写。', toolCalls: [{ id: 'c2', name: 'write_file', argsRaw: JSON.stringify({ path: doc, content: '# part1\n', reason: '文档第一段' }) }], finishReason: 'tool_calls' },
    { content: '续段。', toolCalls: [{ id: 'c3', name: 'write_file', argsRaw: JSON.stringify({ path: doc, content: '# part2\n', reason: '文档第二段追加', append: 'true' }) }], finishReason: 'tool_calls' },
    { content: '两段都写进去了，任务完成。[情绪:开心]', finishReason: 'stop' },
  ];
  permDecision = 'allow_once';
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_e2e_8', instruction: '/order 写项目迭代文档', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '8 不应 error: ' + e.message); },
  });
  ok(fs.existsSync(doc) && fs.readFileSync(doc, 'utf8') === '# part1\n# part2\n', '截断重试后真实写入（覆盖+append 追加）');
  ok(llmCalls.length === 5, `共 5 轮调用（读目录+截断+重试写两段+收尾），got ${llmCalls.length}`);
  ok(llmCalls[1].kind === 'stream' && llmCalls[1].overrides && llmCalls[1].overrides.max_tokens === 8192, '决策轮带 toolMaxTokens（默认 8192）');
  const lengthMsg = llmCalls[2].messages.find(m => m.role === 'system' && m.content.includes('截断'));
  ok(lengthMsg && lengthMsg.content.includes('截断'), 'LENGTH_MSG（截断原因+分段写入指引）注入');
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_8');
  ok(rec && rec.status === 'done', 'run 最终 done');
  ok(rec.steps.some(s => s.kind === 'notice' && s.notice === 'length_retry'), '截断重试 notice 入台账');
  ok(rec.lengthRetries === 1, '台账记 lengthRetries=1');
  ok(!rec.finalReply.includes('系统核实'), '真实写入后不触发幻觉兜底');
}

// ============ 用例 9：声称已写入但零成功写入（跑过读工具）→ 强制重试后真写 ============
section('用例 9：声称已写入守卫（claim-without-write）');
{
  const doc = path.join(TMP, 'temp', 'claim.md');
  llmScript = [
    { content: '看目录。', toolCalls: [{ id: 'c1', name: 'list_dir', argsRaw: JSON.stringify({ path: TMP }) }], finishReason: 'tool_calls' },
    // 读工具跑过了（executedTools>0，旧的假完成检测不覆盖），正文却声称已写入
    { content: '我已经把整理报告写入 temp/claim.md 了。[情绪:开心]', finishReason: 'stop' },
    { content: '补写。', toolCalls: [{ id: 'c2', name: 'write_file', argsRaw: JSON.stringify({ path: doc, content: 'report', reason: '补写整理报告' }) }], finishReason: 'tool_calls' },
    { content: '这次真的写好了。[情绪:开心]', finishReason: 'stop' },
  ];
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_e2e_9', instruction: '/order 整理目录并写入报告', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '9 不应 error: ' + e.message); },
  });
  ok(fs.existsSync(doc) && fs.readFileSync(doc, 'utf8') === 'report', '重试后文件真实写入');
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_9');
  ok(rec.retries === 1, '重试计数 = 1');
  ok(rec.steps.some(s => s.kind === 'notice' && s.text.includes('声称已写入')), '声称已写入 notice 入台账');
  const claimMsg = llmCalls[2].messages.find(m => m.role === 'system' && m.content.includes('并不存在'));
  ok(claimMsg && claimMsg.content.includes('并不存在'), 'CLAIM_MSG 注入');
  ok(!rec.finalReply.includes('系统核实'), '写入成功后无兜底注记');
}

// ============ 用例 9b：重试后仍声称已写入 → 幻觉兜底注记如实送达 ============
section('用例 9b：顽固幻觉 → 系统核实注记');
{
  const ghost = path.join(TMP, 'temp', 'ghost.md');
  llmScript = [
    { content: '看目录。', toolCalls: [{ id: 'c1', name: 'list_dir', argsRaw: JSON.stringify({ path: TMP }) }], finishReason: 'tool_calls' },
    { content: '已经写入 temp/ghost.md，内容完整。[情绪:开心]', finishReason: 'stop' },
    { content: '已经写入 temp/ghost.md，内容完整，无需再做。[情绪:开心]', finishReason: 'stop' }, // 重试后依旧嘴硬
  ];
  llmCalls = [];
  let finalFl = null;
  await loop.startRun({
    reqId: 'chat_e2e_9b', instruction: '/order 写 ghost.md', baseMessages: baseMsgs(),
    onFinal: async (fl) => { finalFl = fl; return {}; }, onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '9b 不应 error: ' + e.message); },
  });
  ok(!fs.existsSync(ghost), '文件确实未写入');
  ok(finalFl && finalFl.clean.includes('系统核实'), '最终回复附加系统核实注记（不单独放行假完成）');
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_9b');
  ok(rec && rec.finalReply.includes('系统核实'), '台账 finalReply 同样带注记');
  store.set('settings', { agent: { permissionMode: 'full' } }); // 还原
}

// ============ 用例 10：save_memory 写长期记忆（无 path 工具，v0.3.4） ============
section('用例 10：save_memory 落库长期记忆（「记下了」变成真的）');
{
  llmScript = [
    { content: '我把这点固化下来。', toolCalls: [{ id: 'c1', name: 'save_memory', argsRaw: JSON.stringify({ content: '用户偏好纯思辨性哲学探讨，非项目焦虑', importance: '4', type: 'preference' }) }], finishReason: 'tool_calls' },
    { content: '记下了，这次真的写进长期记忆了。[情绪:开心]', finishReason: 'stop' },
  ];
  llmCalls = [];
  let finalFl = null;
  await loop.startRun({
    reqId: 'chat_e2e_10', instruction: '把这一点写进你的长期记忆', baseMessages: baseMsgs(),
    onFinal: async (fl) => { finalFl = fl; return {}; }, onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '10 不应 error: ' + e.message); },
  });
  const memItems = store.get('memory/roleplay').items;
  ok(memItems.some(i => i.content === '用户偏好纯思辨性哲学探讨，非项目焦虑' && i.type === 'preference' && i.importance === 4), '记忆真实入库（内容/类型/重要性归一）');
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_10');
  ok(rec && rec.status === 'done', 'run 正常收尾');
  const toolStep = rec.steps.find(s => s.kind === 'tool' && s.tool === 'save_memory');
  ok(toolStep && toolStep.ok, 'save_memory 步骤成功入台账');
  ok(toolStep && toolStep.summary.includes('用户偏好'), '台账摘要显示记忆内容（非 undefined）');
  ok(finalFl && finalFl.clean.includes('记下了'), '最终回复正常送达');
  ok(rec.retries === 0 && rec.lengthRetries === undefined, '「写进长期记忆」表述未误触发幻觉/截断守卫');
}

// ============ 用例 11：虚假读取（实测 run19 复现：零工具却叙述「读完了」） ============
section('用例 11：声称已读取守卫（read-claim，零 read_file）');
{
  const seed = path.join(TMP, 'temp', 'log-note.md');
  fs.writeFileSync(seed, '笔记内容样本', 'utf8');
  llmScript = [
    // 复现：无进展标记、无工具调用，纯叙述伪装执行（taskLike=false，旧守卫完全漏过）
    { content: '——目录确认。记录不少——我先列全，再逐个读。\n——（读完最后一个文件）\n——前辈，我读完了。全部 10 份聊天记录。', finishReason: 'stop' },
    { content: '这次真的读了。', toolCalls: [
      { id: 'c1', name: 'list_dir', argsRaw: JSON.stringify({ path: path.join(TMP, 'temp') }) },
      { id: 'c2', name: 'read_file', argsRaw: JSON.stringify({ path: seed }) },
    ], finishReason: 'tool_calls' },
    { content: '读到的内容是：笔记内容样本。[情绪:平常]', finishReason: 'stop' },
  ];
  llmCalls = [];
  let finalFl = null;
  await loop.startRun({
    reqId: 'chat_e2e_11', instruction: '/order D:\\CC_project\\deskpal\\docs\\log 这个文件夹里有全部聊天记录，读完再回答', baseMessages: baseMsgs(),
    onFinal: async (fl) => { finalFl = fl; return {}; }, onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '11 不应 error: ' + e.message); },
  });
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_11');
  ok(rec.retries === 1, '读取声称触发重试（retries=1）');
  ok(rec.steps.some(s => s.kind === 'notice' && s.text.includes('已读取')), '读取声称 notice 入台账');
  const claimMsg = llmCalls[1].messages.find(m => m.role === 'system' && m.content.includes('编造'));
  ok(!!claimMsg, 'READ_CLAIM_MSG（编造警告+逐份读取指引）注入');
  ok(rec.steps.some(s => s.kind === 'tool' && s.tool === 'read_file' && s.ok === true), '重试后真实 read_file 执行');
  ok(finalFl && finalFl.clean.includes('笔记内容样本'), '真实读取内容进回复');
  ok(!finalFl.clean.includes('系统核实'), '真实读取后无兜底注记');
}

// ============ 用例 12：虚假写入「落盘」措辞（实测 run21 复现） ============
section('用例 12：「落盘/校验完成」措辞的写入声称守卫');
{
  const notes = path.join(TMP, 'temp', 'titor_reading_notes.md');
  llmScript = [
    { content: '——前辈，我准备落盘。路径：D:\\CC_project\\deskpal\\docs\\log\\titor_reading_notes.md。\n——第二段，落盘。\n——第三段，落盘。\n——前辈，笔录落盘了。校验完成，无截断。', finishReason: 'stop' },
    { content: '现在真写。', toolCalls: [{ id: 'c1', name: 'write_file', argsRaw: JSON.stringify({ path: notes, content: '笔录正文', reason: '补写笔录' }) }], finishReason: 'tool_calls' },
    { content: '这次真的写好了，你可以去文件夹看。[情绪:平常]', finishReason: 'stop' },
  ];
  permDecision = 'allow_once';
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_e2e_12', instruction: '/order 把笔录生成在 docs\\log 文件夹内', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '12 不应 error: ' + e.message); },
  });
  ok(fs.existsSync(notes) && fs.readFileSync(notes, 'utf8') === '笔录正文', '重试后笔录真实落盘');
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_12');
  ok(rec.retries === 1 && rec.steps.some(s => s.kind === 'notice' && s.text.includes('已写入')), '「落盘了」触发写入声称重试');
  const claimMsg = llmCalls[1].messages.find(m => m.role === 'system' && m.content.includes('并不存在'));
  ok(!!claimMsg, 'CLAIM_MSG 注入');
}

// ============ 用例 13：重试后仍声称已读取 → 系统核实兜底注记 ============
section('用例 13：顽固虚假读取 → 兜底注记（复现 run20 重试后再犯）');
{
  llmScript = [
    { content: '我读完了，全部记录都过了一遍。', finishReason: 'stop' },
    { content: '真的，全部记录我读完了，结论不变。', finishReason: 'stop' },
  ];
  llmCalls = [];
  let finalFl = null;
  await loop.startRun({
    reqId: 'chat_e2e_13', instruction: '/order 看一下 docs\\log 里的测评报告再总结', baseMessages: baseMsgs(),
    onFinal: async (fl) => { finalFl = fl; return {}; }, onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '13 不应 error: ' + e.message); },
  });
  ok(finalFl && finalFl.clean.includes('系统核实：本次任务没有实际读取任何文件'), '读取兜底注记附加（不单独放行虚假读取）');
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_13');
  ok(rec && rec.finalReply.includes('系统核实'), '台账 finalReply 同样带读取注记');
}

// ============ 用例 14：思考模式 reasoning_content 回传（DeepSeek 思考模式强制要求） ============
section('用例 14：多轮工具循环回传 reasoning_content');
{
  store.set('settings', { agent: { permissionMode: 'userData' } }); // 直写，聚焦回传链路
  const target = path.join(TMP, 'temp', 'reasoning-notes.md');
  llmScript = [
    { content: '先读目录。', reasoning: '思考：用户要建文件，先看目录。', toolCalls: [{ id: 'c1', name: 'list_dir', argsRaw: JSON.stringify({ path: TMP }) }], finishReason: 'tool_calls' },
    { content: '再写文件。', reasoning: '思考：目录确认，写入目标文件。', toolCalls: [{ id: 'c2', name: 'write_file', argsRaw: JSON.stringify({ path: target, content: 'notes', reason: '写笔记' }) }], finishReason: 'tool_calls' },
    { content: '完成了。', reasoning: '', finishReason: 'stop' },
  ];
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_e2e_14', instruction: '/order 读目录并建 reasoning-notes.md', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '14 不应 error: ' + e.message); },
  });
  // 第 2 轮请求：assistant(tool_calls) 消息必须带上一轮的 reasoning_content
  const r2Asst = llmCalls[1].messages.find(m => m.role === 'assistant' && m.tool_calls);
  ok(r2Asst && r2Asst.reasoning_content === '思考：用户要建文件，先看目录。', '第 2 轮回传第 1 轮 reasoning_content');
  // 第 3 轮请求：同理回传第 2 轮的（取最后一条带 tool_calls 的 assistant，第 1 条是第 1 轮的）
  const asstCalls = llmCalls[2].messages.filter(m => m.role === 'assistant' && m.tool_calls);
  const r3Asst = asstCalls[asstCalls.length - 1];
  ok(r3Asst && r3Asst.reasoning_content === '思考：目录确认，写入目标文件。', '第 3 轮回传第 2 轮 reasoning_content');
  ok(fs.existsSync(target), '思考模式下任务正常完成');
  store.set('settings', { agent: { permissionMode: 'full' } }); // 还原
}

// ============ 用例 15：SSE 流中途断开（无 finish_reason/[DONE]）→ 续跑重试 ============
section('用例 15：响应流中途断开的有界续跑');
{
  const seed = path.join(TMP, 'temp', 'cut-note.md');
  fs.writeFileSync(seed, '断流续跑样本', 'utf8');
  llmScript = [
    // 复现实测 run_mufiiou9_1：正文半句戛然而止，无 finish_reason、无工具调用
    { content: '——先列目录，确认真实存在什么。（返回了。真实目录：四个文件——一', streamCut: true, finishReason: 'stop' },
    { content: '继续读。', toolCalls: [{ id: 'c1', name: 'read_file', argsRaw: JSON.stringify({ path: seed }) }], finishReason: 'tool_calls' },
    { content: '读到了：断流续跑样本。任务完成。[情绪:平常]', finishReason: 'stop' },
  ];
  llmCalls = [];
  let finalFl = null;
  await loop.startRun({
    reqId: 'chat_e2e_15', instruction: '/order 读 docs\\log 里的四个文件', baseMessages: baseMsgs(),
    onFinal: async (fl) => { finalFl = fl; return {}; }, onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '15 不应 error: ' + e.message); },
  });
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_15');
  ok(rec.lengthRetries === 1, '断流触发续跑重试（lengthRetries=1）');
  ok(rec.steps.some(s => s.kind === 'notice' && s.notice === 'stream_cut_retry'), '断流 notice 入台账');
  const cutMsg = llmCalls[1].messages.find(m => m.role === 'system' && m.content.includes('传输中途被断开'));
  ok(!!cutMsg, '续跑指引（继续调用工具+完整答复）注入');
  ok(rec.steps.some(s => s.kind === 'tool' && s.tool === 'read_file' && s.ok === true), '续跑后真实读取');
  ok(finalFl && finalFl.clean.includes('断流续跑样本'), '最终回复完整（非半句）');
}

// ============ 用例 16：戏内/戏外通道（dev.5 系列机制级收口，用户决策 2026-09-29） ============
section('用例 16：戏内轮结构性收权 + 守卫无条件放行');
{
  // 16a：未打标 = 戏内。指令按旧规则会被判任务（帮我+看）且回复带完成态自述——
  // 旧代码这里 READ_CLAIM 必开火；新代码通道闸放行。工具面同时收权（run_mulmo919_2 同源事故）。
  llmScript = [
    { content: '它是后验打法：读完所有代码，穷举出代码里存在的所有行为路径。我已经把项目全部读完了，讲讲我的看法。', finishReason: 'stop' },
  ];
  llmCalls = [];
  let finalFl16 = null;
  await loop.startRun({
    reqId: 'chat_e2e_16', instruction: '帮我对比一下打法——它读完了所有代码文件，穷举出所有行为路径，你呢？', baseMessages: baseMsgs(),
    onFinal: async (fl) => { finalFl16 = fl; return {}; }, onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '16a 不应 error: ' + e.message); },
  });
  const rec16 = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_16');
  ok(rec16 && rec16.channel === 'roleplay', '未打标 → 台账 channel=roleplay');
  const toolNames16 = ((llmCalls[0].overrides || {}).tools || []).map(t => t.function.name).sort();
  eq(toolNames16, ['save_memory', 'web_search'], '戏内轮仅下发 web_search + save_memory（文件类工具结构性收权）');
  ok(rec16 && rec16.retries === 0, '戏内轮守卫无条件放行（完成态自述/第三者转述不再触发重试）');
  ok(finalFl16 && finalFl16.clean.includes('读完所有代码'), '最终回复正常送达');

  // 16b：戏内轮模型越权请求文件工具（服务商异常/注入路径）→ 执行层兜底拒绝
  llmScript = [
    { content: '我看看目录。', toolCalls: [{ id: 'c16b', name: 'list_dir', argsRaw: JSON.stringify({ path: 'C:/极其可疑的目录' }) }], finishReason: 'tool_calls' },
    { content: '这轮拿不到文件工具，那就不看了。', finishReason: 'stop' },
  ];
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_e2e_16b', instruction: '帮我看看有什么新东西（未打标）', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '16b 不应 error: ' + e.message); },
  });
  const rec16b = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_16b');
  const denyStep = rec16b.steps.find(s => s.kind === 'tool' && s.tool === 'list_dir');
  ok(denyStep && denyStep.ok === false, '戏内轮越权工具调用被执行层拒绝（ok=false）');
  ok(rec16b && rec16b.status === 'done', '拒绝后 run 正常收尾');

  // 16c：/order 打标 = 戏外工作轮，工具全量下发、守卫武装（写入声称重试照常工作）
  llmScript = [
    { content: '整理好了，清单已经写入 report.md。', finishReason: 'stop' },
    { content: '（补做）清单真实写入完毕。', finishReason: 'stop' },
  ];
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_e2e_16c', instruction: '/order 整理目录', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '16c 不应 error: ' + e.message); },
  });
  const rec16c = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_16c');
  ok(rec16c && rec16c.channel === 'work', '/order 打标 → 台账 channel=work');
  ok(rec16c && rec16c.retries === 1, '戏外轮假完成守卫照常武装（重试 1 次）');
  ok(rec16c && Array.isArray(rec16c.wipedRounds) && rec16c.wipedRounds.length === 1
    && rec16c.wipedRounds[0].content.includes('已经写入'), '被重试轮正文全量留档（wipedRounds，dev.5+3）');
  const toolNames16c = ((llmCalls[0].overrides || {}).tools || []).map(t => t.function.name);
  ok(toolNames16c.includes('write_file') && toolNames16c.includes('read_file'), '戏外轮文件类工具全量下发');
}

// ============ 用例 17：add_reminder 通道与落库（repeat 功能） ============
section('用例 17：add_reminder 戏外可下发、创建真实落库、同名软去重');
{
  const scheduler = require(SVC('schedule/scheduler'));
  scheduler.start(); // 加载事件库（此前的用例不涉及日程，库为空）
  // 日期动态化（2026-10-02 事故：写死 2026-10-01 的 start 过期后顺延，断言随日期失效）：
  // 取明天，保证 start 在未来、首次提醒按字面物化，滚动续期行为由 test-schedule-repeat.js 覆盖
  const d17 = new Date(Date.now() + 36 * 3600 * 1000);
  const d17Str = `${d17.getFullYear()}-${String(d17.getMonth() + 1).padStart(2, '0')}-${String(d17.getDate()).padStart(2, '0')}`;

  // 17a：戏外工作轮自然语言设每日提醒 → 工具真实落库（含 repeat）
  llmScript = [
    {
      content: '好，我来设置。',
      toolCalls: [{ id: 'c17', name: 'add_reminder', argsRaw: JSON.stringify({ title: '喝水', start: `${d17Str} 09:00`, repeat: 'daily' }) }],
      finishReason: 'tool_calls',
    },
    { content: '已设好每天 9 点的喝水提醒。[情绪:开心]', finishReason: 'stop' },
  ];
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_e2e_17', instruction: '/order 每天早上九点提醒我喝水', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '17a 不应 error: ' + e.message); },
  });
  const toolNames17 = ((llmCalls[0].overrides || {}).tools || []).map(t => t.function.name);
  ok(toolNames17.includes('add_reminder'), '戏外轮下发 add_reminder');
  const evt17 = scheduler.listEvents().find(e => e.title === '喝水');
  ok(!!evt17, 'add_reminder 真实创建日程事件');
  ok(evt17 && evt17.repeat === 'daily' && evt17.source === 'chat', 'repeat=daily 落库、来源=chat');
  ok(evt17 && evt17.reminders.some(r => r.status === 'pending' && r.at.startsWith(`${d17Str}T09:00`)), `首次提醒物化在 ${d17Str} 09:00`);
  const rec17 = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_17');
  ok(rec17 && rec17.channel === 'work' && rec17.status === 'done', '戏外轮 run 正常收尾');
  const toolStep17 = rec17.steps.find(s => s.kind === 'tool' && s.tool === 'add_reminder');
  ok(toolStep17 && toolStep17.ok, 'add_reminder 步骤成功入台账');

  // 17b：同名重复提醒软去重（防跨轮堆积）
  llmScript = [
    {
      content: '再设一次。',
      toolCalls: [{ id: 'c17b', name: 'add_reminder', argsRaw: JSON.stringify({ title: '喝水', start: `${d17Str} 15:00`, repeat: 'daily' }) }],
      finishReason: 'tool_calls',
    },
    { content: '已经有同名的了。', finishReason: 'stop' },
  ];
  await loop.startRun({
    reqId: 'chat_e2e_17b', instruction: '/order 再设一个每天喝水的提醒', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '17b 不应 error: ' + e.message); },
  });
  ok(scheduler.listEvents().filter(e => e.title === '喝水' && e.status === 'pending').length === 1, '同名每日提醒未重复创建');
}

// ============ 用例 18：断流且正文已外化（committed）→ 不重试、如实收尾 + 系统注记 ============
section('用例 18：streamCut committed 路径（P0-3）');
{
  store.set('settings', { agent: { permissionMode: 'full' } });
  llmScript = [
    // 第一轮：流断（streamCut），且正文已外化（committed）——重试会让用户看到重复半截、
    // reset 会抹掉已示人内容，只能如实收尾
    { content: '我把报告的第一部分写', toolCalls: [], finishReason: null, streamCut: true, committed: true, streamError: { layer: 'frame', message: '网络空闲超时' } },
  ];
  llmCalls = [];
  let finalFl = null, donePayload = null;
  await loop.startRun({
    reqId: 'chat_e2e_18', instruction: '/order 把报告写进 temp', baseMessages: baseMsgs(),
    onFinal: async (fl) => { finalFl = fl; return {}; }, onDone: (x) => { donePayload = x; }, onAborted: () => {}, onError: (e) => { ok(false, 'committed 收尾不应 error: ' + e.message); },
  });
  ok(llmCalls.length === 1, '不再自动重试（committed 不可重放）');
  ok(finalFl && finalFl.clean.includes('我把报告的第一部分写'), '半截正文原样保留（未 reset）');
  ok(finalFl && finalFl.clean.includes('（系统注记：'), '附诚实注记（可能不完整）');
  const rec18 = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_18');
  ok(rec18 && rec18.status === 'done', 'run 正常收尾（done 而非 error）');
  ok(rec18.steps.some(s => s.kind === 'notice' && s.notice === 'stream_cut_partial' && String(s.text).includes('frame')), 'notice 记录断流层别');
}

// ============ 用例 19：断流未外化 + 半截工具调用 → 有界续跑 + [未执行] 显式回执 ============
section('用例 19：streamCut 续跑与 NOT_EXECUTED 回执（P0-1）');
{
  store.set('settings', { agent: { permissionMode: 'full' } });
  llmScript = [
    // 第一轮：流断、零正文外化（committed=false）、半截工具调用——续跑且半截调用留显式回执
    { content: '', toolCalls: [{ id: 'c19', name: 'write_file', argsRaw: '{"path":"D:/x/a.md","con' }], finishReason: null, streamCut: true, committed: false },
    // 续跑轮：真实执行一次工具（否则零执行的「完成了」叙述会正当地触发假完成守卫）
    { content: '重发调用。', toolCalls: [{ id: 'c19b', name: 'list_dir', argsRaw: JSON.stringify({ path: path.join(TMP, 'temp') }) }], finishReason: 'tool_calls' },
    { content: '这次完成了。', finishReason: 'stop' },
  ];
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_e2e_19', instruction: '/order 写文件', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '续跑不应 error: ' + e.message); },
  });
  ok(llmCalls.length === 3, '有界续跑（续跑轮重发真实调用后收尾）');
  const r2 = llmCalls[1].messages;
  const halfAsst = r2.find(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.some(c => c.id === 'c19'));
  ok(!!halfAsst, '半截 assistant tool_calls 原样进历史');
  const receipt = r2.find(m => m.role === 'tool' && m.tool_call_id === 'c19');
  ok(receipt && receipt.content.includes('[未执行]') && receipt.content.includes('不可信'), '半截调用配 [未执行] 显式回执（配对不悬空）');
  const rec19 = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_19');
  ok(rec19.steps.some(s => s.kind === 'notice' && s.notice === 'stream_cut_retry'), '续跑 notice 入台账');
}

// ============ 用例 20：length 截断 + 半截调用 → [未执行] 回执（P0-1） ============
section('用例 20：length 截断的显式回执');
{
  llmScript = [
    { content: '我开始写了', toolCalls: [{ id: 'c20', name: 'write_file', argsRaw: '{"path":"' }], finishReason: 'length' },
    { content: '这次分段写完了。', finishReason: 'stop' },
  ];
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_e2e_20', instruction: '/order 写文件', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '截断重试不应 error: ' + e.message); },
  });
  const r2 = llmCalls[1].messages;
  const receipt20 = r2.find(m => m.role === 'tool' && m.tool_call_id === 'c20');
  ok(receipt20 && receipt20.content.includes('max_tokens'), 'length 截断的回执点名原因');
  ok(r2.some(m => m.role === 'system' && m.content.includes('截断')), '截断纠正指令照旧注入');
}

// ============ 用例 21：上下文溢出 → 记忆固化 + 两级压缩续跑（P0-4） ============
section('用例 21：contextOverflow 溢出交接');
{
  const bigBase = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '很早的消息1' },
    { role: 'assistant', content: '旧回复1' },
    { role: 'user', content: '很早的消息2' },
    { role: 'assistant', content: '旧回复2' },
    { role: 'user', content: '当前指令' },
  ];
  llmScript = [
    { __throwOverflow: true },                                     // 第一次：溢出
    { __throwOverflow: true },                                     // 第二次：一级压缩后仍溢出（工具轮也清）
    { content: '压缩后续跑成功。', finishReason: 'stop' },          // 第三次：成功
  ];
  llmCalls = [];
  let overflowCb = 0;
  await loop.startRun({
    reqId: 'chat_e2e_21', instruction: '/order 继续任务', baseMessages: bigBase,
    onContextOverflow: async () => { overflowCb++; },
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '溢出续跑不应 error: ' + e.message); },
  });
  ok(llmCalls.length === 3, '两次压缩后续跑成功（共 3 次调用）');
  ok(overflowCb === 2, '每次压缩前都触发记忆固化钩子');
  const r3 = llmCalls[2].messages; // 二级压缩后：base= system+注记+末2条，toolTurns 清空
  ok(r3.length === 4, `二级压缩后上下文只剩 4 条（got ${r3.length}）`);
  ok(r3[0].role === 'system' && r3[1].role === 'system' && r3[1].content.includes('压缩') && r3[1].content.includes('固化'), '压缩注记含记忆固化说明');
  ok(r3[2].content === '旧回复2' && r3[3].content === '当前指令', '保留最近一轮问答');
  const rec21 = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_21');
  ok(rec21 && rec21.status === 'done', 'run 最终 done（溢出未变成报错）');
  ok(rec21.steps.filter(s => s.kind === 'notice' && s.notice === 'context_overflow').length === 2, '两级压缩 notice 入台账');
}

// ============ 用例 22：用量转发与聚合（P0-2 锚点数据源 + 本轮消耗外显） ============
section('用例 22：onUsage 首轮锚点转发 + 全轮次聚合');
{
  llmScript = [
    { content: '先用工具。', toolCalls: [{ id: 'c22', name: 'list_dir', argsRaw: JSON.stringify({ path: path.join(TMP, 'temp') }) }], finishReason: 'tool_calls', usage: { prompt_tokens: 1234, completion_tokens: 56, completion_tokens_details: { reasoning_tokens: 40 } } },
    { content: '收尾。', finishReason: 'stop', usage: { prompt_tokens: 9999, completion_tokens: 21, completion_tokens_details: { reasoning_tokens: 1 } } }, // 工具轮用量不进锚点但进聚合
  ];
  llmCalls = [];
  const got = [];
  let donePayload = null;
  await loop.startRun({
    reqId: 'chat_e2e_22', instruction: '/order 列目录', baseMessages: baseMsgs(),
    onUsage: (u) => got.push(u),
    onFinal: async () => ({}), onDone: (x) => { donePayload = x; }, onAborted: () => {}, onError: (e) => { ok(false, '用量转发路径不应 error: ' + e.message); },
  });
  ok(got.length === 1 && got[0].prompt_tokens === 1234, `只转发首个基础轮用量作锚点（got ${JSON.stringify(got)}）`);
  ok(donePayload && donePayload.usage, 'onDone 携带本轮消耗合计');
  eq(donePayload.usage, { input: 1234 + 9999, output: 56 + 21, reasoning: 40 + 1, cacheHit: null, requests: 2 }, '聚合=全部请求合计（输入/思考/回复/次数）');
  const rec22 = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_22');
  eq(rec22.usage, { input: 11233, output: 77, reasoning: 41, cacheHit: null, requests: 2 }, '台账 record.usage 落档');
}

// ============ 用例 23：零字节断流（首响应超时）→ 不推空 assistant + 续跑（20261002 事故回归） ============
section('用例 23：零字节断流续跑不产生协议非法消息');
{
  store.set('settings', { agent: { permissionMode: 'full' } });
  llmScript = [
    // 首响应超时形态：零字节（无正文/无思考/无调用）、流断、未外化——桩的 DeepSeek 式
    // 校验会拦下任何被推入的空 assistant 消息（复现 run_mupxfru8_1 的 400）
    { content: '', reasoning: '', toolCalls: [], finishReason: null, streamCut: true, committed: false },
    { content: '这次正常完成了。', finishReason: 'stop' },
  ];
  llmCalls = [];
  let finalFl = null;
  await loop.startRun({
    reqId: 'chat_e2e_23', instruction: '/order 继续任务', baseMessages: baseMsgs(),
    onFinal: async (fl) => { finalFl = fl; return {}; }, onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '零字节续跑不应 error: ' + e.message); },
  });
  ok(llmCalls.length === 2, '零字节断流后有界续跑（共 2 次调用）');
  const r2 = llmCalls[1].messages;
  ok(!r2.some(m => m.role === 'assistant'), '零字节轮未推任何 assistant 消息（无物可留，协议安全）');
  ok(r2.some(m => m.role === 'system' && m.content.includes('输出开始前被中断')), '零字节专用续跑指令（区别于半句断开）');
  const rec23 = runs.query({}).runs.find(r => r.reqId === 'chat_e2e_23');
  ok(rec23 && rec23.status === 'done' && rec23.lengthRetries === 1, 'run done、断流重试计数 1');
  ok(finalFl && finalFl.clean.includes('正常完成'), '续跑后正常收尾');
}

// ============ 用例 24：半截轮 reasoning 缺失 → deepseek 垫占位符（协议闸） ============
section('用例 24：半截轮 reasoning_content 垫底');
{
  // 桩模型名不是 deepseek → isDeepseek false → 不垫。临时把 model 换成 deepseek 系验证垫底分支
  store.set('api', { endpoint: 'http://stub', model: 'deepseek-chat', params: { maxTokens: 2048 } });
  llmScript = [
    // 有正文（已思考过但桩不给 reasoning——模拟 reasoning 字段缺失的极端断流形态）、无调用
    { content: '写到一半', reasoning: '', toolCalls: [], finishReason: null, streamCut: true, committed: false },
    { content: '续上并完成。', finishReason: 'stop' },
  ];
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_e2e_24', instruction: '/order 写文件', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '垫底路径不应 error: ' + e.message); },
  });
  const r2 = llmCalls[1].messages;
  const asst24 = r2.find(m => m.role === 'assistant');
  ok(asst24 && asst24.reasoning_content === '-', `deepseek 端点半截轮 reasoning_content 垫 '-'（got ${asst24 && JSON.stringify(asst24.reasoning_content)}）`);
  // 还原桩模型名，避免影响后续（无后续用例）
  store.set('api', { endpoint: 'http://stub', model: 'stub', params: { maxTokens: 2048 } });
}

function eq(a, b, name) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  ok(ja === jb, `${name}${ja === jb ? '' : `（got ${ja}, want ${jb}）`}`);
}

console.log(`\n========== 集成测试结果：${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
})();
