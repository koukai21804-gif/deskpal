// ★P0/P1 加固回归（路径A：吸收 Cortico 机制，2026-10-02）：
// 覆盖 markers 显式回执 / 锚点法 token 计量 / 溢出正则（三家真实文案）/ SSE 看门狗分层 /
// 守卫六起事故语料回灌（原话喂正则校准法）/ write_file 覆写保护 / logq CLI 冒烟。
// 用法：node scripts/test-cortico-hardening.js（纯 Node；LLM/Electron 面打桩或绕开）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SVC = p => path.join(ROOT, 'src/main/services', p);

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function section(t) { console.log('\n## ' + t); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async function main() {

// ============ 1. markers：显式回执文案 ============
section('markers.js 未执行回执（P0-1）');
{
  const markers = require(SVC('agent/markers'));
  const len = markers.notExecutedReceipt('length');
  ok(len.startsWith('[未执行]') && len.includes('max_tokens') && len.includes('不可信'), 'length 回执：原因+不可信声明');
  const cut = markers.notExecutedReceipt('stream_cut');
  ok(cut.includes('传输中途断开'), 'stream_cut 回执：断开原因');
  ok(markers.notExecutedReceipt('length', '第2轮').includes('（第2轮）'), 'detail 附加');
  ok(markers.streamPartialNote().startsWith('（系统注记：'), '断流注记走（系统注记：）族（chat.js 剥离规则同族）');
  ok(markers.compactedHistoryNote({ memoryFlushed: true }).includes('固化进长期记忆'), '压缩注记含固化说明');
  ok(!markers.compactedHistoryNote({}).includes('固化'), '未固化时不提固化（只陈述事实）');
}

// ============ 2. 锚点法计量（P0-2） ============
section('token-est 锚点法');
{
  const { tokenEstimate, createAnchoredEstimator } = require(SVC('token-est'));
  const est = createAnchoredEstimator();
  const items = [
    { key: 'm1', content: '一二三四五六七八九十' },          // 10 CJK = 5 token
    { key: 'm2', content: 'abcdefgh' },                       // 8 latin = 2 token
    { key: 'm3', content: '追加的新消息一二三' },
  ];
  const fallback = est.estimate(items, '系统提示五个字');
  ok(!est.hasAnchor(), '未落锚时 hasAnchor=false');
  ok(Math.abs(fallback - (tokenEstimate('系统提示五个字') + 5 + 2 + tokenEstimate('追加的新消息一二三'))) < 1e-9, '未落锚：system+全量估算');
  est.setAnchor({ key: 'm2', promptTokens: 400 });
  ok(est.hasAnchor(), '落锚成功');
  const hit = est.estimate(items, '系统提示五个字');
  ok(Math.abs(hit - (400 + tokenEstimate('追加的新消息一二三'))) < 1e-9, '锚点命中：锚前真实计数 + 锚后估算（system 不重复计）');
  est.setAnchor({ key: 'gone', promptTokens: 999 });
  const miss = est.estimate(items, '系统提示五个字');
  ok(Math.abs(miss - fallback) < 1e-9, '锚点 key 被裁掉：退回全程估算');
  est.setAnchor({ key: 'm1', promptTokens: NaN });
  ok(!est.hasAnchor(), '非法用量（NaN）拒绝落锚');
}

// ============ 3. 溢出正则（P0-4）：三家真实文案 ============
section('llm.isContextOverflow 三家文案');
{
  const { isContextOverflow } = require(SVC('llm'));
  const cases = [
    [400, '{"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 4097 tokens..."}}', true, 'OpenAI code+message'],
    [400, '{"error":{"message":"This model\'s maximum context length is 65536 tokens. However, you requested 1048576 tokens..."}}', true, 'DeepSeek maximum context length'],
    [400, '{"error":{"message":"the request exceeds the available context size, try increasing the context size" }}', true, 'llama-server available context size'],
    [413, 'request too large: context_length_exceeded', true, '413 + code'],
    [400, '{"error":{"message":"Invalid parameter: max_tokens is too large: 100000. This model supports at most 8192."}}', false, 'max_tokens 超限≠溢出'],
    [401, 'unauthorized', false, '401'],
    [429, 'rate limited', false, '429'],
    [400, '{"error":{"message":"The reasoning_content in the thinking mode must be passed back"}}', false, '思考回传 400≠溢出'],
  ];
  for (const [status, body, want, name] of cases) {
    ok(isContextOverflow(status, body) === want, `${name} → ${want ? '溢出' : '非溢出'}`);
  }
}

// ============ 4. SSE 看门狗分层（P0-3） ============
section('llm.createStreamWatchdog 分层触发');
{
  const { createStreamWatchdog } = require(SVC('llm'));
  // 4a：完全无活动 → 帧空闲先触发
  {
    const trips = [];
    const wd = createStreamWatchdog({ limits: { frameIdleMs: 60, contentIdleMs: 120 }, onTrip: (l) => trips.push(l), intervalMs: 10 });
    wd.start();
    await sleep(150);
    ok(trips.length === 1 && trips[0] === 'frame', `无活动 → frame 层（got ${trips.join(',') || '无'}）`);
  }
  // 4b：帧活着（keepalive 每 20ms）但没有内容 → 内容空闲触发（keepalive 不重置内容层）
  {
    const trips = [];
    const wd = createStreamWatchdog({ limits: { frameIdleMs: 500, contentIdleMs: 100 }, onTrip: (l) => trips.push(l), intervalMs: 10 });
    wd.start();
    const keep = setInterval(() => wd.frameActivity(), 20);
    await sleep(220);
    clearInterval(keep); wd.stop();
    ok(trips.length === 1 && trips[0] === 'content', `帧活内容空 → content 层（keepalive 不重置，got ${trips.join(',') || '无'}）`);
  }
  // 4c：内容持续到达 → 不触发
  {
    const trips = [];
    const wd = createStreamWatchdog({ limits: { frameIdleMs: 80, contentIdleMs: 80 }, onTrip: (l) => trips.push(l), intervalMs: 10 });
    wd.start();
    const feed = setInterval(() => wd.contentActivity(), 20);
    await sleep(200);
    clearInterval(feed); wd.stop();
    ok(trips.length === 0, '内容正常流动 → 不误杀');
  }
}

// ============ 5. 守卫六起事故语料回灌（P1-8，原话喂正则校准法） ============
section('守卫事故语料：六起误判全部放行');
{
  const loop = require(SVC('agent/loop'));
  // 事故1（dev.3 表扬轮）：用户表扬既往成果，角色引用真实历史 → 非伪造
  ok(!loop._claimsWrite('谢谢！那份报告我已经写好并保存了', '太棒了，那份报告写得真好'), '事故1 表扬轮引用既往成果：放行');
  // 事故2（dev.4 拒绝轮）：用户明确拒绝 → 守卫整体失效
  ok(!loop._claimsRead('好的，那我不读了，刚才的计划先放一放', '还是不了，阅读整个项目并不适合你'), '事故2 拒绝轮：放行');
  // 事故3（dev.5 禁句当布置）：约束里的「读取」不是任务
  ok(!loop._instructionIsTask('/order 帮我画一下用户画像，但不可以读取本地文件'), '事故3 禁句剥离：不算任务');
  // 事故4（dev.5+1 否定桥）：已归档，不进任何交付物 → 不是「已交付」
  ok(!loop._claimsWrite('本段内容已归档，不进任何交付物，也不写任何文件', '/order 整理会议记录到 note.md'), '事故4 否定断桥：放行');
  // 事故5（dev.5+2 第三者叙述）：主语是第三者
  ok(!loop._claimsRead('它是后验打法：读完所有代码再下结论。', '/order 对比一下你们俩的工作方式，写进对比.md'), '事故5 第三者主语：放行');
  // 事故6（dev.5+3 引号字形）：英文引号内的「已落盘」是转述
  ok(!loop._claimsWrite('台账的原话是"分卷交付"，我在照做', '/order 把进度写入台账'), '事故6 英文引号转述：放行');
}
section('守卫事故语料：真阳性仍然命中');
{
  const loop = require(SVC('agent/loop'));
  ok(loop._claimsWrite('我已经把报告写入 D:\\docs\\a.md 了，共 3000 字。', '/order 帮我把报告写入 D:\\docs\\a.md'), '真阳性：声称写入+零执行');
  ok(loop._claimsRead('我读完了，文件讲的是预算的事。', '/order 读取 D:\\docs\\a.md 并总结'), '真阳性：声称读取');
  ok(loop._claimsSearch('我查了一下，网上的资料说是明天发布。', '/order 查一下发布时间'), '真阳性：声称检索');
}

// ============ 6. write_file 覆写保护（P1-6） ============
section('write_file 覆写保护 shrinkNote');
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-shrink-'));
  const store = require(SVC('store'));
  store.init(TMP);
  const guard = require(SVC('fs-guard'));
  guard.setWriteMode('full');
  const tools = require(SVC('agent/builtin'));
  const target = path.join(TMP, 'doc.md');
  fs.writeFileSync(target, '# 背景\n' + '很长的旧内容'.repeat(30) + '\n# 方案\n' + '更多旧内容'.repeat(30) + '\n# 风险\n' + '尾部旧内容'.repeat(30) + '\n', 'utf8');
  const shrink = tools.invoke('write_file', { path: target, content: '# 新稿\n短内容', reason: '重写' }, { runId: 'r', reqId: 'q' });
  const r1 = await shrink;
  ok(r1.includes('[覆写提醒]'), '骤缩覆写触发提醒');
  ok(r1.includes('背景') && r1.includes('方案') && r1.includes('风险'), '点名消失的小节标题');
  // 正常等量覆写：不打扰
  fs.writeFileSync(target, '# 新稿\n短内容', 'utf8');
  const r2 = await tools.invoke('write_file', { path: target, content: '# 新稿\n短内容再长一点也一样是正常规模的内容', reason: '增补' }, { runId: 'r', reqId: 'q' });
  ok(!String(r2).includes('[覆写提醒]'), '正常覆写不触发');
  // 追加：永不触发（追加不删内容）
  fs.writeFileSync(target, 'x'.repeat(400), 'utf8');
  const r3 = await tools.invoke('write_file', { path: target, content: 'y', append: 'true', reason: '追加' }, { runId: 'r', reqId: 'q' });
  ok(!String(r3).includes('[覆写提醒]'), '追加路径不触发');
}

// ============ 7. logq CLI 冒烟（P1-7） ============
section('logq CLI：runs / turn / bundle');
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-logq-'));
  const runsFile = path.join(TMP, 'runs.jsonl');
  const rec = {
    id: 'run_test123', reqId: 'q1', at: '2026-10-02T10:00:00.000Z', mode: 'full', channel: 'work',
    instruction: '/order 把 api-key sk-abcdefgh1234567890 写入配置并总结。' + '补充很长的任务背景描述。'.repeat(40), steps: [
      { kind: 'llm', round: 1, finishReason: 'tool_calls' },
      { kind: 'notice', notice: 'retry', text: '声称已写入重试', evidence: ['我已经写入了报告'] },
    ], changed: [], finalReply: '完成了。sk-abcdefgh1234567890', retries: 1, status: 'done',
  };
  fs.writeFileSync(runsFile, JSON.stringify(rec) + '\n', 'utf8');
  const run = (args) => execFileSync(process.execPath, [path.join(ROOT, 'scripts/logq.js'), ...args], { encoding: 'utf8', env: { ...process.env, DESKPAL_RUNS: runsFile } });

  const listing = run(['runs']);
  ok(listing.includes('run_test123') && listing.includes('work'), 'runs 清单含 id 与通道');
  const turn = run(['turn', 'run_test123']);
  ok(turn.includes('evidence') && turn.includes('我已经写入了报告'), 'turn 回放含 evidence 原句');
  ok(turn.includes('重试：1'), 'turn 显示守卫重试计数');
  ok(!turn.includes('sk-abcdefgh1234567890'), '默认脱敏：密钥打码');
  ok(turn.includes('--full 看全文'), '默认截断长指令');
  const outMd = path.join(TMP, 'bundle.md');
  run(['bundle', 'run_test123', '--out', outMd]);
  const md = fs.readFileSync(outMd, 'utf8');
  ok(md.includes('# deskpal run run_test123') && !md.includes('sk-abcdefgh1234567890'), 'bundle 导出脱敏 markdown');
  const full = run(['turn', 'run_test123', '--full']);
  ok(!full.includes('sk-abcdefgh1234567890'), '--full 也打码密钥（密钥永不进导出）');
  ok(full.includes('补充很长的任务背景描述。'.repeat(40).slice(-20)), '--full 保留长指令全文');
}

