// 情绪/日程/节拍标签协议：流式剥离 + 全窗口广播。宠物窗是表情的唯一渲染方。
// H2 协议（向后兼容）：
//   主协议：正文中可穿插短标签 [开心]/[思考]/…（6 键白名单），置于所修饰句子的句末；
//           流式按句触发宠物表情（多节拍、变化时才切换）。
//   兜底  ：回复最后一行 [情绪:XX]（整条一个）仍保留。
//   联动  ：[日程:{…}] JSON 标签剥离交渲染层确认。
const { BrowserWindow } = require('electron');
const dayjs = require('dayjs');

const KEY_MAP = { 平常: 'normal', 开心: 'happy', 惊讶: 'surprised', 愤怒: 'angry', 思考: 'thinking', 悲伤: 'sad' };
const EMOTION_CN = { normal: '平常', happy: '开心', surprised: '惊讶', angry: '愤怒', thinking: '思考', sad: '悲伤' };

const BEAT_RE = /\[(平常|开心|惊讶|愤怒|思考|悲伤)\]/;
const EMO_RE = /\[情绪[:：]\s*(平常|开心|惊讶|愤怒|思考|悲伤)\s*\]/;
const SCH_RE = /\[日程[:：]\s*(\{[\s\S]*?\})\s*\]/;
const TERMINATORS = '。！？…\n';

// 日程 JSON 抢救式解析（结构校验同旧实现）
function parseScheduleJson(raw) {
  try {
    const j = JSON.parse(raw);
    if (j && j.title && dayjs(j.start, 'YYYY-MM-DD HH:mm', true).isValid()) {
      return {
        title: String(j.title).slice(0, 40),
        kind: j.kind === 'task' ? 'task' : 'event',
        start: j.start,
        durationMin: Number.isFinite(+j.durationMin) ? +j.durationMin : null,
        deadline: j.deadline && dayjs(j.deadline, 'YYYY-MM-DD HH:mm', true).isValid() ? j.deadline : null,
        remindPreset: ['event', 'start', 'deadline', 'none'].includes(j.remindPreset) ? j.remindPreset : null,
      };
    }
  } catch (_) {}
  return null;
}

// 按句切分（。！？…\n；连续终止符归同一句），返回 [{start,end})
function splitSentences(text) {
  const sents = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (TERMINATORS.includes(text[i])) {
      let j = i + 1;
      while (j < text.length && TERMINATORS.includes(text[j])) j++;
      sents.push({ start, end: j });
      i = j - 1;
      start = j;
    }
  }
  if (start < text.length) sents.push({ start, end: text.length });
  return sents;
}

// 节拍标签位置 → 句序绑定：标签在句末时归属前一句（边界规则），句中错置时归属所在句
function mapBeatsToSentences(text, marks) {
  if (!marks.length) return [];
  const sents = splitSentences(text);
  const bySent = new Map();
  for (const mk of marks) {
    let k = -1;
    for (let i = sents.length - 1; i >= 0; i--) {
      if (sents[i].start < mk.pos && mk.pos < sents[i].end) { k = i; break; }
    }
    if (k < 0) for (let i = sents.length - 1; i >= 0; i--) if (sents[i].end <= mk.pos) { k = i; break; }
    if (k < 0) k = 0;
    bySent.set(k, mk.e); // 每句 ≤1 个，多标签取最后一个
  }
  return [...bySent.entries()].map(([s, e]) => ({ s, e })).sort((a, b) => a.s - b.s);
}

