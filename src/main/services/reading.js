// 陪读管线：上传→两阶段生成（大纲→逐节 flow）→帧编译→举手提问侧信道→存档
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const store = require('./store');
const documents = require('./documents');
const llm = require('./llm');
const prompts = require('./prompts');
const emotion = require('./emotion');
const { rescueJSON } = require('./json-utils');
const logger = require('../logger');

const EMOTIONS = ['normal', 'happy', 'surprised', 'angry', 'thinking', 'sad'];
const generating = new Map(); // bookId -> { canceled: bool }

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
    outline: null, sections: [], frames: [], qa: [], cursor: null,
    createdAt: dayjs().format(), updatedAt: dayjs().format(),
  });
  return { bookId: id, meta };
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
      createdAt: lib.createdAt, updatedAt: lib.updatedAt,
      frames: (lib.frames || []).length, qa: (lib.qa || []).length,
      hasCursor: !!lib.cursor,
    };
  }).filter(Boolean).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
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

// ---------- 生成主流程 ----------
async function generate(bookId) {
  if (generating.has(bookId)) throw friendlyError('这本书正在生成中');
  const lib = load(bookId);
  const book = store.readJSON(bookPath(bookId), null);
  if (!book) throw friendlyError('书籍数据缺失');
  const state = { canceled: false };
  generating.set(bookId, state);

  const run = (async () => {
    try {
      lib.status = 'generating'; lib.error = null; lib.outline = null; lib.sections = []; lib.frames = [];
      lib.updatedAt = dayjs().format(); store.writeJSON(libPath(bookId), lib);
      progress(bookId, 'outline', 5, '正在分析全书结构…');

      const personaData = store.get('persona');
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
  if (lib.status !== 'ready') throw friendlyError('剧本还没生成完成，暂时不能提问');
  const book = store.readJSON(bookPath(bookId), null);
  const reqId = llm.newReqId('qa');
  const win = require('../windows').getWindow('reader');

  // 当前所在节的上下文
  const curFrame = (lib.frames || []).find(f => f.id === lib.cursor);
  const contextSection = lib.outline ? (lib.outline.find(s => s.sectionId === (curFrame && curFrame.sectionId)) || {}).title : '';

  const excerpts = relevantExcerpts(book ? book.text : '', question);
  const personaData = store.get('persona');
  const master = (personaData.user && String(personaData.user.name || '').trim()) || '主人';
  const messages = [{ role: 'system', content: prompts.readingQAPrompt(personaData.pet, master, question, excerpts, contextSection) }];

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

module.exports = { upload, list, load, del, generate, cancelGenerate, save, ask };
