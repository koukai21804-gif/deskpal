// 视频解析（陪读视频源）：B站/YouTube 走 yt-dlp（字幕优先，无字幕下音频），MP4 直链走 fetch，
// 本地视频走文件；音频统一经 ffmpeg 转 16k 单声道 mp3 后送 OpenAI 兼容 /audio/transcriptions 转文字。
// 管线参照 Paper2Galgame 的 videoParsing（字幕语言优先级 / 音频码率 20kbps / 时长-体积上限 / VTT 解析）。
const i18n = require('./i18n');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { safeStorage } = require('electron');
const store = require('./store');
const guard = require('./fs-guard');
const logger = require('../logger');

const MAX_DURATION_SECONDS = 2 * 3600; // 2 小时：20kbps 音频 ≈ 18MB，仍在常见 ASR 接口 25MB 上限内
const MAX_DOWNLOAD_BYTES = 1500 * 1024 * 1024; // 音视频下载体积上限 1.5GB
const MAX_LOCAL_BYTES = 2 * 1024 * 1024 * 1024; // 本地文件 2GB
const MAX_TRANSCRIPT_CHARS = 300000;           // 与 documents.MAX_CHARS 对齐（超长截断）

const PLATFORM_DOMAINS = {
  bilibili: ['bilibili.com', 'b23.tv', 'bili2233.cn'],
  youtube: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
};
const PLATFORM_LABELS = { bilibili: 'Bilibili', youtube: 'YouTube', direct: 'MP4 直链', local: '本地视频' };

function friendlyError(msg) { const e = new Error(msg); e.userMsg = msg; return e; }

// ---------- 平台识别与 URL 校验 ----------
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}
function domainMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith('.' + domain);
}

// 校验并归一化输入：返回 { url, platform }。非法输入抛中文 userMsg。
function normalizeVideoSource(input) {
  const t = String(input || '').trim();
  if (!t || t.length > 2048) throw friendlyError('请输入有效的视频链接');
  let u;
  try { u = new URL(t); } catch (_) { throw friendlyError('视频链接格式无效'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
    throw friendlyError('仅支持公开的 HTTP/HTTPS 视频链接');
  }
  if (isPrivateHost(u.hostname)) throw friendlyError('视频链接指向内网或本机地址，不支持');
  const host = u.hostname.toLowerCase();
  let platform = 'direct';
  for (const [p, domains] of Object.entries(PLATFORM_DOMAINS)) {
    if (domains.some(d => domainMatches(host, d))) { platform = p; break; }
  }
  if (platform === 'direct' && !u.pathname.toLowerCase().endsWith('.mp4')) {
    throw friendlyError('仅支持 Bilibili、YouTube 链接或 .mp4 直链');
  }
  return { url: u.toString(), platform };
}

// ---------- 外部工具（yt-dlp / ffmpeg） ----------
// 二进制基础名：ytDlp → yt-dlp（发行名），ffmpeg → ffmpeg
const BIN_NAMES = { ytDlp: 'yt-dlp', ffmpeg: 'ffmpeg' };
function binBaseName(kind) { return BIN_NAMES[kind] || kind; }
// 查找顺序：settings.video 手动路径 → 数据目录/bin → 系统 PATH（裸命令名交给 spawn 解析）
function binDir() { return path.join(store.getDataDir() || os.homedir(), 'bin'); }
function binCandidates(kind) {
  const cfg = (store.get('settings').video) || {};
  const exe = process.platform === 'win32' ? binBaseName(kind) + '.exe' : binBaseName(kind);
  const manual = kind === 'ytDlp' ? cfg.ytDlpPath : cfg.ffmpegPath;
  const cands = [];
  if (manual && String(manual).trim()) cands.push(String(manual).trim());
  cands.push(path.join(binDir(), exe));
  cands.push(exe); // PATH 兜底
  return [...new Set(cands)];
}

// 通用的子进程执行：stdout/stderr 累计（截断）、超时、abort 击杀；allowNonZero 兼容 ffmpeg -i 探测
function runProcess(bin, args, { timeoutMs = 120000, allowNonZero = false, signal = null, onStderrLine = null, onStdoutLine = null } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', settled = false;
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const CAP = 512 * 1024;
    const acc = (s, chunk) => (s.length >= CAP ? s : (s + chunk.toString()).slice(0, CAP));
    const timer = setTimeout(() => finish(friendlyError('媒体处理命令超时')), timeoutMs);
    if (timer.unref) timer.unref();
    const onAbort = () => finish(friendlyError('视频解析已取消'));
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { child.kill(); } catch (_) {}
      if (err) { err.stderr = stderr; err.stdout = stdout; reject(err); }
      else resolve({ stdout, stderr, code: child.exitCode, signal: child.signalCode });
    }
    child.stdout.on('data', c => {
      stdout = acc(stdout, c);
      if (onStdoutLine) { for (const line of c.toString().split(/\r?\n/)) { try { onStdoutLine(line); } catch (_) {} } }
    });
    child.stderr.on('data', c => {
      stderr = acc(stderr, c);
      if (onStderrLine) { for (const line of c.toString().split(/\r?\n/)) { try { onStderrLine(line); } catch (_) {} } }
    });
    child.on('error', e => {
      if (e.code === 'ENOENT') finish(friendlyError('找不到 ' + path.basename(bin) + '——请在 设置→API→视频解析 导入或安装该工具'));
      else finish(friendlyError('无法启动 ' + path.basename(bin) + '：' + e.message));
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code === 0 || allowNonZero) finish(null);
      else finish(friendlyError((stderr || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 200) || ('命令执行失败 (' + code + ')')));
    });
  });
}

