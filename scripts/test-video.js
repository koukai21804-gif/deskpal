// 视频解析 + 自由提问模式 + 陪读足迹 回归：平台识别/URL 安全校验/字幕解析/分桶/文稿构建/
// ffmpeg 时长解析/ASR 端点归一/工具导入与探测/通读窗口全覆盖/视频入库/自由模式生成与问答/
// 足迹摘要与注入。纯 Node（无 electron），LLM 与子进程用桩或 process.execPath。
// 用法：node scripts/test-video.js
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
function throwsWith(fn, re, name) {
  try { fn(); ok(false, name + '（没有抛错）'); }
  catch (e) { ok(re.test(e.userMsg || e.message || ''), `${name}（${(e.userMsg || e.message).slice(0, 40)}）`); }
}

(async function main() {

// ---- 环境：隔离 userData ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-video-'));
const store = require(SVC('store'));
store.init(TMP);
const video = require(SVC('video'));
const reading = require(SVC('reading'));
const prompts = require(SVC('prompts'));
const llm = require(SVC('llm'));
const emotion = require(SVC('emotion'));
emotion.broadcastEmotion = () => {}; // 打桩：跳过窗口广播

// ============ ① 平台识别与 URL 校验 ============
section('① 平台识别与 URL 安全校验');
{
  const nv = video.normalizeVideoSource;
  ok(nv('https://www.bilibili.com/video/BV1xx411c7mD').platform === 'bilibili', 'bilibili 标准页 → bilibili');
  ok(nv('https://b23.tv/AbCdEf').platform === 'bilibili', 'b23.tv 短链 → bilibili');
  ok(nv('https://m.bilibili.com/video/BV1xx').platform === 'bilibili', 'm.bilibili 子域 → bilibili');
  ok(nv('https://www.youtube.com/watch?v=dQw4w9WgXcQ').platform === 'youtube', 'youtube watch → youtube');
  ok(nv('https://youtu.be/dQw4w9WgXcQ').platform === 'youtube', 'youtu.be 短链 → youtube');
  ok(nv('http://example.com/video.mp4').platform === 'direct', '.mp4 直链 → direct');
  ok(nv('https://cdn.example.com/a/b/c.mp4?token=1').platform === 'direct', '带 query 的 .mp4 → direct');
  throwsWith(() => nv('https://example.com/page.html'), /仅支持.*Bilibili/i, '非 mp4 直链被拒');
  throwsWith(() => nv('ftp://example.com/v.mp4'), /HTTP\/HTTPS/i, 'ftp 协议被拒');
  throwsWith(() => nv('https://user:pass@example.com/v.mp4'), /HTTP\/HTTPS/i, '带凭据 URL 被拒');
  throwsWith(() => nv('http://localhost/x.mp4'), /内网|本机/i, 'localhost 被拒');
  throwsWith(() => nv('http://127.0.0.1/x.mp4'), /内网|本机/i, '127.0.0.1 被拒');
  throwsWith(() => nv('http://192.168.1.5/x.mp4'), /内网|本机/i, '192.168.x 被拒');
  throwsWith(() => nv('http://10.0.0.8/x.mp4'), /内网|本机/i, '10.x 被拒');
  throwsWith(() => nv('http://172.16.0.9/x.mp4'), /内网|本机/i, '172.16.x 被拒');
  throwsWith(() => nv('not a url'), /格式无效/i, '非法字符串被拒');
  throwsWith(() => nv(''), /有效的视频链接/i, '空串被拒');
}

// ============ ② 字幕解析（VTT/SRT → cue） ============
section('② 字幕解析：VTT / SRT、去重、时间戳');
{
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000 align:start position:0%
第一句<v其>介绍</v其>

00:00:03.000 --> 00:00:05.000
第一句介绍

00:00:05.000 --> 00:00:07.000
第二句来了`;
  const cues = video.parseSubtitles(vtt);
  ok(cues.length === 2, `VTT 解析出 2 条 cue（got ${cues.length}）`);
  ok(cues[0].startSeconds === 1 && cues[0].endSeconds === 3, 'cue 时间戳正确（秒）');
  ok(cues[0].text === '第一句介绍', '行内定位标签被剥离：' + cues[0].text);
  ok(cues[1].text === '第二句来了', '连续滚动词去重生效（自动字幕常见）');

  const srt = `1
00:00:10,500 --> 00:00:12,000
SRT 第一条

2
00:00:12,500 --> 00:00:14,000
SRT 第二条`;
  const srtCues = video.parseSubtitles(srt);
  ok(srtCues.length === 2 && srtCues[0].startSeconds === 10.5, 'SRT 格式同样可解析（逗号毫秒）');

  ok(video.tsToSeconds('02:03') === 123, 'tsToSeconds 分:秒');
  ok(video.tsToSeconds('01:02:03') === 3723, 'tsToSeconds 时:分:秒');
  ok(video.tsToSeconds('abc') === null, 'tsToSeconds 非法输入 → null');
}

// ============ ③ 分桶与文稿构建 ============
section('③ cue 分桶（5 分钟粒度）与 markdown 文稿');
{
  const cues = [
    { startSeconds: 0, endSeconds: 10, text: '开头' },
    { startSeconds: 20, endSeconds: 30, text: '开头' },      // 同桶去重
    { startSeconds: 320, endSeconds: 330, text: '第二桶' },  // 5:20 → 300 桶
    { startSeconds: 700, endSeconds: 710, text: '第三桶' },  // 11:40 → 600 桶
  ];
  const buckets = video.bucketCues(cues, 300, 800);
  ok(buckets.length === 3, `分桶数量 3（got ${buckets.length}）`);
  ok(buckets[0].text === '开头' && !buckets[0].text.includes('开头 开头'), '桶内重复文本去重');
  ok(buckets[1].startSeconds === 300 && buckets[2].endSeconds === 800, '桶起点取整 300s、末桶终点受总时长收口');

  const md = video.buildTranscriptMarkdown({
    title: '三分钟看懂傅里叶变换', url: 'https://b23.tv/x', platform: 'bilibili',
    uploader: '某科普UP', durationSeconds: 3725, sections: buckets,
  });
  ok(md.startsWith('# 三分钟看懂傅里叶变换'), '文稿以标题开头');
  ok(md.includes('平台：Bilibili') && md.includes('作者：某科普UP'), '平台与作者进头部');
  ok(md.includes('时长：01:02:05'), '时长格式化 时:分:秒');
  ok(/## 00:00-05:00/.test(md) && /## 10:00-13:20/.test(md), '分节时间戳 00:00-05:00 / 10:00-13:20');
  const md2 = video.buildTranscriptMarkdown({ title: 'T', sections: [] });
  ok(!md2.includes('平台：') && !md2.includes('时长：'), '空字段整行省略');
}

// ============ ④ ffmpeg 时长解析 + ASR 端点归一 ============
section('④ ffmpeg 时长解析与 ASR 端点归一');
{
  const stderr = `Input #0, mov,mp4,m4a, from 'a.mp4':
  Duration: 01:02:03.04, start: 0.000000, bitrate: 1234 kb/s`;
  ok(Math.abs(video.parseDurationFromFfmpeg(stderr) - 3723.04) < 0.001, 'Duration: HH:MM:SS.ms 解析');
  ok(video.parseDurationFromFfmpeg('no duration here') === 0, '无 Duration → 0');
  ok(video.asrEndpointOf('https://api.siliconflow.cn/v1') === 'https://api.siliconflow.cn/v1/audio/transcriptions', 'base 地址补 /audio/transcriptions');
  ok(video.asrEndpointOf('https://open.bigmodel.cn/api/paas/v4/audio/asr') === 'https://open.bigmodel.cn/api/paas/v4/audio/asr', '完整 audio 端点原样保留（智谱 /audio/asr）');
  ok(video.asrEndpointOf('https://api.x.com/v1/') === 'https://api.x.com/v1/audio/transcriptions', '尾斜杠先剥再补');
  ok(video.asrEndpointOf('') === '', '空地址 → 空');
}

// ============ ⑤ 工具链：导入 / 探测 / 候选顺序 ============
section('⑤ 工具链：importBinary 复制入 bin、probeBinary 手动路径可探测');
{
  // 导入：把当前 node 可执行文件当「yt-dlp」导入（只验证复制与命名）
  const fakeSrc = path.join(TMP, 'fake-yt-dlp.exe');
  fs.copyFileSync(process.execPath, fakeSrc);
  const r = video.importBinary('ytDlp', fakeSrc);
  ok(r.ok && fs.existsSync(r.path), '导入成功且落盘');
  ok(path.basename(r.path).startsWith('yt-dlp'), '落盘名是发行名 yt-dlp*（PATH 兜底同名可命中）');
  // 探测：手动路径指向真 node → --version 可跑通（runProcess 全链路）
  store.set('settings', { video: { ytDlpPath: process.execPath, ffmpegPath: '' } });
  const probe = await video.probeBinary('ytDlp');
  ok(probe.found && /v\d/.test(probe.version), `手动路径探测成功（${probe.version}）`);
  const rt = await video.probeRuntime();
  ok(rt.ytDlp.found, 'probeRuntime 聚合：手动路径的 yt-dlp 被找到');
  ok(rt.ready === (rt.ytDlp.found && rt.ffmpeg.found), 'ready = 两个工具都在（PATH 里本机有 ffmpeg 也如实反映）');
  store.set('settings', { video: { ytDlpPath: '', ffmpegPath: '' } });
  // bin 目录里的导入件现在应被数据目录/bin 候选命中
  const probe2 = await video.probeBinary('ytDlp');
  ok(probe2.found && probe2.path === r.path, '数据目录/bin 候选命中刚导入的文件');
  throwsWith(() => video.importBinary('unknown', fakeSrc), /未知的工具类型/i, '未知工具类型被拒');
  throwsWith(() => video.importBinary('ytDlp', path.join(TMP, 'nope.exe')), /文件不存在/i, '源文件不存在被拒');
}

// ============ ⑥ 通读窗口：全覆盖不跳读 ============
section('⑥ digestWindows：短文一段、长文衔接、超长放大窗宽');
{
  const dw = reading.digestWindows;
  ok(dw('').length === 0, '空文本 → 0 窗');
  ok(dw('短文本').length === 1 && dw('短文本')[0] === '短文本', '≤1 万字 → 单窗整读');
  const t12k = 'a'.repeat(12000);
  const w2 = dw(t12k);
  ok(w2.length === 2 && w2[0].length === 10000 && w2[1].endsWith('a') && w2[1].length >= 2000, '1.2 万字 → 2 窗，末窗读到结尾');
  // 覆盖性：拼接所有窗起点-终点区间应无缺口（相邻窗首尾相接或重叠）
  const t100k = Array.from({ length: 100000 }, (_, i) => String(i % 10)).join('');
  const w100 = dw(t100k);
  ok(w100.length === 10, `10 万字 → 10 窗（got ${w100.length}）`);
  let covered = true;
  for (let i = 1; i < w100.length; i++) {
    const prevEnd = w100.slice(0, i).reduce((n, s) => n + 0, 0); // 占位，实际按下式核对
    void prevEnd;
  }
  // 直接核对：重建每窗在原文中的区间（按内容长度逐步推进）
  let pos = 0;
  const ranges = [];
  for (const w of w100) {
    const idx = t100k.indexOf(w.slice(0, 50), Math.max(0, pos - 100));
    ranges.push([idx, idx + w.length]);
    pos = idx + w.length;
  }
  for (let i = 1; i < ranges.length; i++) ok2(ranges[i][0] <= ranges[i - 1][1], '窗 ' + i);
  function ok2(cond, name) { ok(cond, name + ' 与上一窗无缺口'); }
  // 超长 30 万字：12 窗全读完（窗宽放大到 25000）
  const t300k = 'b'.repeat(300000);
  const w300 = dw(t300k);
  ok(w300.length === reading.DIGEST_MAX_WINDOWS, `30 万字 → ${reading.DIGEST_MAX_WINDOWS} 窗`);
  ok(w300.reduce((n, w) => n + w.length, 0) >= 300000, '总覆盖 ≥ 全文长度（无跳读，含必要重叠）');
  ok(w300.every(w => w.length <= 26000), '窗宽放大但受控（≤2.6 万）');
}

// ============ ⑦ 视频入库：uploadVideo 成功/失败路径 ============
section('⑦ uploadVideo：转写文稿入库与短内容拒绝');
{
  const md = video.buildTranscriptMarkdown({
    title: '线性代数的本质', platform: 'bilibili', url: 'https://b23.tv/x',
    durationSeconds: 600, sections: [{ startSeconds: 0, endSeconds: 600, text: '向量是空间中的箭头。'.repeat(30) }],
  });
  const origParse = video.parseVideo;
  video.parseVideo = async (input, opts) => {
    ok(!!opts && typeof opts.onProgress === 'function', 'uploadVideo 向 parseVideo 传入进度回调');
    opts.onProgress({ stage: 'subtitles', pct: 30, message: '抓字幕中' });
    return { markdown: md, meta: { title: '线性代数的本质', platform: 'bilibili', durationSeconds: 600, transcriptSource: 'subtitles', chars: md.length } };
  };
  const r = await reading.uploadVideo({ url: 'https://b23.tv/x' });
  ok(r.bookId && r.meta.source === 'video' && r.meta.format === 'video', '视频书入库：meta.source/format=video');
  const lib = store.readJSON('library/' + r.bookId + '.json', null);
  const book = store.readJSON('books/' + r.bookId + '.json', null);
  ok(lib && lib.status === 'parsed' && lib.mode === 'flow', '新视频书状态 parsed、默认模式 flow（等用户选）');
  ok(book && book.text.startsWith('# 线性代数的本质'), '转写 markdown 存入正文');
  const list = reading.list();
  ok(list.find(b => b.id === r.bookId && b.isVideo && b.title === '线性代数的本质'), '书库列表含视频标记');
  // 过短内容拒绝
  video.parseVideo = async () => ({ markdown: '# 短\n\n## 00:00-00:01\n\n嗯', meta: { chars: 20 } });
  let threw = null;
  try { await reading.uploadVideo({ url: 'https://b23.tv/y' }); } catch (e) { threw = e; }
  ok(threw && /文字太少/.test(threw.userMsg || ''), '转写过短 → 友好拒绝（不建垃圾书）');
  // URL 校验前置：parseVideo 不应被调到（非法 URL 直接拒）
  video.parseVideo = async () => { throw new Error('不应执行到这里'); };
  let threw2 = null;
  try { await reading.uploadVideo({ url: 'https://example.com/page.html' }); } catch (e) { threw2 = e; }
  ok(threw2 && /仅支持/.test(threw2.userMsg || ''), '非法直链在校验层即被拒');
  video.parseVideo = origParse;
}

// ============ ⑧ 自由提问模式：生成（通读笔记） ============
section('⑧ 自由提问模式：generate(mode=free) 通读 → 笔记 → ready');
{
  // 准备一本 2.5 万字的书（3 窗通读）
  const text = Array.from({ length: 25000 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('');
  const id = 'bk_free1';
  store.writeJSON('books/' + id + '.json', { id, meta: { title: '测试书', chars: text.length }, text, createdAt: '2026-10-11T00:00:00' });
  store.writeJSON('library/' + id + '.json', {
    id, title: '测试书', meta: { title: '测试书' }, status: 'parsed', error: null, mode: 'flow',
    notes: null, outline: null, sections: [], frames: [], qa: [], cursor: null,
    createdAt: '2026-10-11T00:00:00', updatedAt: '2026-10-11T00:00:00',
  });
  const origGen = llm.genericCompletion;
  let calls = 0;
  llm.genericCompletion = async (messages, opts) => {
    calls++;
    ok(Array.isArray(messages) && messages[0].role === 'system', `通读第 ${calls} 调用是 system 提示`);
    if (calls === 1) return '```主题：测试书通读笔记第一版。核心概念：示例概念A，指代首窗内容，附带一句术语解释。结构：开篇引入、概念定义、例证推演三个层次，本窗覆盖原文前段。```';
    return '主题：测试书通读笔记（更新版）。核心概念：示例概念A与B，第二窗并入新证据后合并成一条，术语解释保留。结构：开篇引入、概念定义、例证推演、章末收束四个层次，覆盖全文。';
  };
  await reading.generate(id, { mode: 'free' });
  // generate 是后台异步：轮询等终态
  const final = await waitFor(() => {
    const l = store.readJSON('library/' + id + '.json', null);
    return l && l.status !== 'generating' ? l : null;
  }, 15000);
  llm.genericCompletion = origGen;
  ok(final && final.status === 'ready' && final.mode === 'free', '终态 ready + mode=free');
  ok(calls === 3, `2.5 万字 → 3 次通读调用（got ${calls}）`);
  ok(/（更新版）/.test(final.notes || ''), '滚动笔记消化为最终版');
  ok(!/```/.test(final.notes || ''), '笔记剥掉代码围栏');
  ok((final.notes || '').length <= reading.DIGEST_WINDOW_CHARS * 0 + 3000, '笔记落库受 3000 字上限');
}
// 等待 helper
async function waitFor(fn, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const r = fn();
    if (r) return r;
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise(r2 => setTimeout(r2, 50));
  }
}