// 增量状态机：跨 chunk 安全切分，半截标签永不泄漏。
// feed(chunk) → { cleanDelta, beatHints:[emotionKey] }（hint = 本次剥离出的短标签，随正文同帧推送供渲染层触发）
// flush()    → { cleanDelta, clean, beats:[{s,e}], emotion, schedule }
function createBeatParser() {
  let buffer = '';
  let clean = '';          // 累积干净正文（未做格式收敛）
  const beatMarks = [];    // { pos（clean 中位置）, e }
  let emotion = null, schedule = null;
  let done = false;

  // 尾部悬着的 [日程:（其后无 ]）→ JSON 模式缓冲，上限 500 字符
  function openScheduleHold() {
    const re = /\[日程[:：]/g;
    let last = -1, m;
    while ((m = re.exec(buffer)) !== null) last = m.index;
    if (last < 0) return -1;
    return buffer.indexOf(']', last) === -1 ? last : -1;
  }

  function process(final) {
    let out = '';
    const hints = [];
    while (true) {
      // 三类标签取最早出现者
      let best = null;
      let m = BEAT_RE.exec(buffer);
      if (m) best = { start: m.index, end: m.index + m[0].length, kind: 'beat', key: KEY_MAP[m[1]] };
      m = EMO_RE.exec(buffer);
      if (m && (!best || m.index < best.start)) best = { start: m.index, end: m.index + m[0].length, kind: 'emo', key: KEY_MAP[m[1]] };
      m = SCH_RE.exec(buffer);
      if (m && (!best || m.index < best.start)) best = { start: m.index, end: m.index + m[0].length, kind: 'sch', raw: m[1] };
      if (!best) break;
      const head = buffer.slice(0, best.start);
      out += head; clean += head;
      buffer = buffer.slice(best.end);
      if (best.kind === 'beat') { beatMarks.push({ pos: clean.length, e: best.key }); hints.push(best.key); }
      else if (best.kind === 'emo') emotion = best.key;
      else { const s = parseScheduleJson(best.raw); if (s) schedule = s; }
    }
    if (!final) {
      // 尾巴保留：日程 JSON 模式优先（缓冲上限 500，超出视为普通文本放行）
      const sch = openScheduleHold();
      if (sch >= 0 && buffer.length - sch <= 500) {
        out += buffer.slice(0, sch); clean += buffer.slice(0, sch);
        buffer = buffer.slice(sch);
        return { cleanDelta: out, beatHints: hints };
      }
      // 短标签尾巴：自最后一个 [ 起无 ] 且长度 <12 → 暂缓推送（半截标签不泄漏）
      const li = buffer.lastIndexOf('[');
      if (li >= 0) {
        const tail = buffer.slice(li);
        if (!tail.includes(']') && tail.length < 12) {
          out += buffer.slice(0, li); clean += buffer.slice(0, li);
          buffer = tail;
          return { cleanDelta: out, beatHints: hints };
        }
      }
    }
    out += buffer; clean += buffer; buffer = '';
    return { cleanDelta: out, beatHints: hints };
  }

  return {
    feed(chunk) {
      if (done) return { cleanDelta: '', beatHints: [] };
      buffer += String(chunk);
      return process(false);
    },
    // 流结束：残余按正文输出；正文格式收敛（句序绑定在收敛前完成，索引不受影响）
    flush() {
      const beats = mapBeatsToSentences(clean, beatMarks);
      if (done) return { cleanDelta: '', clean: normalizeClean(clean), beats, emotion, schedule };
      done = true;
      const r = process(true);
      const finalBeats = mapBeatsToSentences(clean, beatMarks);
      return { cleanDelta: r.cleanDelta, clean: normalizeClean(clean), beats: finalBeats, emotion, schedule };
    },
  };
}

function normalizeClean(text) {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// 非流式路径 / 历史重建 / 陪读复用：签名不变，内部走同一解析核（beats 为新增返回字段，可忽略）
function parseAndStrip(content) {
  const p = createBeatParser();
  p.feed(String(content || ''));
  return p.flush();
}

function broadcastEmotion(emotionKey, { source = 'chat', revertMs = 0 } = {}) {
  if (!EMOTION_CN[emotionKey]) return;
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('pet:emotion', { emotion: emotionKey, source, revertMs }); } catch (_) {}
  }
}

module.exports = { parseAndStrip, createBeatParser, broadcastEmotion, KEY_MAP, EMOTION_CN };
