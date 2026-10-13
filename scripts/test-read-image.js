// read_image 多模态图片读取回归：能力判定 / 格式嗅探与尺寸解析 / 工具闸 / loop 图像消息注入 /
// 图像消息压缩。真实 fs + 桩 LLM（纯 Node，无 electron）。
// 用法：node scripts/test-read-image.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVC = p => path.join(ROOT, 'src/main/services', p);
const RES_PNG = path.join(ROOT, 'resources', 'pet', 'titor', 'normal.png');

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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-read-image-'));
const store = require(SVC('store'));
store.init(TMP);
const llm = require(SVC('llm'));
const tools = require(SVC('agent/builtin'));
const { compactTurns, estTurns, imageTokensOf } = require(SVC('agent/ctx-compact'));
const iu = require(SVC('agent/image-utils'));
const emotion = require(SVC('emotion'));
emotion.broadcastEmotion = () => {}; // 打桩：跳过窗口广播

// ============ ① 多模态能力判定 ============
section('① 能力判定：三态设置 + 模型名词表（2026-10 时点）');
{
  // 2026-10 主流目录（用户校准 2026-10-11）：正向=多模态在售主力；反向=同厂纯文本系不得误判
  // （误判代价=向不支持图像的接口发 image_url，整个请求 400）
  const CATALOG = [
    // OpenAI：gpt-4o / 4.1 / 5.x（5.6 Sol）/ 6 系（Astra / 6.1 Sol）/ o 系
    ['gpt-4o', true], ['gpt-4o-mini', true], ['gpt-4.1', true], ['gpt-5.6-sol', true],
    ['gpt-6-astra', true], ['gpt-6.1-sol', true], ['o3-mini', true],
    // Anthropic：Opus 5.5 / Fable 5.1（裸 claude 匹配）
    ['claude-opus-5-5', true], ['claude-fable-5.1', true], ['claude-sonnet-4-20250514', true],
    // Google：3.5/3.8 Flash、4 Argon
    ['gemini-2.5-flash', true], ['gemini-3.5-flash', true], ['gemini-3.8-flash', true], ['gemini-4-argon', true],
    // 智谱：glm-5.3-flash 多模态；glm-4 / 4.6 纯文本
    ['glm-4v-plus', true], ['glm-4.5v', true], ['glm-5.3-flash', true],
    ['glm-4', false], ['glm-4.6', false],
    // DeepSeek：V4.1-Flash 起多模态（用户钦点）；V3/R1/chat 纯文本不命中
    ['deepseek-v4.1-flash', true], ['deepseek-v4', true],
    ['deepseek-chat', false], ['deepseek-v3.2-chat', false], ['deepseek-r1', false],
    // 阿里：qwen 数字版 vl/omni/max；旧纯文本 qwen-max/plus 不命中
    ['qwen2.5-vl-72b-instruct', true], ['qwen-vl-plus', true], ['qwen3.8-max', true], ['qvq-max', true],
    ['qwen-plus', false], ['qwen-max', false],
    // 字节：doubao seed 系 / 2.x 全系；doubao-1.5-pro 纯文本不命中
    ['doubao-seed-1.6', true], ['doubao-2.0', true], ['doubao-2.1-pro', true],
    ['doubao-1.5-pro', false],
    // xAI：grok-4.7
    ['grok-4.7', true],
    // 月之暗面：kimi-k3；kimi-k2 纯文本不命中
    ['kimi-k3', true], ['kimi-k2', false],
    // MiniMax：H 系；M 系纯文本不命中
    ['minimax-h3', true], ['minimax-m1', false],
    // 其他：Muse Spark / Nemotron Omni（通用词素 omni）/ 开源视觉系
    ['muse-spark', true], ['nemotron-3-nano-omni', true], ['internvl2-26b', true],
    // 未知名：不误判（漏配可强制开启兜底）
    ['stub-model', false], ['some-gateway-model', false],
  ];
  for (const [m, want] of CATALOG) {
    store.set('api', { model: m, vision: 'auto' });
    eq(llm.isVisionCapable(), want, `auto+${m} → ${want ? '具备' : '不具备'}`);
  }
  // 显式三态优先于词表
  store.set('api', { model: 'deepseek-chat', vision: true });
  eq(llm.isVisionCapable(), true, '强制开启覆盖词表（自建网关的私有模型名）');
  store.set('api', { model: 'gpt-4o', vision: false });
  eq(llm.isVisionCapable(), false, '强制关闭覆盖词表');
  store.set('api', { model: 'gpt-4o', vision: 'auto' });
  eq(llm.isVisionCapable(), true, '恢复 auto');
}

