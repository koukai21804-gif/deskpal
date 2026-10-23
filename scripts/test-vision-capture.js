// 视觉捕获回归（look_screen / look_camera，v0.5.1）：黑帧判定 / 纯 Node 类型化失败 /
// 授权双轨（开启卡·防试探·逐次卡·摄像头冷却）/ 工具注册 / loop 下发面（vision 闸·戏内白名单）/
// 图像消息注入与压缩回执。真实 store + 桩 LLM/权限/捕获（纯 Node，无 electron）。
// 方案对标 Amadeus System capture_screen.py / capture_camera.py（自窗口排除/黑帧校验/预热帧）。
// 用法：node scripts/test-vision-capture.js
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

// ---- 环境：隔离 userData ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-vision-cap-'));
const store = require(SVC('store'));
store.init(TMP);
store.set('api', { endpoint: 'http://stub', model: 'stub-model', vision: 'auto' });

const llm = require(SVC('llm'));
const tools = require(SVC('agent/builtin'));
const vc = require(SVC('agent/vision-capture'));
const permissions = require(SVC('agent/permissions'));
const emotion = require(SVC('emotion'));
emotion.broadcastEmotion = () => {}; // 打桩：跳过窗口广播
const { compactTurns } = require(SVC('agent/ctx-compact'));

// ============ ① 黑帧判定（Amadeus validate_frame 阈值移植） ============
section('① 亮度统计与黑帧判定（stddev<0.8 且 mean<3.0）');
{
  const black = Buffer.alloc(64 * 64 * 4, 0); // 纯黑
  ok(vc.isBlackFrame(vc.statsFromRGBA(black)), '纯黑帧判黑');
  const white = Buffer.alloc(64 * 64 * 4, 255); // 纯白：均值高 → 不是黑帧
  ok(!vc.isBlackFrame(vc.statsFromRGBA(white)), '纯白帧不判黑');
  const content = Buffer.alloc(64 * 64 * 4, 0);
  for (let i = 0; i < content.length; i += 4) { content[i] = (i / 4) % 256; content[i + 1] = 128; content[i + 2] = 64; }
  ok(!vc.isBlackFrame(vc.statsFromRGBA(content)), '内容帧不判黑');
  const dim = Buffer.alloc(64 * 64 * 4, 2); // 全部通道=2：mean=2<3 且 stddev=0 → 判黑
  ok(vc.isBlackFrame(vc.statsFromRGBA(dim)), '暗哑帧（mean=2）判黑');
  eq(vc.statsFromRGBA(Buffer.alloc(0)).mean, [0, 0, 0], '空 buffer 不崩溃，均值归零');
  const st = vc.statsFromRGBA(Buffer.concat([Buffer.alloc(64 * 4, 0), (() => { const b = Buffer.alloc(64 * 4); b.fill(200); return b; })()]));
  ok(st.mean[0] === 100 && st.stddev[0] === 100, '统计数值正确（半黑半白：mean=100 stddev=100）');
}

// ============ ② 纯 Node 环境的类型化失败 ============
section('② 纯 Node 下捕获函数给出可测失败（electron 不可用）');
{
  let err = null;
  try { await vc.captureScreen({ index: 0 }); } catch (e) { err = e; }
  ok(err && /需要在 deskpal 应用内运行/.test(err.message), 'captureScreen 报「需在应用内运行」');
  err = null;
  try { await vc.captureCamera({ index: 0 }); } catch (e) { err = e; }
  ok(err && /需要在 deskpal 应用内运行/.test(err.message), 'captureCamera 报「需在应用内运行」');
}