// 逐个候选跑 --version，返回 { found, path, version }；都不在返回 found:false（不抛）
async function probeBinary(kind) {
  const cands = binCandidates(kind);
  for (const c of cands) {
    try {
      const r = await runProcess(c, ['--version'], { timeoutMs: 8000, allowNonZero: true });
      const out = String(r.stdout || r.stderr || '');
      if (/^\s*$/.test(out) && !r.stderr) continue;
      return { found: true, path: c, version: out.split(/\r?\n/).find(Boolean)?.slice(0, 80) || '' };
    } catch (_) { /* 该候选不可用，试下一个 */ }
  }
  return { found: false, path: '', version: '' };
}
async function probeRuntime() {
  const [ytDlp, ffmpeg] = await Promise.all([probeBinary('ytDlp'), probeBinary('ffmpeg')]);
  return { ytDlp, ffmpeg, ready: ytDlp.found && ffmpeg.found };
}

// 设置页「导入」：把用户选中的 exe 复制进 数据目录/bin（复制而非引用——Steam 目录卸载游戏后会消失）
function importBinary(kind, src) {
  if (!['ytDlp', 'ffmpeg'].includes(kind)) throw friendlyError('未知的工具类型');
  if (!fs.existsSync(src)) throw friendlyError('文件不存在：' + src);
  const ext = path.extname(src).toLowerCase();
  if (ext !== '.exe' && process.platform === 'win32') throw friendlyError('请选择 .exe 可执行文件');
  const exe = process.platform === 'win32' ? binBaseName(kind) + '.exe' : binBaseName(kind);
  const dest = path.join(binDir(), exe);
  fs.mkdirSync(binDir(), { recursive: true });
  fs.copyFileSync(src, dest);
  logger.info('[video] 已导入 ' + kind + ' → ' + dest);
  return { ok: true, path: dest };
}

async function requireBinary(kind) {
  const r = await probeBinary(kind);
  if (!r.found) {
    throw friendlyError('视频解析缺少工具 ' + binBaseName(kind) +
      '。到 设置→API→视频解析 导入（可从本机已有的 Paper2Galgame 安装目录复制），或安装到系统 PATH');
  }
  return r.path;
}