// ============ ② 格式嗅探与尺寸解析 ============
section('② image-utils：魔数嗅探 / 头部尺寸 / token 估算');
{
  // 真实 PNG（宠物立绘）
  const png = fs.readFileSync(RES_PNG);
  eq(iu.sniffMime(png), 'image/png', '真实 PNG 嗅探');
  const pd = iu.imageDims(png, 'image/png');
  ok(pd && pd.width > 0 && pd.height > 0, `真实 PNG 尺寸解析（${pd && pd.width}×${pd && pd.height}）`);

  // 合成 GIF：GIF89a + 逻辑屏幕描述符
  const gif = Buffer.alloc(13);
  gif.write('GIF89a', 0, 'ascii');
  gif.writeUInt16LE(320, 6); gif.writeUInt16LE(240, 8);
  eq(iu.sniffMime(gif), 'image/gif', 'GIF 嗅探');
  eq(iu.imageDims(gif, 'image/gif'), { width: 320, height: 240 }, 'GIF 尺寸');

  // 合成 BMP：BM + DIB 头
  const bmp = Buffer.alloc(30);
  bmp.write('BM', 0, 'ascii');
  bmp.writeInt32LE(640, 18); bmp.writeInt32LE(-480, 22); // 负高（top-down）取绝对值
  eq(iu.sniffMime(bmp), 'image/bmp', 'BMP 嗅探');
  eq(iu.imageDims(bmp, 'image/bmp'), { width: 640, height: 480 }, 'BMP 尺寸（负高取绝对值）');

  // 合成 WEBP（VP8X 扩展头）
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii'); webp.write('WEBP', 8, 'ascii'); webp.write('VP8X', 12, 'ascii');
  webp.writeUIntLE(1000 - 1, 24, 3); webp.writeUIntLE(750 - 1, 27, 3);
  eq(iu.sniffMime(webp), 'image/webp', 'WEBP 嗅探');
  eq(iu.imageDims(webp, 'image/webp'), { width: 1000, height: 750 }, 'WEBP VP8X 尺寸');

  // 合成 JPEG：SOI + APP0（len=14：2 长度字节 + 12 内容）+ SOF0
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x0e, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x00, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x00,
  ]);
  eq(iu.sniffMime(jpeg), 'image/jpeg', 'JPEG 嗅探');
  eq(iu.imageDims(jpeg, 'image/jpeg'), { width: 0x0280, height: 0x01e0 }, 'JPEG SOF0 尺寸（640×480）');

  // 损坏/非图：嗅探拒绝
  eq(iu.sniffMime(Buffer.from('这不是图片，是文本')), null, '文本内容嗅探为 null');
  ok(iu.imageDims(Buffer.alloc(4), 'image/png') === null, '截断 PNG 尺寸解析不抛错（返回 null）');

  // token 估算：OpenAI 高细节贴片公式 + 边界
  eq(imageTokensOf({ width: 2048, height: 2048 }), 4 * 4 * 170 + 85, '2048² → 2805 token');
  eq(imageTokensOf({}), 1500, '缺尺寸 → 兜底 1500');
  eq(imageTokensOf({ width: 1, height: 1 }), 255, '1×1 → 高细节下限 255（1 贴片 170 + 85）');
  // 纯 Node（无 electron.nativeImage）：原样透传不缩放
  const probe = iu.probeImage(png, 'image/png');
  ok(probe.buf === png && probe.resized === false && probe.width === pd.width, '纯 Node 环境透传原字节（nativeImage 不可用）');
}

