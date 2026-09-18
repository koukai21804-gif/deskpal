// 情绪/日程标签协议：解析剥离 + 全窗口广播。宠物窗是表情的唯一渲染方。
const { BrowserWindow } = require('electron');
const dayjs = require('dayjs');

const KEY_MAP = { 平常: 'normal', 开心: 'happy', 惊讶: 'surprised', 愤怒: 'angry', 思考: 'thinking', 悲伤: 'sad' };
const EMOTION_CN = { normal: '平常', happy: '开心', surprised: '惊讶', angry: '愤怒', thinking: '思考', sad: '悲伤' };

function parseAndStrip(content) {
  let clean = String(content || '');
  let emotion = null, schedule = null;

  // 1. 情绪标签：取最后一次出现
  const emRe = /\[情绪[:：]\s*(平常|开心|惊讶|愤怒|思考|悲伤)\s*\]/g;
  let m, last = null;
  while ((m = emRe.exec(clean)) !== null) last = m;
  if (last) { emotion = KEY_MAP[last[1]]; }

  // 2. 日程标签：JSON 抢救式解析
  const schRe = /\[日程[:：]\s*(\{[\s\S]*?\})\s*\]/;
  const sm = clean.match(schRe);
  if (sm) {
    try {
      const j = JSON.parse(sm[1]);
      if (j && j.title && dayjs(j.start, 'YYYY-MM-DD HH:mm', true).isValid()) {
        schedule = {
          title: String(j.title).slice(0, 40),
          kind: j.kind === 'task' ? 'task' : 'event',
          start: j.start,
          durationMin: Number.isFinite(+j.durationMin) ? +j.durationMin : null,
          deadline: j.deadline && dayjs(j.deadline, 'YYYY-MM-DD HH:mm', true).isValid() ? j.deadline : null,
          remindPreset: ['event', 'start', 'deadline', 'none'].includes(j.remindPreset) ? j.remindPreset : null,
        };
      }
    } catch (_) { schedule = null; }
  }

  // 3. 剥离标签 + 清理
  clean = clean.replace(emRe, '').replace(schRe, '');
  clean = clean.replace(/\n{3,}/g, '\n\n').trim();

  return { clean, emotion, schedule };
}

function broadcastEmotion(emotionKey, { source = 'chat', revertMs = 0 } = {}) {
  if (!EMOTION_CN[emotionKey]) return;
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('pet:emotion', { emotion: emotionKey, source, revertMs }); } catch (_) {}
  }
}

module.exports = { parseAndStrip, broadcastEmotion, KEY_MAP, EMOTION_CN };
