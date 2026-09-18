// 心跳合并 → 按天 JSONL 会话；空闲切换；空闲归来未知应用询问
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const store = require('../store');
const classifier = require('./classifier');
const stats = require('./stats');
const emotion = require('../emotion');
const windows = require('../../windows');
const logger = require('../../logger');

let current = null;   // 当前会话 { exeName, exePath, title, start, lastSeen }
let idleOpen = null;  // { start }
let mergeGapMs = 2000;
let askedIdleBack = dayjs().format('YYYY-MM-DD'); // 同一天只问一次

function dayFile(d = dayjs()) {
  return path.join(store.getDataDir(), 'activity', d.format('YYYY-MM-DD') + '.jsonl');
}

function appendLine(line) {
  try {
    fs.mkdirSync(path.join(store.getDataDir(), 'activity'), { recursive: true });
    fs.appendFileSync(dayFile(dayjs(line.start ? new Date(line.start) : new Date())), JSON.stringify(line) + '\n');
  } catch (e) { logger.warn('活动写入失败: ' + e.message); }
}

function closeCurrent(endMs) {
  if (!current) return;
  const end = endMs || current.lastSeen;
  if (end > current.start + 1000) { // <1s 的碎样本丢弃
    appendLine({ type: 'app', app: current.exeName, exe: current.exePath, title: current.title, start: current.start, end, dur: end - current.start });
  }
  current = null;
}

function start() { current = null; idleOpen = null; }

function onWindowSample(w) {
  const now = Date.now();
  if (idleOpen) { onIdleEnd(now); } // 保险：窗口活动意味着已回来
  if (current && current.exeName === w.exeName && current.title === w.title) {
    current.lastSeen = now; // 心跳合并
  } else {
    closeCurrent(); // 会话结束时刻 = 最后一次心跳
    current = { exeName: w.exeName, exePath: w.exePath, title: w.title, start: now, lastSeen: now };
  }
}

function onIdleStart(atMs) {
  closeCurrent(atMs);
  idleOpen = { start: atMs };
}

function onIdleEnd(nowMs) {
  if (idleOpen) {
    if (nowMs - idleOpen.start > 5000) {
      appendLine({ type: 'afk', start: idleOpen.start, end: nowMs, dur: nowMs - idleOpen.start });
    }
    idleOpen = null;
  }
  // 空闲归来：当天存在未分类应用 → 宠物气泡询问（每天最多一次）
  try {
    const today = dayjs().format('YYYY-MM-DD');
    if (askedIdleBack !== today) {
      const unknown = stats.unknownApps('today');
      if (unknown.length) {
        askedIdleBack = today;
        emotion.broadcastEmotion('thinking', { source: 'idle', revertMs: 8000 });
        windows.broadcastAll('pet:bubble', {
          kind: 'ask-label',
          text: '今天开启的部分应用我不明白是什么类型的，你可以帮我标注一下吗？',
        });
        windows.broadcastAll('activity:idle-back', { unknownCount: unknown.length });
      }
    }
  } catch (e) { logger.warn(e); }
}

function flush() {
  closeCurrent();
  if (idleOpen) {
    const now = Date.now();
    if (now - idleOpen.start > 5000) appendLine({ type: 'afk', start: idleOpen.start, end: now, dur: now - idleOpen.start });
    idleOpen = null;
  }
}

module.exports = { start, onWindowSample, onIdleStart, onIdleEnd, flush };