// ============ ③ read_image 工具闸 ============
section('③ read_image：vision 闸 / 格式校验 / 成功读取');
{
  // vision 关闭（词表+三态都不满足）：幻觉调用被兜底闸拦下
  store.set('api', { model: 'stub-model', vision: 'auto' });
  let err = null;
  try { await tools.invoke('read_image', { path: RES_PNG }); } catch (e) { err = e; }
  ok(err && /图像识别/.test(err.message), 'vision 关闭时调用被拒（提示去设置开启）');

  // 非图片扩展名
  store.set('api', { vision: true });
  const txtPath = path.join(TMP, 'note.txt');
  fs.writeFileSync(txtPath, 'hello', 'utf8');
  err = null;
  try { await tools.invoke('read_image', { path: txtPath }); } catch (e) { err = e; }
  ok(err && /read_file/.test(err.message), '文本扩展名被拒并指路 read_file');

  // 扩展名伪装：内容不是图
  const fakePng = path.join(TMP, 'fake.png');
  fs.writeFileSync(fakePng, 'PNG?其实不是', 'utf8');
  err = null;
  try { await tools.invoke('read_image', { path: fakePng }); } catch (e) { err = e; }
  ok(err && /不是可识别的图片格式/.test(err.message), '内容与扩展名不符被拒（魔数嗅探）');

  // 超 8MB
  const bigPath = path.join(TMP, 'big.png');
  fs.writeFileSync(bigPath, Buffer.alloc(8 * 1024 * 1024 + 1, 1));
  err = null;
  try { await tools.invoke('read_image', { path: bigPath }); } catch (e) { err = e; }
  ok(err && /超过/.test(err.message), '超 8MB 被拒');

  // 敏感路径走 fs-guard 黑名单
  err = null;
  try { await tools.invoke('read_image', { path: path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Vault', 'x.png') }); } catch (e) { err = e; }
  ok(err && /没有权限读取/.test(err.message), '敏感路径被 fs-guard 拒绝');

  // 成功：真实 PNG
  const r = await tools.invoke('read_image', { path: RES_PNG });
  ok(r && r.ok === true && typeof r.text === 'string', '成功读取返回回执文本');
  ok(r.imagePart && r.imagePart.type === 'image_url' && r.imagePart.image_url.url.startsWith('data:image/png;base64,'), 'imagePart 为 data URL');
  ok(!r.text.includes('base64'), '回执文本不含 base64（图像只走 imagePart 通道）');
  ok(r.meta && r.meta.width > 0 && r.meta.height > 0 && r.meta.path === RES_PNG, `meta 带尺寸（${r.meta.width}×${r.meta.height}）`);
  ok(fs.existsSync(RES_PNG), '原图未被改动（读取无副作用）');
}

// ============ ④ loop 图像消息注入（e2e）============
section('④ loop e2e：tool 回执 + user 图像消息 + 协议校验');
{
  const emotionMod = emotion; // 已打桩
  // 桩 LLM：按调用序出牌；带两道真实网关校验回归闸——
  //  ① DeepSeek 思考模式：最后一条 user 之后的 assistant 缺 reasoning_content → 400；
  //  ② tool 块连续性（20261011 实测 400）：assistant(tool_calls) 之后每个 tool_call_id 必须
  //     在「紧随的连续 tool 消息 run」内得到响应，被 user/system 劈开即 400
  //     「insufficient tool messages following tool_calls message」
  let llmScript = [], llmCalls = [];
  llm.streamChat = async ({ messages, withTools, overrides, onChunk, onUsage }) => {
    llmCalls.push({ withTools, overrides, messages });
    {
      let lastUser = -1;
      messages.forEach((m, i) => { if (m.role === 'user') lastUser = i; });
      for (let i = lastUser + 1; i < messages.length; i++) {
        const m = messages[i];
        if (m.role === 'assistant' && !String(m.reasoning_content || '').trim()) {
          throw new Error('接口返回 400：reasoning_content must be passed back');
        }
      }
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          const expect = new Set(m.tool_calls.map(tc => tc.id));
          let j = i + 1;
          while (j < messages.length && messages[j].role === 'tool') { expect.delete(messages[j].tool_call_id); j++; }
          if (expect.size) throw new Error('接口返回 400：insufficient tool messages following tool_calls message');
        }
      }
    }
    const turn = llmScript.shift() || { content: '（空）', toolCalls: [], finishReason: 'stop' };
    if (onChunk && turn.content) onChunk(turn.content, turn.content);
    if (onUsage) onUsage({ prompt_tokens: 100, completion_tokens: 10 });
    return {
      content: turn.content || '', toolCalls: turn.toolCalls || [],
      finishReason: turn.finishReason || 'stop', reasoning: turn.reasoning || 'r',
      streamCut: false, committed: false,
    };
  };

  const runs = require(SVC('agent/runs'));
  const loop = require(SVC('agent/loop'));

  // 场景 A：vision 开启，单次 read_image
  store.set('api', { model: 'stub-model', vision: true });
  store.set('settings', { agent: { enabled: true, permissionMode: 'read' } });
  llmScript = [
    { content: '[进展:设计] 读取图片', toolCalls: [{ id: 'c1', name: 'read_image', argsRaw: JSON.stringify({ path: RES_PNG }) }], finishReason: 'tool_calls' },
    { content: '图里是缇托的立绘。[情绪:开心]', finishReason: 'stop' },
  ];
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_img_1', instruction: '/order 看一下这张图里是什么', baseMessages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '/order 看一下这张图里是什么' }],
    onFinal: async () => ({ msgId: 'm_img_1' }),
    onDone: () => {}, onAborted: () => ok(false, '不应 abort'), onError: (e) => ok(false, '不应 error: ' + e.message),
  });

  ok(llmCalls[0].overrides.tools.some(t => t.function.name === 'read_image'), 'vision 开启 → read_image schema 下发');
  const round2 = llmCalls[1];
  const toolMsg = round2.messages.find(m => m.role === 'tool');
  ok(toolMsg && toolMsg.tool_call_id === 'c1' && toolMsg.content.includes('[read_image]'), 'tool 回执消息（短文本，无图像）');
  ok(!toolMsg.content.includes('base64'), 'tool 消息不含 base64（协议：tool content 必须是字符串）');
  const imgMsgs = round2.messages.filter(m => m.role === 'user' && Array.isArray(m.content));
  ok(imgMsgs.length === 1, '恰好一条 user 图像消息');
  const imgMsg = imgMsgs[0];
  ok(imgMsg.content[0].type === 'text' && imgMsg.content[0].text.includes('read_image'), '图像消息含文本说明部分');
  ok(imgMsg.content[1] && imgMsg.content[1].type === 'image_url' && imgMsg.content[1].image_url.url.startsWith('data:image/png;base64,'), '图像消息含 image_url data URL');
  const roles = round2.messages.map(m => m.role + (Array.isArray(m.content) ? ':img' : '')).join(' → ');
  ok(/assistant → tool → user:img/.test(roles), `消息序合法（${roles}）`);
  const rec = runs.query({}).runs.find(r => r.reqId === 'chat_img_1');
  ok(rec && rec.status === 'done', 'run done');
  const tstep = rec.steps.find(s => s.kind === 'tool' && s.tool === 'read_image');
  ok(tstep && tstep.ok === true && /\d+×\d+/.test(tstep.summary), `台账步骤带尺寸摘要（${tstep && tstep.summary}）`);

  // 场景 B：同轮两个 read_image（20261011 实测 400 回归）——tool 块连续、两图合并一条 user 消息
  llmScript = [
    { content: '[进展:设计] 读取两张图', toolCalls: [
      { id: 'c1', name: 'read_image', argsRaw: JSON.stringify({ path: RES_PNG }) },
      { id: 'c2', name: 'read_image', argsRaw: JSON.stringify({ path: RES_PNG }) },
    ], finishReason: 'tool_calls' },
    { content: '两张是同一张立绘。[情绪:平常]', finishReason: 'stop' },
  ];
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_img_2', instruction: '/order 对比这两张图', baseMessages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '/order 对比这两张图' }],
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => ok(false, '不应 abort'),
    onError: (e) => ok(false, '不应 error: ' + e.message),
  });
  const r2b = llmCalls[1];
  const toolsB = r2b.messages.filter(m => m.role === 'tool');
  ok(toolsB.length === 2 && toolsB.every(m => String(m.content).includes('[read_image]')), '两个 tool 回执消息齐全');
  const imgsB = r2b.messages.filter(m => m.role === 'user' && Array.isArray(m.content));
  ok(imgsB.length === 1 && imgsB[0].content.filter(p => p.type === 'image_url').length === 2, '两张图合并为一条 user 消息（2 个 image_url 部分）');
  ok(r2b.messages.indexOf(toolsB[1]) < r2b.messages.indexOf(imgsB[0]), 'tool 块整体先于图像消息（连续不被劈开）');
  ok(imgsB[0].content[0].text.includes('共 2 张'), '图像消息文本说明含张数与路径');
  const recB = runs.query({}).runs.find(r => r.reqId === 'chat_img_2');
  ok(recB && recB.status === 'done', '多图轮 run done');

  // 场景 C：跨多轮读图（图像轮之后又发起工具调用）——历史里的图像消息不得破坏后续 tool 块
  llmScript = [
    { content: '[进展:设计] 先看图', toolCalls: [{ id: 'c1', name: 'read_image', argsRaw: JSON.stringify({ path: RES_PNG }) }], finishReason: 'tool_calls' },
    { content: '[进展:设计] 再确认目录', toolCalls: [{ id: 'c2', name: 'list_dir', argsRaw: JSON.stringify({ path: TMP }) }], finishReason: 'tool_calls' },
    { content: '看完了。[情绪:平常]', finishReason: 'stop' },
  ];
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_img_3', instruction: '/order 看图后列目录', baseMessages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '/order 看图后列目录' }],
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => ok(false, '不应 abort'),
    onError: (e) => ok(false, '不应 error: ' + e.message),
  });
  const r3 = llmCalls[2].messages;
  const imgsC = r3.filter(m => m.role === 'user' && Array.isArray(m.content));
  ok(imgsC.length === 1, '历史中恰好一条图像消息');
  ok(r3.indexOf(imgsC[0]) < r3.findIndex(m => m.role === 'assistant' && m.tool_calls && m.tool_calls[0].id === 'c2'), '图像消息位于后续 assistant(tool_calls) 之前（其前块已完整闭合）');
  const recC = runs.query({}).runs.find(r => r.reqId === 'chat_img_3');
  ok(recC && recC.status === 'done', '多轮 run done（桩连续性校验全程未触发）');

  // 场景 D：vision 关闭 → schema 不下发
  store.set('api', { model: 'stub-model', vision: false });
  llmScript = [{ content: '无图可看', finishReason: 'stop' }];
  llmCalls = [];
  await loop.startRun({
    reqId: 'chat_img_4', instruction: '/order 看一下这张图', baseMessages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '/order 看一下这张图' }],
    onFinal: async () => ({}), onDone: () => {}, onAborted: () => {}, onError: () => ok(false, '不应 error'),
  });
  ok(!llmCalls[0].overrides.tools.some(t => t.function.name === 'read_image'), 'vision 关闭 → read_image schema 不下发');
}

