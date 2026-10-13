// 陪读管线：上传→两阶段生成（大纲→逐节 flow）→帧编译→举手提问侧信道→存档
// v0.6：①自由提问模式（mode='free'：通读全文滚动笔记→静候提问）；②视频源
// （uploadVideo：B站/YouTube/MP4直链/本地视频 → 字幕或语音转写 → markdown 文稿入库）
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const store = require('./store');
const canon = require('./canon');
const documents = require('./documents');
const llm = require('./llm');
const prompts = require('./prompts');
const emotion = require('./emotion');
const video = require('./video');
const { rescueJSON } = require('./json-utils');
const logger = require('../logger');

const EMOTIONS = ['normal', 'happy', 'surprised', 'angry', 'thinking', 'sad'];
const generating = new Map(); // bookId -> { canceled: bool }

// 自由提问模式的通读窗口：最多 12 窗 × 10000 字符（超长资料均匀采样，覆盖头中尾）
const DIGEST_MAX_WINDOWS = 12;
const DIGEST_WINDOW_CHARS = 10000;
const DIGEST_NOTES_CAP = 3000; // 落库笔记上限（字符）

function bookPath(id) { return `books/${id}.json`; }
function libPath(id) { return `library/${id}.json`; }

function friendlyError(msg) { const e = new Error(msg); e.userMsg = msg; return e; }

// ---------- 上传 ----------
async function upload(filePath) {
  const { text, meta } = await documents.parse(filePath);
  const id = 'bk_' + Date.now().toString(36);
  store.writeJSON(bookPath(id), { id, meta, text, createdAt: dayjs().format() });
  store.writeJSON(libPath(id), {
    id, title: meta.title, meta, status: 'parsed', error: null,
    mode: 'flow', notes: null, outline: null, sections: [], frames: [], qa: [], cursor: null,
    createdAt: dayjs().format(), updatedAt: dayjs().format(),
  });
  return { bookId: id, meta };
}