// ============ 8. md.js 链接 href 清洗（导航守卫配套，20261002 GitHub 404 事故） ============section('md.js href 清洗：GFM 自动链接不粘中文');
{
  // md.js 是渲染进程 ES 模块（依赖 window.marked 全局）：读源码包 Function 注入桩环境，
  // 用项目自带的真实 marked 验证——测的是真实渲染管线，不是复刻正则
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/common/md.js'), 'utf8')
    .replace(/export function/g, 'function') + '\nreturn { renderMD, plainPreview };';
  const md = new Function('window', src)({
    marked: require(path.join(ROOT, 'src/renderer/common/vendor/marked/marked.min.js')),
    katex: null,
  });
  // 事故原文本形态：URL 后紧跟全角逗号+中文+句号（marked 会把中文百分号编码进 href）
  const incident = md.renderMD('Cortico 在github的连接是 https://github.com/Pal-AI-Lab/Cortico/tree/main，允许你调用搜索功能阅读。');
  const hrefs = [...incident.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
  ok(hrefs.length >= 1, 'URL 被自动链接渲染');
  ok(hrefs.includes('https://github.com/Pal-AI-Lab/Cortico/tree/main'),
    `href 已截去粘连中文，精确还原仓库地址（got ${JSON.stringify(hrefs)}）`);
  // 合法 CJK 路径 URL（尾部还有 ASCII 路径）不受清洗影响
  const cjk = md.renderMD('[文档](https://example.com/%E6%89%8B%E5%86%8C/page)');
  ok(cjk.includes('href="https://example.com/%E6%89%8B%E5%86%8C/page"'), '合法编码 CJK 路径 URL 原样保留');
  // 正常 markdown 链接不受影响
  const normal = md.renderMD('[仓库](https://github.com/Pal-AI-Lab/Cortico)');
  ok(normal.includes('href="https://github.com/Pal-AI-Lab/Cortico"'), '显式 markdown 链接完好');
  // XSS 防线不回退：HTML 仍先转义
  const xss = md.renderMD('<script>alert(1)</script>');
  ok(!xss.includes('<script>'), 'HTML 转义防线不受清洗影响');
}

// ============ 9. 用量归一化与聚合（外显「本轮 API 消耗」） ============
section('token-est normalizeUsage / createUsageMeter');
{
  const { normalizeUsage, createUsageMeter } = require(SVC('token-est'));
  const d1 = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 200 }, prompt_cache_hit_tokens: 800 });
  ok(d1.input === 1000 && d1.output === 300 && d1.reasoning === 200 && d1.cacheHit === 800, 'DeepSeek 形态归一（含思考与缓存命中）');
  const d2 = normalizeUsage({ prompt_tokens: 500, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 120 } });
  ok(d2.reasoning === null && d2.cacheHit === 120, 'OpenAI 形态归一（cached_tokens、无思考维度）');
  ok(normalizeUsage({}).input === null && normalizeUsage().input === null, '缺用量/空对象：维度为 null 不造数');
  const meter = createUsageMeter();
  meter.add({ prompt_tokens: 1000, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 200 } });
  meter.add({ prompt_tokens: 500.4, completion_tokens: 80 }); // 非整数向下取整在展示层做，聚合层原值累加
  meter.add(null); // 上游没报：不计次不计数
  const snap = meter.snapshot();
  ok(snap.requests === 2, `聚合请求次数（null 用量不计，got ${snap.requests}）`);
  ok(Math.abs(snap.input - 1500.4) < 1e-9 && Math.abs(snap.output - 380) < 1e-9, '输入/回复合计');
  ok(snap.reasoning === 200, '思考合计（未报告的请求不拉低）');
  ok(meter.snapshot().cacheHit === null, '全程未报缓存命中 → null');
}