// ============ ⑤ 图像消息压缩 ============
section('⑤ ctx-compact：图像消息预算与压缩回执');
{
  const mkImg = () => ({
    role: 'user',
    content: [
      { type: 'text', text: '[系统·read_image] 图像结果如下' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(100000) } },
    ],
  });
  const metaOf = new Map();
  const metaFor = (m) => metaOf.get(m) || null;

  // estTurns：图像按贴片公式计（10 万字符 base64 不按字符估——那会把预算虚高两个量级），
  // 文本部分仍按字符估（'abc' → 3×0.25）
  const t1 = [{ role: 'user', content: [{ type: 'text', text: 'abc' }, { type: 'image_url', image_url: { url: 'x' } }] }];
  metaOf.set(t1[0], { width: 2048, height: 2048 });
  eq(estTurns(t1, metaFor), imageTokensOf({ width: 2048, height: 2048 }) + 0.75, '图像按贴片公式 + 文本按字符计');
  const t2 = [mkImg()];
  eq(estTurns(t2, () => ({})), 1500 + 7.5, '缺尺寸图像按兜底 1500 计（base64 长度不计入；文本 15 字符=7.5）');
  // 多图合一条消息（loop 注入形态）：meta.images 逐张求和
  const t3 = [mkImg()];
  metaOf.set(t3[0], { images: [{ width: 2048, height: 2048 }, {}, {}] });
  eq(estTurns(t3, metaFor), 2805 + 1500 + 1500 + 7.5, '多图消息逐张求和（2805+1500+1500+文本）');

  // compactTurns：预算内零动作
  {
    const turns = [mkImg()];
    metaOf.set(turns[0], { width: 1024, height: 768, path: '/x/a.png' });
    const n = compactTurns(turns, { budget: 5000, isReceipt: new WeakSet().has.bind(new WeakSet()), markReceipt() {}, metaOf: metaFor });
    eq(n, 0, '预算内不压缩');
    ok(Array.isArray(turns[0].content), '图像消息原样保留');
  }
  // compactTurns：超预算 → 图像消息换成机械回执；watermark 之后的最新轮不压缩
  {
    const turns = [mkImg(), mkImg()];
    metaOf.set(turns[0], { width: 2048, height: 2048, path: '/x/a.png' });
    metaOf.set(turns[1], { width: 2048, height: 2048, path: '/x/b.png' });
    const receipts = new WeakSet();
    const n = compactTurns(turns, {
      budget: 3000, watermark: 2,
      isReceipt: (m) => receipts.has(m), markReceipt: (m) => receipts.add(m), metaOf: metaFor,
    });
    ok(n >= 1, `触发压缩（${n} 条）`);
    ok(typeof turns[0].content === 'string' && turns[0].content.includes('[已压缩] read_image') && turns[0].content.includes('/x/a.png'), '最老图像 → 机械回执（带路径，可重读）');
    ok(Array.isArray(turns[1].content), '第二张（预算再次超限时才压缩）此轮仍保留或已按需压缩');
    // 若第二条也被压缩（预算 3000 < 2×2805），必须同样是回执形态
    if (typeof turns[1].content === 'string') ok(turns[1].content.includes('/x/b.png'), '第二张同样压缩为回执');
    // 压缩后总预算回落
    ok(estTurns(turns, metaFor) <= 3000 + 200, '压缩后回落到预算附近');
  }
  // compactTurns：多图合一条消息 → 回执报张数与路径
  {
    const turns = [mkImg(), mkImg()];
    metaOf.set(turns[0], { images: [{ path: '/x/1.png', width: 2048, height: 2048 }, { path: '/x/2.png' }] });
    metaOf.set(turns[1], { width: 2048, height: 2048, path: '/x/b.png' });
    const receipts = new WeakSet();
    compactTurns(turns, { budget: 3000, watermark: 2, isReceipt: m => receipts.has(m), markReceipt: m => receipts.add(m), metaOf: metaFor });
    ok(typeof turns[0].content === 'string' && turns[0].content.includes('共 2 张') && turns[0].content.includes('/x/1.png'), '多图消息压缩回执报张数与路径');
    ok(Array.isArray(turns[1].content), '预算回落后的第二条图像保留');
  }
  // 字符串内容消息不受影响（baseMessages 形态兼容）
  {
    const turns = [{ role: 'tool', content: 'x'.repeat(100) }];
    const receipts = new WeakSet();
    compactTurns(turns, { budget: 10, isReceipt: (m) => receipts.has(m), markReceipt: (m) => receipts.add(m), metaOf: () => null });
    ok(turns[0].content.includes('[已压缩]'), '普通 tool 消息压缩行为不回归');
  }
}

// ============ 收尾 ============
console.log(`\n========== 结果：${passed} 通过 / ${failed} 失败 ==========`);
if (failed > 0) { console.error('FAILED'); process.exit(1); }
console.log('PASSED');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