// ============ ⑨ 自由提问模式：问答走 free 提示词 ============
section('⑨ ask()：free 模式用通读笔记提示词，flow 模式维持节次上下文');
{
  // 造一本 ready 的 free 书 + 一本 ready 的 flow 书
  store.writeJSON('books/bk_free2.json', { id: 'bk_free2', meta: {}, text: '向量加法满足交换律。矩阵乘法不满足交换律。'.repeat(50), createdAt: '2026-10-11T01:00:00' });
  store.writeJSON('library/bk_free2.json', {
    id: 'bk_free2', title: '线代速览', meta: { source: 'video', platform: 'bilibili' }, status: 'ready', mode: 'free',
    notes: '主题：线性代数。核心：向量空间、矩阵乘法不可交换。', outline: null, sections: [], frames: [],
    qa: [], cursor: null, createdAt: '2026-10-11T01:00:00', updatedAt: '2026-10-11T01:00:00',
  });
  store.writeJSON('library/bk_flow2.json', {
    id: 'bk_flow2', title: '小说一本', meta: {}, status: 'ready', mode: 'flow', notes: null,
    outline: [{ id: 's1', title: '第一节', summary: '', keyPoints: [], mood: 'normal', quizIntent: '' }],
    sections: [], frames: [{ id: 'f0_0', type: 'dialogue', sectionId: 's1', mood: 'normal', text: 'x', bb: '' }],
    qa: [], cursor: 'f0_0', createdAt: '2026-10-11T01:00:00', updatedAt: '2026-10-11T02:00:00',
  });
  const origStream = llm.streamChat;
  const captured = [];
  llm.streamChat = async ({ messages }) => {
    captured.push(messages[0].content);
    return '向量加法可交换。[情绪:思考]';
  };
  await reading.ask('bk_free2', '向量加法满足什么律？');
  await reading.ask('bk_flow2', '主角为什么离开？');
  await waitFor(() => captured.length >= 2 && store.readJSON('library/bk_free2.json', null).qa.length >= 1, 8000);
  llm.streamChat = origStream;
  ok(captured.length >= 2, '两次 ask 各发起一次流式问答');
  const freePrompt = captured[0] || '', flowPrompt = captured[1] || '';
  ok(/通读笔记/.test(freePrompt) && /安静等待/.test(freePrompt), 'free 模式提示词含通读笔记与静候设定');
  ok(!/当前读到/.test(freePrompt), 'free 模式不再引用剧情节次');
  ok(/当前读到/.test(flowPrompt) && /第一节/.test(flowPrompt), 'flow 模式维持当前节上下文');
  const libF = store.readJSON('library/bk_free2.json', null);
  ok((libF.qa || []).length === 1 && /交换/.test(libF.qa[0].a), 'free 问答入档（qa 数组）');
  // 未就绪的书拒绝提问
  store.writeJSON('library/bk_parsing.json', { id: 'bk_parsing', title: 'x', meta: {}, status: 'parsed', mode: 'flow', qa: [], frames: [], createdAt: '', updatedAt: '' });
  let threwQa = null;
  try { await reading.ask('bk_parsing', '问'); } catch (e) { threwQa = e; }
  ok(threwQa && /还没准备好/.test(threwQa.userMsg || ''), 'parsed 状态提问被拒（友好文案）');
}

