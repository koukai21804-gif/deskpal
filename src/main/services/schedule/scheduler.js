// 调度器：30s tick、触发先持久化再广播、错过补报、snooze、重复事件滚动续期、双通道触达（宠物气泡 + 系统通知 + 提示音）
const { Notification } = require('electron');
const dayjs = require('dayjs');
const fs = require('fs');
const path = require('path');
const store = require('../store');
const emotion = require('../emotion');
const windows = require('../../windows');
const logger = require('../../logger');

let timer = null;
let data = null; // { version, events: [] }

// 重复规则（repeat 功能）：daily=每天 / weekdays=工作日(周一至五) / weekly=每周。
// 语义：事件按规则滚动续期——一次发生的提醒全部出清（fired/missed/cancelled）后，
// start/deadline 整体平移到下一次发生并重新物化提醒；fired/missed 留痕封顶 10 条。
const REPEATS = ['none', 'daily', 'weekdays', 'weekly'];
const FIRED_HISTORY_CAP = 10;

// 下一次发生时刻：严格晚于 after，保持时分秒。远 past 锚先按规则量级快进；
// 迭代上限留足 weekends 跳过余量（weekdays 每周多耗 2 步）。
const ROLL_ITER_CAP = 420;
function nextOccurrence(anchor, repeat, after) {
  if (!REPEATS.includes(repeat) || repeat === 'none') return null;
  const limit = dayjs(after || undefined);
  let t = dayjs(anchor);
  if (!t.isValid()) return null;
  if (t.isBefore(limit)) {
    const back = repeat === 'weekly' ? ROLL_ITER_CAP * 7 : ROLL_ITER_CAP;
    const snap = limit.subtract(back, 'day');
    if (t.isBefore(snap)) {
      t = snap.hour(t.hour()).minute(t.minute()).second(t.second()).millisecond(0);
    }
  }
  for (let i = 0; i <= ROLL_ITER_CAP * 2 + 10; i++) {
    if (repeat === 'daily') t = t.add(1, 'day');
    else if (repeat === 'weekly') t = t.add(7, 'day');
    else {
      t = t.add(1, 'day');
      while (t.day() === 0 || t.day() === 6) t = t.add(1, 'day');
    }
    if (t.isAfter(limit)) return t;
  }
  return null;
}

function file() { return path.join(store.getDataDir(), 'schedule', 'events.json'); }
function save() { store.writeJSON('schedule/events.json', data); windows.broadcastAll('schedule:changed', {}); }
function loadEvents() { data = store.get('schedule/events'); }

// ---------- 事件构造 ----------
function newId(prefix) {
  return prefix + '_' + dayjs().format('YYYYMMDDHHmmss') + '_' + Math.random().toString(36).slice(2, 6);
}

function newEvent({ kind, title, notes = '', start = null, deadline = null, durationMin = null, remindPreset = 'none', repeat = 'none', source = 'manual', groupId = null }) {
  return {
    id: newId('evt'), kind, title: String(title || '').slice(0, 30), notes: String(notes || '').slice(0, 200),
    start: start ? dayjs(start).format() : null,
    end: start && durationMin ? dayjs(start).add(durationMin, 'minute').format() : null,
    deadline: deadline ? dayjs(deadline).format() : null,
    durationMin: durationMin || null,
    remindPreset,
    repeat: REPEATS.includes(repeat) ? repeat : 'none', reminders: [],
    status: 'pending', source, groupId,
    createdAt: dayjs().format(), updatedAt: dayjs().format(), doneAt: null,
  };
}

// 入库时把预设物化为具体触发时间戳
function materializeReminders(ev) {
  const s = store.get('settings').schedule;
  const rs = [];
  const mk = (at, label, kind) => {
    if (!at || at.isBefore(dayjs().add(20, 'second'))) return; // 已过期的不生成
    rs.push({ id: 'r' + (rs.length + 1), at: at.format(), label, kind, status: 'pending', firedAt: null, snoozedTo: null, snoozeCount: 0 });
  };
  const start = ev.start ? dayjs(ev.start) : null;
  const deadline = ev.deadline ? dayjs(ev.deadline) : null;
  if (ev.remindPreset === 'event' && start) {
    mk(start.subtract(s.leadEvent, 'minute'), `提前${s.leadEvent}分钟`, 'lead');
    mk(start, '开始', 'atstart');
  } else if (ev.remindPreset === 'start' && start) {
    mk(start.subtract(s.leadStart, 'minute'), `提前${s.leadStart}分钟`, 'lead');
    mk(start, '开始', 'atstart');
  } else if (ev.remindPreset === 'only_start' && start) {
    // 仅开始时刻提醒一次（repeat 提醒用：避免每天多响一次「提前N分钟」）
    mk(start, '开始', 'atstart');
  } else if (ev.remindPreset === 'deadline' && deadline) {
    mk(deadline.subtract(s.leadDeadline, 'minute'), `提前${s.leadDeadline}分钟`, 'lead');
    mk(deadline, '截止', 'atdeadline');
  }
  ev.reminders = rs;
}