// ============ ②½ 采集页路径（20261021 打包事故回归闸） ============
section('②½ 采集页路径：无 src/src 重复、文件真实存在');
{
  const p = vc.CAPTURE_PAGE_PATH;
  ok(/renderer[\\/]camera[\\/]capture\.html$/.test(p), '路径以 renderer/camera/capture.html 结尾');
  ok(!/[\\/]src[\\/]src[\\/]/.test(p) && !/[\\/]src[\\/]src$/.test(p), '无 src/src 重复段（事故根因）');
  ok(fs.existsSync(p), '采集页文件真实存在（源码树内）：' + path.relative(ROOT, p));
  const rel = path.relative(ROOT, p);
  ok(rel === path.join('src', 'renderer', 'camera', 'capture.html'), '相对项目根路径正确（打包后 __dirname 同构于 asar 内路径，拼接结果即 app.asar\\src\\renderer\\camera\\capture.html）');
}

// ---- 桩：权限卡与捕获（可编程决策 + 调用留痕） ----
let permDecision = 'allow_once';
let permCalls = [];
permissions.request = async (opts) => {
  permCalls.push(opts);
  return { id: 'perm_stub_' + permCalls.length, decision: permDecision };
};
const STUB_PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex'); // 头部合法的极小 PNG
let capScreenCalls = [], capCamCalls = [];
vc.captureScreen = async ({ index }) => {
  capScreenCalls.push({ index });
  return { ok: true, buf: STUB_PNG, mime: 'image/png', width: 1920, height: 1080, resized: false,
    screens: 2, index: Number.isFinite(+index) ? +index : 0, isPrimary: (+index || 0) === 0,
    foreground: '记事本', selfExcluded: 2, warnings: [], stats: { mean: [120, 130, 140], stddev: [50, 60, 55] } };
};
vc.captureCamera = async ({ index }) => {
  capCamCalls.push({ index });
  return { ok: true, buf: STUB_PNG, mime: 'image/jpeg', width: 1280, height: 720, resized: false,
    deviceLabel: 'USB Camera', deviceCount: 1, index: Number.isFinite(+index) ? +index : 0, stats: { mean: [100, 100, 100], stddev: [40, 40, 40] } };
};
const CTX = { runId: 'r_test', reqId: 'q_test', permTimeoutSec: 60, step: () => {} };
const vcSettings = () => (store.get('settings').agent || {}).visionCapture || {};

