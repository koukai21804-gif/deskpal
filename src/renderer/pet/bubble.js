// 气泡组件：队列化展示；text 类自动消失，card 类停留至点击；同屏最多 1 张
import { dp } from '../common/ipc.js';

const host = document.createElement('div');
host.className = 'dp-bubble-host';
document.body.appendChild(host);

let queue = [];
let current = null;   // { el, timer, kind }
let defaultSeconds = 6;

export function setBubbleSeconds(s) { if (+s > 0) defaultSeconds = +s; }

export function push(bubble) {
  queue.push(bubble);
  if (!current) next();
}

// 立即用新气泡替换当前展示（丢弃排队中的旧文本气泡），台词与表情保持同步。
// 提醒卡 / 标注询问 / 写权限批准等重要气泡不被打断：新气泡排在其后，排队中的重要气泡也保留。
export function replace(bubble) {
  const important = (b) => b && (b.kind === 'schedule-card' || b.kind === 'ask-label' || b.kind === 'perm-ask');
  queue = queue.filter(important);
  if (current && important({ kind: current.kind })) {
    queue.push(bubble);
    return;
  }
  clearCurrent();
  queue.push(bubble);
  next();
}

function clearCurrent() {
  if (current) {
    if (current.timer) clearTimeout(current.timer);
    current.el.remove();
    current = null;
  }
}

function next() {
  clearCurrent();
  const b = queue.shift();
  if (!b) return;
  const el = document.createElement('div');

  if (b.kind === 'schedule-card') {
    el.className = 'dp-bubble schedule-card';
    el.innerHTML = `
      <div class="sc-title">📅 ${esc(b.title)}</div>
      <div class="sc-time">${esc(b.label)} · ${esc(b.timeText)}${b.nth ? `（第 ${b.nth + 1} 次提醒）` : ''}</div>
      <div class="b-actions">
        <button data-a="dismiss" class="primary">知道了</button>
        <button data-a="snooze">稍后10分钟</button>
        <button data-a="done">已完成</button>
        <button data-a="view">查看</button>
      </div>`;
    el.addEventListener('click', async (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (!a) return;
      if (a === 'snooze') await dp.scheduleSnooze(b.eventId, b.reminderId).catch(() => {});
      if (a === 'done') await dp.scheduleDone(b.eventId).catch(() => {});
      if (a === 'view') dp.openWindow('schedule');
      if (a === 'snooze') next(); // 稍后提醒：关卡片
      else next();
    });
    current = { el, kind: 'schedule-card' };
  } else if (b.kind === 'ask-label') {
    el.className = 'dp-bubble';
    el.innerHTML = `<div class="b-text">${esc(b.text)}</div>
      <div class="b-actions">
        <button data-a="yes" class="primary">好呀</button>
        <button data-a="no">下次吧</button>
      </div>`;
    el.addEventListener('click', (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (!a) return;
      if (a === 'yes') dp.timeOpenLabel();
      next();
    });
    current = { el, kind: 'ask-label' };
  } else if (b.kind === 'perm-ask') {
    // ★H 写权限批准：点击「去批准」聚焦聊天窗；超时自动消失（权限卡本身有倒计时）
    el.className = 'dp-bubble';
    el.innerHTML = `<div class="b-text">🛡 ${esc(b.text || '有个文件操作需要你批准')}</div>
      <div class="b-actions"><button data-a="go" class="primary">去批准</button></div>`;
    el.addEventListener('click', (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (!a) return;
      dp.openWindow('chat');
      next();
    });
    const timer = setTimeout(() => next(), 20 * 1000);
    current = { el, timer, kind: 'perm-ask' };
  } else {
    el.className = 'dp-bubble';
    el.innerHTML = `<div class="b-text">${esc(b.text)}</div>`;
    el.addEventListener('click', () => next()); // 点击立即关闭并显示下一条
    const timer = setTimeout(() => next(), (b.seconds || defaultSeconds) * 1000);
    current = { el, timer, kind: 'text' };
  }

  host.appendChild(el);
}

// 立即清空（睡觉等场景）
export function clearAll() { queue = []; next(); }

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