// ============ 10. /discipline 纪律面板（单一数据源 + 命令识别） ============
section('prompts.MEMORY_DISCIPLINE 与 /discipline 命令');
{
  const prompts = require(SVC('prompts'));
  const d = prompts.MEMORY_DISCIPLINE;
  ok(['extract', 'drift', 'overwrite'].every(k => d[k] && d[k].title && d[k].target && Array.isArray(d[k].items) && d[k].items.length), '三节结构完整（提取/漂移/覆写）');
  ok(prompts.isDisciplineCommand('/discipline') && prompts.isDisciplineCommand('  /DISCIPLINE '), '命令识别（含空白与大小写）');
  ok(!prompts.isDisciplineCommand('/discipline extra') && !prompts.isDisciplineCommand('帮我 /discipline'), '非独立消息不误触');
  // 单一源校验：提示词内容必须由 MEMORY_DISCIPLINE 生成（防止两处漂移）
  const ex = prompts.memoryExtractPrompt('对话…');
  ok(ex.includes('- ' + d.extract.items[0]), '提取提示词嵌入纪律条款（单一源）');
  const drift = prompts.userProfileDriftPrompt({}, '对话…');
  ok(drift.includes('- ' + d.drift.items[0]) && drift.includes('存疑'), '漂移提示词嵌入纪律条款（含矛盾存疑）');
}

console.log(`\n========== 加固回归结果：${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