// ============ ③ look_screen 授权双轨 ============
section('③ look_screen：视觉能力闸 + 双轨授权');
{
  store.set('api', { model: 'stub-model', vision: 'auto' }); // 无视觉能力
  let err = null;
  try { await tools.invoke('look_screen', { reason: '看看屏幕' }, CTX); } catch (e) { err = e; }
  ok(err && /未开启图像识别/.test(err.message), '无视觉能力：抛设置指引（loop 统一转失败回执，与 read_image 同款）');

  store.set('api', { model: 'gpt-4o', vision: 'auto' });
  r = await tools.invoke('look_screen', { track: 'designated' }, CTX);
  ok(r.ok === false && /缺少 reason/.test(r.error), '缺 reason 参数被拒');

  // 未开启 + 自主轨：不弹卡直接拒（与 web_search 同款防试探）
  permCalls = [];
  r = await tools.invoke('look_screen', { track: 'autonomous', reason: '想看看你在做什么' }, CTX);
  ok(r.ok === false && /桌面查看未开启/.test(r.error), '未开启+自主轨：直接拒');
  eq(permCalls.length, 0, '未开启+自主轨：不弹授权卡（防试探）');

  // 未开启 + 指定轨：弹开启卡；拒绝 → 如实回绝
  permDecision = 'deny'; permCalls = [];
  r = await tools.invoke('look_screen', { track: 'designated', reason: '用户让我看屏幕报错' }, CTX);
  ok(r.ok === false && /没有批准/.test(r.error), '开启卡被拒：如实回绝');
  eq(permCalls.length, 1, '指定轨首次调用弹开启卡');
  ok(permCalls[0].action.includes('开启桌面查看'), '卡 action=开启桌面查看');
  ok(/设置→API/.test(permCalls[0].reversibility), '卡 reversibility 指路设置页');
  eq(vcSettings().screenEnabled, false, '拒绝后开关保持关闭（默认 false）');

  // 未开启 + 指定轨：批准 → 开关落库 + 截屏执行 + read_image 同款回执结构
  permDecision = 'allow_once'; permCalls = []; capScreenCalls = [];
  r = await tools.invoke('look_screen', { track: 'designated', reason: '用户让我看屏幕报错' }, CTX);
  ok(r.ok === true, '开启卡批准后截屏成功');
  eq(vcSettings().screenEnabled, true, '开关落库（settings.agent.visionCapture.screenEnabled）');
  eq(capScreenCalls.length, 1, 'captureScreen 实际执行一次');
  ok(r.imagePart && r.imagePart.type === 'image_url' && /^data:image\/png;base64,/.test(r.imagePart.image_url.url), 'imagePart 结构与 read_image 一致');
  ok(r.meta.tool === 'look_screen' && r.meta.path === 'screen:0', 'meta 带工具名与路径锚');
  ok(/前台窗口「记事本」/.test(r.text) && /已排除自身窗口 2 个/.test(r.text), '回执含前台窗口标题与自窗口排除数');
  ok(/本机共 2 块屏/.test(r.text), '回执含多屏信息');

  // 已开启 + 指定轨：不再弹卡直行
  permCalls = []; capScreenCalls = [];
  r = await tools.invoke('look_screen', { track: 'designated', reason: '再看一眼' }, CTX);
  ok(r.ok === true && permCalls.length === 0 && capScreenCalls.length === 1, '已开启+指定轨：免卡直行');

  // 已开启 + 自主轨：逐次弹卡
  permDecision = 'allow_once'; permCalls = [];
  r = await tools.invoke('look_screen', { track: 'autonomous', reason: '主动想看看进度' }, CTX);
  ok(r.ok === true && permCalls.length === 1 && permCalls[0].action === '自主截取桌面', '已开启+自主轨：逐次批准卡');

  // 截屏失败透传（黑帧/超范围）
  vc.captureScreen = async () => ({ ok: false, error: '截屏校验失败：画面为全黑帧' });
  r = await tools.invoke('look_screen', { reason: '看看' }, CTX);
  ok(r.ok === false && /全黑帧/.test(r.error), '黑帧失败如实透传');
}

// ============ ④ look_camera：逐次授权 + 拒绝冷却 ============
section('④ look_camera：camera_sensitive（逐次卡 + 拒后 60s 冷却）');
{
  vc._resetForTest();
  vc.captureCamera = async ({ index }) => {
    capCamCalls.push({ index });
    return { ok: true, buf: STUB_PNG, mime: 'image/jpeg', width: 1280, height: 720, resized: false, deviceLabel: 'USB Camera', deviceCount: 1, index: 0, stats: { mean: [1, 1, 1], stddev: [1, 1, 1] } };
  };

  let r = await tools.invoke('look_camera', {}, CTX);
  ok(r.ok === false && /缺少 reason/.test(r.error), '缺 reason 参数被拒');

  permDecision = 'deny'; permCalls = []; capCamCalls = [];
  r = await tools.invoke('look_camera', { reason: '用户想让我看看他' }, CTX);
  ok(r.ok === false && /没有批准开启摄像头/.test(r.error), '拒绝：如实回绝');
  eq(permCalls.length, 1, '每次调用都弹卡（camera_sensitive）');
  ok(permCalls[0].action === '开启摄像头拍一帧' && /拍完即关/.test(permCalls[0].reversibility), '卡文案：拍完即关');
  eq(capCamCalls.length, 0, '拒绝后不触碰摄像头');

  // 冷却：拒绝后立即再调用 → 不再弹卡直接拒
  permCalls = [];
  r = await tools.invoke('look_camera', { reason: '再试一次' }, CTX);
  ok(r.ok === false && /刚拒绝过/.test(r.error), '冷却内再次调用：直接拒');
  eq(permCalls.length, 0, '冷却内不弹卡（防骚扰式连环请求）');

  // 冷却解除（_resetForTest 模拟时间流逝）→ 批准 → 采集 + 回执
  vc._resetForTest();
  permDecision = 'allow_once'; permCalls = []; capCamCalls = [];
  r = await tools.invoke('look_camera', { reason: '用户想让我看看他' }, CTX);
  ok(r.ok === true && permCalls.length === 1 && capCamCalls.length === 1, '批准后摄像头采集一次');
  ok(r.imagePart && /^data:image\/jpeg;base64,/.test(r.imagePart.image_url.url), 'imagePart 为 JPEG dataURL');
  ok(r.meta.tool === 'look_camera' && r.meta.path === 'camera:0', 'meta 带工具名');
  ok(/摄像头已关闭/.test(r.text) && /USB Camera/.test(r.text), '回执含设备名与「已关闭」');

  // 采集失败透传
  vc.captureCamera = async () => ({ ok: false, error: '摄像头画面为全黑帧' });
  r = await tools.invoke('look_camera', { reason: '看看' }, CTX);
  ok(r.ok === false && /全黑帧/.test(r.error), '摄像头黑帧失败如实透传');
  vc._resetForTest();
}