// ---------- 视频源：解析（字幕优先/语音转写兜底）→ 文稿入库 ----------
// 进度经 reader:video-progress 推送到陪读窗；解析中可被 cancelVideoUpload 取消
const videoJobs = new Map(); // token -> AbortController
async function uploadVideo({ url, filePath }) {
  if (videoJobs.size) throw friendlyError('已有视频在解析中，请等它完成或先取消');
  if (!filePath && url) video.normalizeVideoSource(url); // 校验前置：非法链接不进管线
  const token = 'vidtok_' + Date.now().toString(36);
  const controller = new AbortController();
  videoJobs.set(token, controller);
  const win = require('../windows').getWindow('reader');
  try {
    const { markdown, meta } = await video.parseVideo({ url, filePath }, {
      signal: controller.signal,
      onProgress: (p) => { if (win && !win.isDestroyed()) win.webContents.send('reader:video-progress', { ...p, token, done: false }); },
    });
    if (!markdown || markdown.replace(/[#\s\d:-]/g, '').length < 200) {
      throw friendlyError('视频内容提取到的文字太少（' + (meta.chars || 0) + ' 字符），无法陪读。可换一个有字幕/语音更清晰的视频');
    }
    const id = 'bk_' + Date.now().toString(36);
    const title = meta.title || (filePath ? path.basename(filePath) : '视频内容');
    const bookMeta = {
      ...meta, title,
      fileName: title, format: 'video', pages: null, chars: markdown.length,
      truncated: !!meta.truncated, source: 'video',
    };
    store.writeJSON(bookPath(id), { id, meta: bookMeta, text: markdown, createdAt: dayjs().format() });
    store.writeJSON(libPath(id), {
      id, title, meta: bookMeta, status: 'parsed', error: null,
      mode: 'flow', notes: null, outline: null, sections: [], frames: [], qa: [], cursor: null,
      createdAt: dayjs().format(), updatedAt: dayjs().format(),
    });
    if (win && !win.isDestroyed()) win.webContents.send('reader:video-progress', { token, done: true, stage: 'done', pct: 100, bookId: id, meta: bookMeta });
    return { bookId: id, meta: bookMeta };
  } catch (e) {
    const msg = e.userMsg || e.message;
    if (win && !win.isDestroyed()) win.webContents.send('reader:video-progress', { token, done: true, stage: 'error', pct: 0, error: msg });
    throw friendlyError(msg);
  } finally {
    videoJobs.delete(token);
  }
}
function cancelVideoUpload() {
  for (const c of videoJobs.values()) { try { c.abort(); } catch (_) {} }
  return { ok: true };
}

function list() {
  const libDir = path.join(store.getDataDir(), 'library');
  let files = [];
  try { files = fs.readdirSync(libDir).filter(f => f.endsWith('.json')); } catch (_) {}
  return files.map(f => {
    const lib = store.readJSON('library/' + f, null);
    if (!lib) return null;
    return {
      id: lib.id, title: lib.title, status: lib.status, meta: lib.meta,
      mode: lib.mode || 'flow', isVideo: !!(lib.meta && lib.meta.source === 'video'),
      createdAt: lib.createdAt, updatedAt: lib.updatedAt,
      frames: (lib.frames || []).length, qa: (lib.qa || []).length,
      hasCursor: !!lib.cursor,
    };
  }).filter(Boolean).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// 陪读足迹摘要（角色扮演 system prompt 注入用）：只含概要，不含正文/问答，控制上下文占用
function listDigest(limit = 5) {
  const libDir = path.join(store.getDataDir(), 'library');
  let files = [];
  try { files = fs.readdirSync(libDir).filter(f => f.endsWith('.json')); } catch (_) { return []; }
  const items = [];
  for (const f of files) {
    const lib = store.readJSON('library/' + f, null);
    if (!lib || lib.status !== 'ready') continue; // 只统计真正读过的（已生成/已通读）
    const touched = lib.updatedAt || lib.createdAt || '';
    if (!touched) continue;
    // 有实际阅读痕迹才进足迹：剧情模式看过至少 1 帧、自由模式生成过笔记
    const frames = lib.frames || [];
    const readSome = (lib.mode === 'free') ? !!lib.notes : (frames.length > 0 && !!lib.cursor);
    if (!readSome) continue;
    const src = (lib.meta && lib.meta.source === 'video')
      ? `🎬视频·${video.PLATFORM_LABELS[lib.meta.platform] || '视频'}`
      : '📖资料';
    let progress;
    if (lib.mode === 'free') {
      progress = (lib.qa || []).length ? `已通读，答过${(lib.qa || []).length}问` : '已通读待提问';
    } else {
      const idx = frames.findIndex(fr => fr.id === lib.cursor);
      progress = idx >= 0 ? `看到第${idx + 1}/${frames.length}帧` : '未开读';
    }
    items.push({ touched, line: `《${String(lib.title || '未命名').slice(0, 30)}》｜${src}｜${progress}｜${dayjs(touched).format('MM-DD')}` });
  }
  return items.sort((a, b) => (a.touched < b.touched ? 1 : -1)).slice(0, limit).map(x => x.line);
}

function load(bookId) {
  const lib = store.readJSON(libPath(bookId), null);
  if (!lib) throw friendlyError('书籍不存在或已删除');
  const book = store.readJSON(bookPath(bookId), null);
  return { ...lib, hasText: !!book };
}

function del(bookId) {
  for (const p of [path.join(store.getDataDir(), 'library', bookId + '.json'), path.join(store.getDataDir(), 'books', bookId + '.json')]) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
}

function progress(bookId, stage, pct, message) {
  const win = require('../windows').getWindow('reader');
  if (win) win.webContents.send('reader:progress', { bookId, stage, pct, message });
}

// ---------- 阶段一：大纲 ----------
async function genOutline(book) {
  const sample = book.text.slice(0, 6000);
  const mkMsgs = (retry) => [{
    role: 'system',
    content: prompts.readingOutlinePrompt(book.meta.title, sample) +
      (retry ? '\n\n【注意】上一次输出无法解析为 JSON。请严格只输出一个 JSON 对象，以 { 开头、以 } 结尾，不要有任何解释文字或代码围栏。' : ''),
  }];
  let j = null;
  for (let attempt = 0; attempt < 2 && !j; attempt++) {
    // 预算放大：思考型模型或长大纲可能超 2500 tokens，截断的 JSON 无法解析
    const out = await llm.genericCompletion(mkMsgs(attempt > 0), { temperature: 0.3, maxTokens: 6000 });
    j = rescueJSON(out);
    if (!j) logger.warn(`大纲 JSON 解析失败(第${attempt + 1}次)，模型输出开头: ` + String(out).slice(0, 300).replace(/\n/g, ' '));
  }
  if (!j || !Array.isArray(j.sections) || !j.sections.length) {
    throw friendlyError('大纲生成失败：模型返回格式异常（可点「重试生成」再试一次，或在 设置→API 换一个模型）');
  }
  const sections = j.sections.slice(0, 6).map((s, i) => ({
    id: 's' + (i + 1), title: String(s.title || `第${i + 1}节`).slice(0, 30),
    summary: String(s.summary || ''), keyPoints: (s.keyPoints || []).slice(0, 5).map(String),
    mood: EMOTIONS.includes(s.mood) ? s.mood : 'normal', quizIntent: String(s.quizIntent || ''),
  }));
  if (sections.length < 2) throw friendlyError('大纲生成失败：节数不足');
  return sections;
}

// 按节切分原文：节 i 覆盖 [i/n, (i+1)/n)，取每节中心窗口
function sectionSlice(text, index, total, size = 4500) {
  const per = Math.floor(text.length / total);
  const start = Math.max(0, per * index - 300);
  return text.slice(start, start + size);
}

// ---------- 阶段二：逐节 flow ----------
function validateFlow(items) {
  const errs = [];
  if (!Array.isArray(items) || items.length < 5) return ['帧数不足（至少 5 帧）'];
  let quizCount = 0;
  items.forEach((it, i) => {
    const p = `第${i + 1}帧`;
    if (!it || typeof it !== 'object') { errs.push(p + ' 不是对象'); return; }
    if (it.t === 'd' || it.t === 'n') {
      if (!String(it.x || '').trim()) errs.push(p + ' 缺少台词 x');
      if (it.e && !EMOTIONS.includes(it.e)) errs.push(p + ' 情绪非法 ' + it.e);
      if (it.bb !== undefined && typeof it.bb !== 'string') errs.push(p + ' bb 必须是字符串');
    } else if (it.t === 'q') {
      quizCount++;
      if (!String(it.q || '').trim()) errs.push(p + ' 缺少题目 q');
      if (!Array.isArray(it.o) || it.o.length !== 3) errs.push(p + ' 选项必须 3 个');
      if (!Number.isInteger(it.c) || it.c < 0 || it.c > 2) errs.push(p + ' 正确下标 c 非法');
      if (!Array.isArray(it.f) || it.f.length !== 3) errs.push(p + ' 反馈必须 3 条');
    } else {
      errs.push(p + ' 类型 t 非法: ' + it.t);
    }
  });
  if (quizCount === 0) errs.push('缺少测验帧');
  return errs;
}

async function genFlow(pet, master, section, sectionText, index, total, bookTitle) {
  const mkMessages = (errMsg) => [{
    role: 'system',
    content: prompts.readingFlowPrompt(pet, master, section, sectionText, index + 1, total, bookTitle) +
      (errMsg ? `\n\n【上一次输出校验失败，请修正】\n${errMsg}\n请重新输出完整 JSON 数组。` : ''),
  }];
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    // 预算放大：10-16 帧中文剧本 + 测验，思考型模型下 4000 tokens 可能截断
    const out = await llm.genericCompletion(mkMessages(lastErr), { temperature: 0.6, maxTokens: 8000 });
    const items = rescueJSON(out);
    if (items && !Array.isArray(items)) {
      // 模型把数组包进了对象（如 {"frames":[...]}），尝试拆出数组
      const inner = Object.values(items).find(Array.isArray);
      items = inner || items;
    }
    const errs = validateFlow(items);
    if (!errs.length) return items;
    lastErr = errs.join('；');
    logger.warn(`陪读 flow 校验失败(${bookTitle} 第${index + 1}节, 第${attempt + 1}次): ` + lastErr);
  }
  // 两次都失败：给出最小可播兜底（台词帧 + 无测验）保证流程可走
  return [
    { t: 'd', e: section.mood || 'normal', x: `这一节「${section.title}」的剧本我演砸了…不过要点是：${(section.keyPoints || [section.summary]).join('；')}`, bb: `## ${section.title}\n${section.summary}` },
    { t: 'd', e: 'sad', x: '刚才生成剧本时出了点小差错，我们继续下一节吧！', bb: '' },
  ];
}

// ---------- 自由提问模式：通读 → 滚动笔记 ----------
// 全覆盖采样：短文一段读完；长文按 10000 字窗衔接（相邻窗小重叠保证边界不断档）；
// 超长文本（>12 窗）放大窗宽保证 12 次调用内读完全文，不跳读
function digestWindows(text) {
  const t = String(text || '');
  if (!t) return [];
  if (t.length <= DIGEST_WINDOW_CHARS) return [t];
  const n = Math.min(DIGEST_MAX_WINDOWS, Math.ceil(t.length / DIGEST_WINDOW_CHARS));
  const size = Math.max(DIGEST_WINDOW_CHARS, Math.ceil(t.length / n));
  const step = (t.length - size) / Math.max(1, n - 1);
  const wins = [];
  for (let i = 0; i < n; i++) {
    const start = Math.round(step * i);
    wins.push(t.slice(start, i === n - 1 ? t.length : start + size));
  }
  return wins;
}

function stripFences(s) {
  return String(s || '').replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

// 单窗通读：失败重试一次；仍失败则保留旧笔记继续（个别窗口垮掉不至于全盘失败）
async function genDigestStep(pet, bookTitle, notes, chunk, index, total) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await llm.genericCompletion([{
      role: 'system',
      content: prompts.readingDigestStepPrompt(pet, bookTitle, notes, chunk, index, total) +
        (attempt > 0 ? '\n\n【注意】上一次输出异常。只输出笔记正文纯文本，不要任何标题、代码围栏或解释。' : ''),
    }], { temperature: 0.3, maxTokens: 4200 });
    const clean = stripFences(out);
    if (clean && clean.length >= 50) return clean.slice(0, DIGEST_NOTES_CAP);
    logger.warn(`自由通读第 ${index} 段输出异常(第 ${attempt + 1} 次)，长度 ${clean.length}`);
  }
  return null;
}

async function generateFree(bookId, lib, book, state) {
  const personaData = canon.view();
  const pet = personaData.pet;
  const windows = digestWindows(book.text);
  progress(bookId, 'digest', 8, `开始通读《${lib.title}》全文（共 ${windows.length} 段）…`);
  let notes = '';
  for (let i = 0; i < windows.length; i++) {
    if (state.canceled) throw friendlyError('已取消');
    progress(bookId, 'digest', 8 + Math.round(((i + 1) / windows.length) * 82), `正在通读第 ${i + 1}/${windows.length} 段并整理笔记…`);
    const next = await genDigestStep(pet, lib.title, notes, windows[i], i + 1, windows.length);
    if (next) notes = next;
    else if (i === 0 && !notes) notes = windows[i].slice(0, DIGEST_NOTES_CAP); // 首段彻底失败：原文摘录兜底
    lib.notes = notes;
    lib.updatedAt = dayjs().format();
    store.writeJSON(libPath(bookId), lib);
  }
  if (!notes || notes.replace(/\s/g, '').length < 50) throw friendlyError('通读笔记生成失败：模型输出异常（可重试，或在 设置→API 换一个模型）');
  lib.notes = notes.slice(0, DIGEST_NOTES_CAP);
  lib.status = 'ready';
  lib.updatedAt = dayjs().format();
  store.writeJSON(libPath(bookId), lib);
  progress(bookId, 'done', 100, '通读完成，我随时可以回答关于这份资料的问题');
}

// ---------- 生成主流程 ----------
// mode='flow'（默认）：大纲→逐节剧本；mode='free'：通读全文→滚动笔记→静候提问
async function generate(bookId, { mode = 'flow' } = {}) {
  if (generating.has(bookId)) throw friendlyError('这本书正在生成中');
  const lib = load(bookId);
  const book = store.readJSON(bookPath(bookId), null);
  if (!book) throw friendlyError('书籍数据缺失');
  const state = { canceled: false };
  generating.set(bookId, state);
  const m = mode === 'free' ? 'free' : 'flow';

  const run = (async () => {
    try {
      lib.status = 'generating'; lib.error = null; lib.mode = m;
      lib.outline = null; lib.sections = []; lib.frames = []; lib.cursor = null;
      lib.updatedAt = dayjs().format(); store.writeJSON(libPath(bookId), lib);

      if (m === 'free') {
        await generateFree(bookId, lib, book, state);
        return;
      }

      progress(bookId, 'outline', 5, '正在分析全书结构…');

      const personaData = canon.view();
      const pet = personaData.pet;
      const master = (personaData.user && String(personaData.user.name || '').trim()) || '主人';
      const outline = await genOutline(book);
      if (state.canceled) throw friendlyError('已取消');
      lib.outline = outline;
      progress(bookId, 'outline', 20, `大纲完成：共 ${outline.length} 节`);

      const total = outline.length;
      const compiled = [];
      for (let i = 0; i < total; i++) {
        if (state.canceled) throw friendlyError('已取消');
        const sec = outline[i];
        progress(bookId, 'flow', 20 + Math.round((i / total) * 75), `正在编写第 ${i + 1}/${total} 节「${sec.title}」的剧本…`);
        const slice = sectionSlice(book.text, i, total);
        const flow = await genFlow(pet, master, sec, slice, i, total, lib.title);
        // 帧编译：线性 next；测验帧选项反馈后汇聚到下一帧
        for (const it of flow) {
          const fid = `f${i}_${compiled.length}`;
          if (it.t === 'q') {
            compiled.push({ id: fid, type: 'quiz', sectionId: sec.id, q: it.q, options: it.o, correct: it.c, feedback: it.f, mood: sec.mood });
          } else {
            compiled.push({ id: fid, type: it.t === 'd' ? 'dialogue' : 'narration', sectionId: sec.id, mood: EMOTIONS.includes(it.e) ? it.e : sec.mood, text: it.x, bb: it.bb || '' });
          }
        }
        lib.sections = outline.slice(0, i + 1);
        lib.frames = compiled;
        lib.updatedAt = dayjs().format();
        store.writeJSON(libPath(bookId), lib);
      }

      lib.status = 'ready';
      lib.cursor = lib.cursor || (compiled.length ? compiled[0].id : null);
      lib.updatedAt = dayjs().format();
      store.writeJSON(libPath(bookId), lib);
      progress(bookId, 'done', 100, `剧本完成，共 ${compiled.length} 帧`);
    } catch (e) {
      const l = load(bookId);
      if (state.canceled) { l.status = 'parsed'; l.error = null; }
      else { l.status = 'error'; l.error = e.userMsg || e.message; }
      l.updatedAt = dayjs().format();
      store.writeJSON(libPath(bookId), l);
      progress(bookId, state.canceled ? 'cancel' : 'error', 0, state.canceled ? '已取消' : l.error);
      logger.warn('陪读生成' + (state.canceled ? '已取消' : '失败') + ': ' + (l.error || ''));
    } finally {
      generating.delete(bookId);
    }
  })();
  return { started: true };
}

function cancelGenerate(bookId) {
  const s = generating.get(bookId);
  if (s) s.canceled = true;
}

function save(bookId, patch) {
  const lib = load(bookId);
  Object.assign(lib, patch, { updatedAt: dayjs().format() });
  store.writeJSON(libPath(bookId), lib);
  return lib;
}

// ---------- 举手提问（侧信道，不改剧本状态） ----------
function relevantExcerpts(text, question, topN = 3, chunkSize = 800) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize));
  // 关键词计分：问题中的 2+ 字词片段
  const keys = [];
  const q = question.replace(/[，。？！\s]/g, '');
  for (let i = 0; i < q.length - 1; i++) keys.push(q.slice(i, i + 2));
  const scored = chunks.map(c => {
    let s = 0;
    for (const k of keys) if (c.includes(k)) s++;
    return { c, s };
  }).sort((a, b) => b.s - a.s);
  return scored.slice(0, topN).filter(x => x.s > 0).map(x => x.c);
}