// ---------- CRUD ----------
function listEvents() { return data.events; }

// 重复事件滚动续期：待触发提醒已全部出清时，把 start/deadline 平移到下一次发生
// 并重新物化（fired 历史封顶保留）。非重复事件 / 仍有 pending 提醒时不动作。
// remindPreset=none 的重复事件是惰性的（永不产生提醒）——不滚动，否则每个 tick
// 都会空转顺延一天。
function advanceRepeating(ev) {
  if (!ev || ev.status !== 'pending' || !REPEATS.includes(ev.repeat) || ev.repeat === 'none') return false;
  if (ev.remindPreset === 'none') return false;
  if (ev.reminders.some(r => r.status === 'pending')) return false;
  const anchor = ev.deadline ? dayjs(ev.deadline) : dayjs(ev.start);
  const next = nextOccurrence(anchor, ev.repeat, dayjs());
  if (!next) return false;
  const deltaMin = next.diff(anchor, 'minute'); // 整体平移，保时长与时钟点
  if (ev.start) ev.start = dayjs(ev.start).add(deltaMin, 'minute').format();
  if (ev.end) ev.end = dayjs(ev.end).add(deltaMin, 'minute').format();
  if (ev.deadline) ev.deadline = dayjs(ev.deadline).add(deltaMin, 'minute').format();
  // fired/missed 历史封顶保留（错过补报的 missed 也是「发生过什么」的留痕）
  const history = ev.reminders.filter(r => r.status === 'fired' || r.status === 'missed').slice(-FIRED_HISTORY_CAP);
  materializeReminders(ev);
  ev.reminders = [...history, ...ev.reminders];
  ev.updatedAt = dayjs().format();
  return true;
}

function addEvent(ev) {
  materializeReminders(ev);
  advanceRepeating(ev); // 首物化即全过期（如「每天9点」在 14 点创建）→ 立刻顺延到下一次
  data.events.push(ev);
  save();
  return ev;
}

function findEvent(id) { return data.events.find(e => e.id === id); }

function updateEvent(patch) {
  const ev = findEvent(patch.id);
  if (!ev) throw new Error('日程不存在');
  Object.assign(ev, patch, { updatedAt: dayjs().format() });
  // 时间/预设/重复变化 → 重建未触发的 reminders（fired 保留历史）
  if (patch.start !== undefined || patch.deadline !== undefined || patch.remindPreset !== undefined || patch.repeat !== undefined) {
    const fired = ev.reminders.filter(r => r.status === 'fired');
    materializeReminders(ev);
    ev.reminders = [...fired, ...ev.reminders];
    advanceRepeating(ev); // 重复事件改完后若全部已过期，立刻顺延到下一次
  }
  save();
  return ev;
}

function deleteEvent(id) {
  data.events = data.events.filter(e => e.id !== id);
  save();
}

function doneEvent(id) {
  const ev = findEvent(id);
  if (!ev) return;
  ev.status = 'done'; ev.doneAt = dayjs().format(); ev.updatedAt = dayjs().format();
  for (const r of ev.reminders) if (r.status === 'pending') r.status = 'cancelled';
  save();
}

function snoozeReminder(eventId, reminderId) {
  const ev = findEvent(eventId);
  const r = ev && ev.reminders.find(x => x.id === reminderId);
  if (!r) return;
  const min = store.get('settings').schedule.snoozeMin || 10;
  r.snoozedTo = dayjs().add(min, 'minute').format();
  r.snoozeCount = (r.snoozeCount || 0) + 1;
  save();
}

function dismissReminder(eventId, reminderId) {
  const ev = findEvent(eventId);
  const r = ev && ev.reminders.find(x => x.id === reminderId);
  if (r) { r.snoozedTo = null; } // 仅关卡片（fired 已持久化）
}