// ============ ⑤ 工具注册表 ============
section('⑤ 工具注册表与 schema');
{
  const names = tools.openAiSchemas().map(s => s.function.name);
  ok(names.includes('look_screen') && names.includes('look_camera'), 'look_screen / look_camera 已注册');
  ok(tools.get('look_screen').permission === 'read' && tools.get('look_camera').permission === 'read', '均为 read 权限（不进写权限卡流）');
}

// ============ ⑥ loop 下发面：vision 闸 × 戏内白名单 × 图像注入 ============
section('⑥ loop 集成：下发面与图像消息注入');
{
  const loop = require(SVC('agent/loop'));
  const runs = require(SVC('agent/runs'));

  let llmScript = [], llmCalls = [];
  llm.streamChat = async ({ messages, withTools, overrides, onChunk, onUsage }) => {
    llmCalls.push({ kind: 'stream', withTools, overrides, messages });
    const turn = llmScript.shift() || { content: '（空）', toolCalls: [], finishReason: 'stop' };
    if (onChunk && turn.content) onChunk(turn.content, turn.content);
    const reasoning = turn.reasoning !== undefined ? turn.reasoning : '（思考）';
    return withTools
      ? { content: turn.content || '', toolCalls: turn.toolCalls || [], finishReason: turn.finishReason || 'stop', reasoning }
      : (turn.content || '');
  };
  llm.genericCompletion = async (messages, opts) => {
    llmCalls.push({ kind: 'generic', messages, opts });
    const turn = llmScript.shift() || { content: '（空）', toolCalls: [] };
    return { content: turn.content || '', toolCalls: turn.toolCalls || [], finishReason: (turn.toolCalls && turn.toolCalls.length) ? 'tool_calls' : 'stop', reasoning: '' };
  };
  llm.stop = () => {};

  const baseMsgs = () => [{ role: 'system', content: 'sys' }, { role: 'user', content: '看看屏幕' }];
  const runOnce = async (instruction) => {
    llmScript = [{ content: '好的。', finishReason: 'stop' }];
    llmCalls = [];
    await loop.startRun({
      reqId: 'q_vc_' + Math.random().toString(36).slice(2, 8), instruction, baseMessages: baseMsgs(),
      onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '不应 error: ' + e.message); },
    });
    return ((llmCalls[0].overrides || {}).tools || []).map(t => t.function.name).sort();
  };

  // 视觉能力闸：无视觉 → 四件视觉工具都不下发
  store.set('api', { model: 'stub-model', vision: 'auto' });
  let names = await runOnce('/order 看看屏幕上是什么');
  ok(!names.includes('look_screen') && !names.includes('look_camera') && !names.includes('read_image') && !names.includes('look_user_avatar'), '无视觉能力：视觉工具族整体不下发');
  ok(names.includes('read_file') && names.includes('web_search'), '其余工具不受影响');

  // 有视觉 → 四件齐发
  store.set('api', { model: 'gpt-4o', vision: 'auto' });
  names = await runOnce('/order 看看屏幕上是什么');
  ok(names.includes('look_screen') && names.includes('look_camera') && names.includes('read_image') && names.includes('look_user_avatar'), '有视觉能力：视觉工具族齐发');

  // 戏内轮（未打标）：只有白名单五件（web_search/save_memory/look_screen/look_camera/look_user_avatar）
  names = await runOnce('帮我看看屏幕上这个报错是什么');
  eq(names, ['look_camera', 'look_screen', 'look_user_avatar', 'save_memory', 'web_search'], '戏内轮工具面 = 白名单五件（含「眼睛」与用户头像）');

  // 全链路：look_screen 执行 → 图像以 user 消息注入（read_image 同款通道）
  store.set('settings', { agent: { visionCapture: { screenEnabled: true } } });
  vc.captureScreen = async () => ({ ok: true, buf: STUB_PNG, mime: 'image/png', width: 1920, height: 1080, resized: false, screens: 1, index: 0, isPrimary: true, foreground: '记事本', selfExcluded: 1, warnings: [], stats: { mean: [1, 1, 1], stddev: [1, 1, 1] } });
  llmScript = [
    { content: '我看一下屏幕。', toolCalls: [{ id: 'c1', name: 'look_screen', argsRaw: JSON.stringify({ track: 'designated', reason: '用户要求' }) }], finishReason: 'tool_calls' },
    { content: '屏幕上是记事本。[情绪:平常]', finishReason: 'stop' },
  ];
  llmCalls = [];
  await loop.startRun({
    reqId: 'q_vc_inject', instruction: '/order 看看屏幕上是什么', baseMessages: baseMsgs(),
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: (e) => { ok(false, '不应 error: ' + e.message); },
  });
  const round2 = llmCalls[1];
  const toolMsg = round2 && round2.messages.find(m => m.role === 'tool');
  ok(toolMsg && toolMsg.content.includes('look_screen') && toolMsg.content.includes('前台窗口'), 'tool 回执落地（含前台窗口）');
  const imgMsg = round2 && round2.messages.find(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
  ok(!!imgMsg, '图像以 user 消息注入（assistant→tool→user 序列）');
  ok(imgMsg && imgMsg.content[0].text.includes('[系统·look_screen]'), '注入标签按实际工具名（look_screen）');
  const asst = round2 && round2.messages.find(m => m.role === 'assistant' && m.tool_calls);
  const imgIdx = round2.messages.indexOf(imgMsg), toolIdx = round2.messages.indexOf(toolMsg), asstIdx = round2.messages.indexOf(asst);
  ok(asstIdx > -1 && asstIdx < toolIdx && toolIdx < imgIdx, '消息序：assistant(tool_calls) → tool → user(图)');

  // 压缩回执按工具名
  const meta = new WeakMap();
  const turns = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'look_camera', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(400) },
    imgMsg2(),
  ];
  function imgMsg2() {
    const m = { role: 'user', content: [{ type: 'text', text: '[系统·look_camera] …' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + 'A'.repeat(100) } }] };
    meta.set(m, { tool: 'look_camera', image: true, path: 'camera:0', images: [{ path: 'camera:0', width: 1280, height: 720 }] });
    return m;
  }
  const n = compactTurns(turns, { budget: 10, isReceipt: () => false, markReceipt: () => {}, metaOf: (m) => meta.get(m) });
  ok(n >= 2, '图像消息与工具回执均被压缩');
  ok(String(turns[2].content).includes('look_camera 的图像') && String(turns[2].content).includes('重新调用 look_camera'), '图像压缩回执按工具名（look_camera）');
}

// ---- 收尾 ----
console.log(`\n========== 视觉捕获回归：${passed} 通过，${failed} 失败 ==========`);
if (failed) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