async function ask(bookId, question) {
  const lib = load(bookId);
  if (lib.status !== 'ready') throw friendlyError('还没准备好——剧情/通读生成完成后才能提问');
  const book = store.readJSON(bookPath(bookId), null);
  const reqId = llm.newReqId('qa');
  const win = require('../windows').getWindow('reader');

  const personaData = canon.view();
  const pet = personaData.pet;
  const master = (personaData.user && String(personaData.user.name || '').trim()) || '主人';
  const free = (lib.mode || 'flow') === 'free';

  // 检索上下文：自由模式多带几段（没有剧情节次锚点，问答全靠它）
  const excerpts = relevantExcerpts(book ? book.text : '', question, free ? 4 : 3);
  const messages = free
    ? [{ role: 'system', content: prompts.readingFreeQAPrompt(pet, master, question, lib.notes || '（笔记缺失，只能靠原文节选回答）', excerpts) }]
    : (() => {
      // 当前所在节的上下文（outline 存的是 id 字段，帧引用 sectionId——两边对齐）
      const curFrame = (lib.frames || []).find(f => f.id === lib.cursor);
      const contextSection = lib.outline ? ((lib.outline.find(s => s.id === (curFrame && curFrame.sectionId)) || {}).title || '') : '';
      return [{ role: 'system', content: prompts.readingQAPrompt(pet, master, question, excerpts, contextSection) }];
    })();

  (async () => {
    try {
      const raw = await llm.streamChat({
        messages, reqId,
        onChunk: (delta) => { if (win && !win.isDestroyed()) win.webContents.send('reader:qa-chunk', { reqId, delta }); },
      });
      const { clean, emotion: emo } = emotion.parseAndStrip(raw);
      if (emo) emotion.broadcastEmotion(emo, { source: 'reader' });
      // 问答记入存档，不推进帧
      lib.qa = [...(lib.qa || []), { q: question, a: clean, at: dayjs().format(), atFrame: lib.cursor }];
      lib.updatedAt = dayjs().format();
      store.writeJSON(libPath(bookId), lib);
      if (win && !win.isDestroyed()) win.webContents.send('reader:qa-done', { reqId, clean, ok: true });
    } catch (e) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('reader:qa-done', { reqId, ok: false, error: e.userMsg || e.message });
      }
    }
  })();
  return { reqId };
}

module.exports = { upload, uploadVideo, cancelVideoUpload, list, listDigest, load, del, generate, cancelGenerate, save, ask, digestWindows, DIGEST_WINDOW_CHARS, DIGEST_MAX_WINDOWS };