// ============ ⑩ 陪读足迹：listDigest + prompts 注入 ============
section('⑩ 陪读足迹：listDigest 摘要与 roleplaySystem 注入');
{
  // ⑧ 留下的 bk_free1（测试书）已完成使命，移出本节计数
  try { fs.unlinkSync(path.join(TMP, 'library', 'bk_free1.json')); fs.unlinkSync(path.join(TMP, 'books', 'bk_free1.json')); } catch (_) {}
  // 桩时间戳用「当前时间 + N 小时」：⑨ 的 ask() 会把 bk_free2 的 updatedAt 刷成真实 now，
  // 固定写死时间（如 05:00）在下午跑测试时会被 ask 的新时间盖过 → 足迹排序断言随时刻漂移
  const at = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();
  // 上面已造好：bk_free2（ready/free、有qa）、bk_flow2（ready/flow、有cursor）——重写刷新时间戳
  const f2 = store.readJSON('library/bk_free2.json', null);
  if (f2) { f2.updatedAt = at(1); store.writeJSON('library/bk_free2.json', f2); }
  const fl2 = store.readJSON('library/bk_flow2.json', null);
  if (fl2) { fl2.updatedAt = at(2); store.writeJSON('library/bk_flow2.json', fl2); }
  // 再造：未读的 ready flow 书（无 cursor 不进足迹）、error 书、最新的 free 书
  store.writeJSON('library/bk_noread.json', { id: 'bk_noread', title: '没人读的书', meta: {}, status: 'ready', mode: 'flow', notes: null, outline: [], sections: [], frames: [{ id: 'f0', type: 'dialogue', sectionId: 's1', mood: 'normal', text: 'x', bb: '' }], qa: [], cursor: null, createdAt: '', updatedAt: at(3) });
  store.writeJSON('library/bk_err.json', { id: 'bk_err', title: '失败的书', meta: {}, status: 'error', mode: 'flow', qa: [], frames: [], createdAt: '', updatedAt: at(4) });
  store.writeJSON('library/bk_free3.json', { id: 'bk_free3', title: '最近的视频课', meta: { source: 'video', platform: 'youtube' }, status: 'ready', mode: 'free', notes: '有笔记', outline: null, sections: [], frames: [], qa: [], cursor: null, createdAt: '', updatedAt: at(5) });
  const digest = reading.listDigest();
  ok(digest.length === 3, `足迹收录 3 本（最近的视频课/小说一本/线代速览；got ${digest.length}）`);
  ok(digest[0].includes('最近的视频课') && digest[0].includes('🎬视频·YouTube') && digest[0].includes('已通读待提问'), '最新在前 + 视频平台标注 + free 进度文案');
  ok(digest.some(x => x.includes('小说一本') && /看到第1\/1帧/.test(x)), 'flow 书进度按帧计算');
  ok(!digest.some(x => x.includes('没人读的书')), '未开读的 ready 书不进足迹');
  ok(!digest.some(x => x.includes('失败的书')), 'error 书不进足迹');
  const block = prompts.readingDigestBlock();
  ok(block.includes('【陪读足迹') && block.includes('最近的视频课') && block.includes('不要假装记得陪读时的完整内容'), 'readingDigestBlock 注入块含足迹与使用守则');
  const sys = prompts.roleplaySystem();
  ok(sys.includes('【陪读足迹（应用层记录'), 'roleplaySystem 含陪读足迹段');
  // 空库 → 空块
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-video-empty-'));
  const storePath = require.resolve(SVC('store'));
  const storeMod = require(SVC('store'));
  void storePath; void storeMod;
  // （不换 dataDir——直接验证：把足迹全删后 block 为空）
  for (const id of ['bk_free2', 'bk_flow2', 'bk_free3', 'bk_noread', 'bk_err', 'bk_free1']) {
    try { fs.unlinkSync(path.join(TMP, 'library', id + '.json')); } catch (_) {}
  }
  ok(reading.listDigest().length === 0 && prompts.readingDigestBlock() === '', '清空 library 后足迹块为空（不注入）');
}

// ============ 总结 ============
console.log(`\n========== 视频解析/自由提问/陪读足迹 回归：${passed} 通过，${failed} 失败 ==========`);
if (failed) process.exit(1);
// TMP 不主动删：store 防抖落盘在进程退出后仍可能触发，删目录会打 ENOENT 噪音（与其他测试套一致，交给系统临时目录清理）
})().catch(e => { console.error('测试运行异常：', e); process.exit(1); });