// ---------- 字幕解析（VTT/SRT 通用 cue 化） ----------
function tsToSeconds(ts) {
  // 兼容 VTT 点毫秒（00:00:10.500）与 SRT 逗号毫秒（00:00:10,500）
  const m = String(ts || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)/);
  if (!m) return null;
  return (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3].replace(',', '.');
}

// VTT/SRT → [{startSeconds, endSeconds, text}]；连续去重（自动字幕常逐行重复滚动词）
function parseSubtitles(content) {
  const blocks = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/);
  const cues = [];
  let prev = '';
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const idx = lines.findIndex(l => l.includes('-->'));
    if (idx < 0) continue;
    const [rawStart, rawEnd = ''] = lines[idx].split('-->');
    const start = tsToSeconds(rawStart);
    const end = tsToSeconds(String(rawEnd).trim().split(/\s+/)[0]);
    // 字幕文本：去掉 VTT 行内定位标签与尖括号标记；拼接多行
    let text = lines.slice(idx + 1).join(' ')
      .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (start == null || end == null || !text || text === prev) continue;
    cues.push({ startSeconds: start, endSeconds: end, text });
    prev = text;
  }
  return cues;
}

// cue → 5 分钟桶（与 Paper2Galgame k5t 同款粒度），markdown 分节展示
function bucketCues(cues, bucketSeconds = 300, totalSeconds = 0) {
  const map = new Map();
  for (const c of cues) {
    const key = Math.max(0, Math.floor(c.startSeconds / bucketSeconds)) * bucketSeconds;
    const arr = map.get(key) || [];
    if (arr[arr.length - 1] !== c.text) arr.push(c.text);
    map.set(key, arr);
  }
  return [...map.entries()].map(([start, texts]) => ({
    startSeconds: start,
    endSeconds: totalSeconds > 0 ? Math.min(totalSeconds, start + bucketSeconds) : start + bucketSeconds,
    text: texts.join(' '),
  }));
}

function fmtTs(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const two = n => String(n).padStart(2, '0');
  return h > 0 ? `${two(h)}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}
function cleanLine(s, fallback = '', max = 300) {
  return String(s || fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// 转写结果 → 带时间戳的 markdown 文稿（陪读生成与自由提问都吃这个文本）
function buildTranscriptMarkdown({ title, url, platform, uploader, durationSeconds, sections }) {
  const head = [
    `# ${cleanLine(title, '视频内容')}`,
    url ? `来源：${url}` : '',
    platform ? `平台：${PLATFORM_LABELS[platform] || platform}` : '',
    cleanLine(uploader) ? `作者：${cleanLine(uploader)}` : '',
    durationSeconds > 0 ? `时长：${fmtTs(durationSeconds)}` : '',
  ].filter(Boolean);
  const body = (Array.isArray(sections) ? sections : [])
    .filter(s => String(s && s.text || '').trim())
    .map(s => `## ${fmtTs(s.startSeconds)}-${fmtTs(s.endSeconds)}\n\n${String(s.text).trim()}`);
  return [...head, '', ...body].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- ffmpeg：时长探测与音频抽取 ----------
function parseDurationFromFfmpeg(stderr) {
  const m = String(stderr || '').match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}
async function probeDuration(mediaPath, ffmpegPath, signal) {
  const r = await runProcess(ffmpegPath, ['-hide_banner', '-i', mediaPath], { timeoutMs: 30000, allowNonZero: true, signal });
  return parseDurationFromFfmpeg(r.stderr);
}

// 抽音频：16k 单声道 mp3 20kbps（2 小时 ≈ 18MB，兼容 ASR 接口体积上限）；mp3 编码器缺失时回退 wav
async function extractAudio({ mediaPath, tempDir, ffmpegPath, maxDurationSeconds, signal }) {
  const tryOnce = async (out, args) => {
    await runProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mediaPath,
      '-t', String(maxDurationSeconds), '-vn', '-ac', '1', '-ar', '16000', ...args, out],
      { timeoutMs: 10 * 60000, signal });
    const st = await fs.promises.stat(out).catch(() => null);
    return st && st.size > 0 ? out : null;
  };
  const mp3 = await tryOnce(path.join(tempDir, 'audio.mp3'), ['-codec:a', 'libmp3lame', '-b:a', '20k']).catch(() => null);
  if (mp3) return mp3;
  const wav = await tryOnce(path.join(tempDir, 'audio.wav'), ['-codec:a', 'pcm_s16le']).catch(() => null);
  if (wav) return wav;
  throw friendlyError('视频中没有可识别的音轨');
}