// ---------- 触发 ----------
function relTimeText(at, kind) {
  const diffMin = dayjs(at).diff(dayjs(), 'minute');
  if (kind === 'atstart') return diffMin <= 1 ? '现在开始啦' : `${diffMin} 分钟后开始`;
  if (kind === 'atdeadline') return diffMin <= 1 ? '就是现在截止！' : `${diffMin} 分钟后截止`;
  return diffMin <= 1 ? '马上就开始！' : `还有 ${diffMin} 分钟`;
}

function fire(ev, r, nth = 0) {
  logger.info(`日程提醒触发: ${ev.title} (${r.label})`);
  // ① 宠物：惊讶表情 + 气泡提醒卡
  emotion.broadcastEmotion('surprised', { source: 'schedule', revertMs: 8000 });
  windows.broadcastAll('schedule:remind', {
    eventId: ev.id, reminderId: r.id,
    title: ev.title, label: r.label, kind: r.kind,
    timeText: relTimeText(r.kind === 'atdeadline' ? (ev.deadline || r.at) : (ev.start || r.at), r.kind),
    nth, event: ev,
  });
  // ② 系统通知
  const s = store.get('settings').schedule;
  if (s.systemNotification !== false && Notification.isSupported()) {
    const n = new Notification({
      title: `📅 ${ev.title}`,
      body: `${r.label}｜${relTimeText(r.kind === 'atdeadline' ? (ev.deadline || r.at) : (ev.start || r.at), r.kind)}${nth ? `（第 ${nth + 1} 次提醒）` : ''}`,
    });
    n.on('click', () => windows.openWindow('schedule'));
    n.show();
  }
  // ③ 提示音（宠物窗播放）
  if (s.sound !== false) windows.broadcastAll('pet:ding', {});
}

function tick() {
  try {
    const now = dayjs();
    const catchupMs = (store.get('settings').schedule.catchupHours || 24) * 3600 * 1000;
    for (const ev of data.events) {
      if (ev.status !== 'pending') continue;
      for (const r of ev.reminders) {
        if (r.status !== 'pending') continue;
        const at = dayjs(r.at);
        // snooze 唤醒
        if (r.snoozedTo && dayjs(r.snoozedTo).isBefore(now)) {
          const nth = r.snoozeCount || 0;
          r.snoozedTo = null;
          save(); // 先持久化
          fire(ev, r, nth);
          continue;
        }
        if (!r.snoozedTo && at.isBefore(now)) {
          if (now.diff(at) > catchupMs) {
            r.status = 'missed'; // 超过补报窗口，静默标记
            save();
            continue;
          }
          r.status = 'fired'; r.firedAt = now.format();
          save(); // 先持久化再广播，防崩溃重发
          fire(ev, r, 0);
        }
      }
      if (advanceRepeating(ev)) save(); // 重复事件提醒出清 → 滚动到下一次
    }
  } catch (e) { logger.error(e); }
}

function catchUp() {
  const now = dayjs();
  const catchupMs = (store.get('settings').schedule.catchupHours || 24) * 3600 * 1000;
  const missed = [];
  for (const ev of data.events) {
    if (ev.status !== 'pending') continue;
    for (const r of ev.reminders) {
      if (r.status !== 'pending' || r.snoozedTo) continue;
      const at = dayjs(r.at);
      if (at.isBefore(now)) {
        if (now.diff(at) <= catchupMs) {
          missed.push({ event: ev, reminder: r, label: r.label, title: ev.title, at: r.at });
          r.status = 'fired'; r.firedAt = now.format();
        } else {
          r.status = 'missed';
        }
      }
    }
  }
  if (missed.length) {
    save();
    // 汇总气泡 + 日程页红条
    const names = missed.slice(0, 3).map(m => `「${m.title}」`).join(' ') + (missed.length > 3 ? ' 等' : '');
    emotion.broadcastEmotion('surprised', { source: 'schedule', revertMs: 8000 });
    windows.broadcastAll('pet:bubble', { kind: 'text', text: `有 ${missed.length} 个错过的提醒：${names}，记得去日程页看看哦～` });
    windows.broadcastAll('schedule:catchup', { items: missed.map(m => ({ eventId: m.event.id, title: m.title, label: m.label, at: m.at })) });
    logger.info(`启动补报 ${missed.length} 条错过的提醒`);
  }
}

function start() {
  loadEvents();
  catchUp();
  timer = setInterval(tick, 30 * 1000);
  tick();
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
  start, stop, tick, catchUp, fire,
  newEvent, materializeReminders, addEvent, updateEvent, deleteEvent, doneEvent,
  snoozeReminder, dismissReminder, listEvents, findEvent,
  nextOccurrence, advanceRepeating, REPEATS,
};