// ---------- ASR（OpenAI 兼容 /audio/transcriptions） ----------
// baseUrl 归一化：已指向具体 audio 接口的地址原样使用；base 地址补 /audio/transcriptions
function asrEndpointOf(baseUrl) {
  let s = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (/\/audio\/(transcriptions|asr)$/i.test(s)) return s;
  return s + '/audio/transcriptions';
}

function asrConfig() {
  const api = store.get('api');
  const main = llmConfigFallback();
  const asr = api.asr || {};
  let key = '';
  if (asr.keyEnc) { try { key = safeStorage.decryptString(Buffer.from(asr.keyEnc, 'base64')); } catch (_) {} }
  const baseUrl = String(asr.baseUrl || '').trim() || main.baseUrl;
  const model = String(asr.model || '').trim() || 'whisper-1';
  return { baseUrl, endpoint: asrEndpointOf(baseUrl), model, apiKey: key || main.apiKey };
}
function llmConfigFallback() {
  const api = store.get('api');
  let apiKey = '';
  if (api.apiKeyEnc) { try { apiKey = safeStorage.decryptString(Buffer.from(api.apiKeyEnc, 'base64')); } catch (_) {} }
  const base = String(api.endpoint || '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  return { baseUrl: base, apiKey };
}
function saveAsrKey(key) {
  let enc = '';
  try { if (key) enc = safeStorage.encryptString(String(key)).toString('base64'); } catch (e) { logger.warn('safeStorage 加密失败: ' + e.message); }
  store.set('api', { asr: { keyEnc: enc } });
}

async function transcribeFile(audioPath, { signal } = {}) {
  const cfg = asrConfig();
  if (!cfg.baseUrl) throw friendlyError('还没有配置 ASR 接口地址，请到 设置→API→视频解析 填写（或先配置主 LLM 接口）');
  const buf = await fs.promises.readFile(audioPath);
  if (buf.length > 24 * 1024 * 1024) throw friendlyError('音频文件过大（' + Math.round(buf.length / 1024 / 1024) + 'MB），超出语音识别接口常见 25MB 上限，请解析短一些的视频');
  const fd = new FormData();
  const mime = audioPath.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
  fd.append('file', new Blob([buf], { type: mime }), path.basename(audioPath));
  fd.append('model', cfg.model);
  let res;
  try {
    res = await fetch(cfg.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${cfg.apiKey}` }, body: fd, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw friendlyError('视频解析已取消');
    throw friendlyError('语音识别服务请求失败：' + e.message);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    let detail = '';
    try { const j = JSON.parse(t); detail = (j.error && (j.error.message || j.error.code)) || j.message || ''; } catch (_) { detail = t.slice(0, 120); }
    if (res.status === 404) throw friendlyError('ASR 接口地址不存在（404）——检查 设置→API→视频解析 的接口地址与模型名是否匹配');
    throw friendlyError(`语音识别失败 (${res.status})${detail ? '：' + detail : ''}`);
  }
  const j = await res.json().catch(() => null);
  const text = j && (j.text || j.transcription || (j.output && j.output.text) || (j.result && j.result.text)) || '';
  if (!String(text).trim()) throw friendlyError('语音识别没有返回文字（该视频可能无语音内容）');
  return String(text).trim();
}

// ---------- 下载（MP4 直链） ----------
async function downloadDirect(url, dest, { signal, onProgress } = {}) {
  let res;
  try {
    res = await fetch(url, { signal, headers: { 'User-Agent': 'deskpal video-parser' } });
  } catch (e) {
    if (e.name === 'AbortError') throw friendlyError('视频解析已取消');
    throw friendlyError('无法下载视频：' + e.message);
  }
  if (!res.ok) throw friendlyError(`无法下载视频 (${res.status})`);
  const ctype = String(res.headers.get('content-type') || '').toLowerCase();
  const pathname = new URL(url).pathname.toLowerCase();
  if (!ctype.includes('video/') && !ctype.includes('application/octet-stream') && !ctype.includes('audio/') && !pathname.endsWith('.mp4')) {
    throw friendlyError('该链接不是可直接下载的视频文件');
  }
  const declared = Number.parseInt(res.headers.get('content-length') || '0', 10);
  if (declared > MAX_DOWNLOAD_BYTES) throw friendlyError('视频文件超过大小限制（1.5GB）');
  const out = fs.createWriteStream(dest);
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) { try { await reader.cancel(); } catch (_) {} throw friendlyError('视频文件超过大小限制（1.5GB）'); }
      if (onProgress && declared > 0) onProgress(total / declared);
      out.write(Buffer.from(value));
    }
  } finally { await new Promise(r => out.end(r)); }
  if (!total) throw friendlyError('下载到的视频为空');
  return dest;
}

// ---------- yt-dlp：元数据 / 字幕 / 音频 ----------
async function ytdlpMetadata(url, ytDlpPath, signal) {
  const r = await runProcess(ytDlpPath, ['-J', '--no-playlist', '--no-warnings', url], { timeoutMs: 60000, signal });
  let j = null;
  try { j = JSON.parse(String(r.stdout || '').trim()); } catch (_) {}
  if (!j || typeof j !== 'object') throw friendlyError('无法读取视频信息（yt-dlp 返回异常）——链接可能不是有效视频页');
  const dur = Number(j.duration);
  return {
    title: cleanLine(j.title, '', 200) || '视频内容',
    uploader: cleanLine(j.uploader || j.channel || '', '', 80),
    durationSeconds: Number.isFinite(dur) && dur > 0 ? Math.floor(dur) : 0,
  };
}

async function ytdlpSubtitles({ url, tempDir, ytDlpPath, signal }) {
  const subOut = path.join(tempDir, 'subtitle.%(ext)s');
  await runProcess(ytDlpPath, [
    '--skip-download', '--no-playlist', '--no-warnings',
    '--write-subs', '--write-auto-subs',
    '--sub-langs', 'ai-zh,ai-en,zh-Hans,zh-Hant,zh-CN,zh-TW,zh,en,ja',
    '--sub-format', 'vtt/srt/best',
    '--output', subOut, url,
  ], { timeoutMs: 90000, signal });
  let files = [];
  try { files = (await fs.promises.readdir(tempDir)).filter(f => /^subtitle\./i.test(f) && /\.(vtt|srt)$/i.test(f)); } catch (_) {}
  // 语言优先顺序即文件名后缀优先顺序（ai-zh > zh-Hans > ... > en > ja）
  const order = ['ai-zh', 'zh-hans', 'zh-cn', 'zh-hant', 'zh-tw', 'zh.', 'ai-en', 'en.', 'ja.'];
  files.sort((a, b) => rankOf(a) - rankOf(b));
  function rankOf(f) { const i = order.findIndex(o => f.toLowerCase().includes(o)); return i < 0 ? 99 : i; }
  for (const f of files) {
    const content = await fs.promises.readFile(path.join(tempDir, f), 'utf8').catch(() => '');
    const cues = parseSubtitles(content);
    if (cues.length) return cues;
  }
  return [];
}

async function ytdlpAudio({ url, tempDir, ytDlpPath, signal, onProgress }) {
  const out = path.join(tempDir, 'media.%(ext)s');
  await runProcess(ytDlpPath, [
    '--no-playlist', '--no-warnings', '--newline',
    '--format', 'bestaudio/best',
    '--max-filesize', String(MAX_DOWNLOAD_BYTES),
    '--match-filter', `duration <= ${MAX_DURATION_SECONDS}`,
    '--output', out, url,
  ], { timeoutMs: 15 * 60000, signal, onStdoutLine: line => {
    // yt-dlp --newline：进度行走 stdout（[download]  42.3% of ...）
    if (!onProgress) return;
    const m = line.match(/\[download\]\s+(\d{1,3}(?:\.\d)?)%/);
    if (m) onProgress(+m[1] / 100);
  } });
  let files = [];
  try { files = (await fs.promises.readdir(tempDir)).filter(f => f.startsWith('media.') && !f.endsWith('.part')); } catch (_) {}
  if (!files.length) throw friendlyError('无法提取该视频的音轨（可能时长超过 2 小时限制或需要登录）');
  return path.join(tempDir, files.sort((a, b) => b.length - a.length)[0]);
}

// ---------- 入口 ----------
// 解析视频 → { markdown, meta }。onProgress({stage, pct, message}) 供 UI 进度；signal 供取消。
// 入参：{ url } 或 { filePath }（本地视频）。
const jobs = new Map(); // jobId -> AbortController
let jobSeq = 0;

async function parseVideo({ url, filePath }, { onProgress = null, signal = null } = {}) {
  const local = !!filePath;
  if (!local) normalizeVideoSource(url); // 提前校验（抛友好错误）
  const controller = new AbortController();
  const jobId = 'vid_' + Date.now().toString(36) + '_' + (++jobSeq);
  jobs.set(jobId, controller);
  const mergedSignal = signal || controller.signal;
  if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', () => controller.abort(), { once: true }); }
  const prog = (stage, pct, message) => { if (onProgress) { try { onProgress({ stage, pct, message }); } catch (_) {} } };
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deskpal-video-'));
  try {
    let mediaPath = null, meta = { title: '', uploader: '', durationSeconds: 0, platform: '', url: '' };
    // 工具按需探测：本地/直链只要 ffmpeg；B站/YouTube 要 yt-dlp（抓到字幕则全程用不到 ffmpeg）
    let ffmpegPath = null, ytDlpPath = null;
    const getFfmpeg = async () => { if (!ffmpegPath) { prog('probe', 5, i18n.t('正在检查 ffmpeg…')); ffmpegPath = await requireBinary('ffmpeg'); } return ffmpegPath; };
    const getYtDlp = async () => { if (!ytDlpPath) { prog('probe', 5, i18n.t('正在检查 yt-dlp…')); ytDlpPath = await requireBinary('ytDlp'); } return ytDlpPath; };

    if (local) {
      const st = await fs.promises.stat(filePath).catch(() => null);
      if (!st || !st.size) throw friendlyError('文件不存在或为空：' + filePath);
      if (st.size > MAX_LOCAL_BYTES) throw friendlyError('视频文件超过大小限制（2GB）');
      if (!guard.canRead(filePath)) throw friendlyError('没有权限读取该文件（敏感路径）');
      mediaPath = filePath;
      meta.platform = 'local';
      meta.title = path.basename(filePath, path.extname(filePath)) || '本地视频';
      prog('probe', 10, i18n.t('正在读取视频时长…'));
      meta.durationSeconds = await probeDuration(filePath, await getFfmpeg(), mergedSignal);
    } else if (normalizeVideoSource(url).platform === 'direct') {
      meta = { ...meta, ...normalizeVideoSource(url) };
      prog('download', 10, i18n.t('正在下载 MP4…'));
      mediaPath = path.join(tempDir, 'direct.mp4');
      await downloadDirect(meta.url, mediaPath, { signal: mergedSignal, onProgress: p => prog('download', 10 + Math.round(p * 30), i18n.tf('正在下载 MP4… {0}%', Math.round(p * 100))) });
      prog('probe', 42, i18n.t('正在读取视频时长…'));
      meta.durationSeconds = await probeDuration(mediaPath, await getFfmpeg(), mergedSignal);
      meta.title = meta.title || decodeURIComponent(path.basename(new URL(meta.url).pathname)) || 'MP4 视频';
    } else {
      meta = { ...meta, ...normalizeVideoSource(url) };
      prog('metadata', 8, i18n.t('正在读取视频信息…'));
      const md = await ytdlpMetadata(meta.url, await getYtDlp(), mergedSignal);
      meta.title = md.title; meta.uploader = md.uploader; meta.durationSeconds = md.durationSeconds;
      if (meta.durationSeconds > MAX_DURATION_SECONDS) {
        throw friendlyError(`视频时长 ${fmtTs(meta.durationSeconds)} 超过 2 小时限制`);
      }
      prog('subtitles', 18, i18n.t('正在尝试抓取字幕（优先，免转写）…'));
      let cues = [];
      try { cues = await ytdlpSubtitles({ url: meta.url, tempDir, ytDlpPath: await getYtDlp(), signal: mergedSignal }); }
      catch (e) { if (mergedSignal.aborted) throw friendlyError('视频解析已取消'); logger.warn('[video] 字幕抓取失败: ' + (e.message || e)); }
      if (cues.length) {
        const totalChars = cues.reduce((n, c) => n + c.text.length, 0);
        if (totalChars >= 200) {
          prog('done', 95, i18n.t('字幕抓取成功，正在整理文稿…'));
          const markdown = buildTranscriptMarkdown({ ...meta, sections: bucketCues(cues, 300, meta.durationSeconds) });
          return finish({ markdown, meta, transcriptSource: 'subtitles' });
        }
      }
      prog('download', 35, i18n.t('没有可用字幕，正在下载音频（将语音转写）…'));
      mediaPath = await ytdlpAudio({ url: meta.url, tempDir, ytDlpPath: await getYtDlp(), signal: mergedSignal, onProgress: p => prog('download', 35 + Math.round(p * 20), i18n.tf('正在下载音频… {0}%', Math.round(p * 100))) });
    }

    // 音频 → ASR（本地/直链/无字幕的在线视频共用）
    if (meta.durationSeconds > MAX_DURATION_SECONDS) {
      throw friendlyError(`视频时长 ${fmtTs(meta.durationSeconds)} 超过 2 小时限制`);
    }
    prog('extract', 60, i18n.t('正在提取音轨（16k 单声道）…'));
    const audio = await extractAudio({ mediaPath, tempDir, ffmpegPath: await getFfmpeg(), maxDurationSeconds: MAX_DURATION_SECONDS, signal: mergedSignal });
    prog('transcribe', 72, i18n.t('正在语音转写（可能需要几分钟）…'));
    const text = await transcribeFile(audio, { signal: mergedSignal });
    const sections = [{ startSeconds: 0, endSeconds: meta.durationSeconds || 0, text }];
    prog('done', 95, i18n.t('转写完成，正在整理文稿…'));
    return finish({ markdown: buildTranscriptMarkdown({ ...meta, sections }), meta, transcriptSource: 'asr' });
  } catch (e) {
    if (mergedSignal.aborted && (!e.userMsg || e.userMsg === '视频解析已取消')) throw friendlyError('视频解析已取消');
    throw e;
  } finally {
    jobs.delete(jobId);
    if (!local) fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
  function finish(r) {
    const truncated = r.markdown.length > MAX_TRANSCRIPT_CHARS;
    return {
      markdown: truncated ? r.markdown.slice(0, MAX_TRANSCRIPT_CHARS) : r.markdown,
      meta: { ...r.meta, transcriptSource: r.transcriptSource, truncated, chars: Math.min(r.markdown.length, MAX_TRANSCRIPT_CHARS) },
    };
  }
}

function cancelJob(jobController) { try { jobController.abort(); } catch (_) {} }
void cancelJob;

module.exports = {
  parseVideo, normalizeVideoSource, parseSubtitles, bucketCues, buildTranscriptMarkdown,
  parseDurationFromFfmpeg, asrEndpointOf, asrConfig, saveAsrKey, probeRuntime, probeBinary,
  importBinary, tsToSeconds, PLATFORM_LABELS,
  MAX_DURATION_SECONDS,
};
