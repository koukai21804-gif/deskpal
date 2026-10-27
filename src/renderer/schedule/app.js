// 日程页：一句话速添 / 表单添加 / Excel 导入 / 7天条 / 分组列表 / 补报红条
import { dp, initTheme, esc, errText } from '../common/ipc.js';
import { t, tf, lang as i18nLang } from '../common/i18n.js';
import { openModal, toast, confirmBox } from '../common/ui.js';
import { mountTitlebar } from '../common/windows/titlebar.js';
import { icon } from '../common/icons.js';

const app = document.getElementById('app');
app.appendChild(mountTitlebar(t('deskpal · 日程')));

const root = document.createElement('div');
root.className = 'sch-wrap';
root.innerHTML = `
  <div class="sch-body">
    <div>
      <div class="quick-add">
        <input type="text" id="qaInput" placeholder="${t('试试：明天晚上18点我要跟女朋友约会')}">
        <button class="btn btn-primary" id="qaAdd">${icon('plus', 14)} ${t('添加')}</button>
        <button class="btn" id="formAdd">${icon('file', 14)} ${t('表单添加')}</button>
        <button class="btn" id="xlAdd">${icon('upload', 14)} ${t('导入 Excel')}</button>
      </div>
      <div class="hint qa-tip" id="qaTip">${t('说一句话就行：我会解析出时间并按类型自动设好提醒（事件提前 60 分钟、任务截止提前 120 分钟，可在设置调整）；也支持重复：试试「每天9点提醒我喝水」')}</div>
    </div>
    <div id="catchupHost"></div>
    <div class="week-strip" id="weekStrip"></div>
    <div id="listHost"></div>
  </div>`;
app.appendChild(root);

let events = [];
let dayFilter = null; // 'YYYY-MM-DD' | null

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; // en 模式星期名（zh 用 周X）
function dayjs(d) {
  if (d === undefined || d === null) return new Date();
  if (typeof d === 'string') {
    // 兼容两种格式：ISO "2026-09-17T18:00:00+08:00" 与 "YYYY-MM-DD HH:mm"
    if (d.includes('T')) return new Date(d);
    return new Date(d.replace(/-/g, '/'));
  }
  return new Date(d);
}
function fmt(d) {
  const x = dayjs(d);
  return tf('{0}月{1}日 {2}:{3}', x.getMonth() + 1, x.getDate(), String(x.getHours()).padStart(2, '0'), String(x.getMinutes()).padStart(2, '0'));
}
function ymd(d) {
  const x = dayjs(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// ================= 速添 =================
async function quickAdd(text) {
  text = String(text || '').trim();
  if (!text) return;
  root.querySelector('#qaTip').textContent = t('正在解析…');
  root.querySelector('#qaTip').style.color = 'var(--dp-text-muted)';
  try {
    const r = await dp.scheduleParse(text);
    if (r.understood && r.draft) {
      openConfirmCard(r.draft, { fromParse: true });
      root.querySelector('#qaTip').textContent = t('解析成功，确认一下就入库～');
    } else if (r.question) {
      const tip = root.querySelector('#qaTip');
      tip.textContent = tf('需要确认：{0}', r.question);
      tip.style.color = 'var(--dp-warn)';
    } else {
      toast(t('这句话像是在安排日程吗？试试「明天下午3点开会」这样的说法'), 'warn');
    }
  } catch (err) {
    toast(tf('{0}（也可以用「表单添加」手动录入）', errText(err)), 'error', 4000);
  }
}

// ================= 确认卡（速添/表单/编辑共用） =================
function openConfirmCard(ev, { fromParse = false, onSave = false } = {}) {
  const m = openModal({ title: onSave ? t('编辑日程') : (fromParse ? t('确认日程') : t('添加日程')), width: '560px' });
  const kind = ev.kind || 'event';
  const dtLocal = (iso) => {
    if (!iso) return '';
    const d = dayjs(iso);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  m.body.innerHTML = `
    <div class="ev-form">
      <div class="field full"><span class="label">${t('标题')}</span><input type="text" id="f-title" value="${esc(ev.title || '')}" maxlength="30"></div>
      <div class="field"><span class="label">${t('类型')}</span>
        <select id="f-kind">
          <option value="event" ${kind === 'event' ? 'selected' : ''}>${t('事件（约会/会议/外出）')}</option>
          <option value="task" ${kind === 'task' ? 'selected' : ''}>${t('任务（有开始/截止的工作）')}</option>
        </select></div>
      <div class="field"><span class="label">${t('提醒预设')}</span>
        <select id="f-preset">
          <option value="event" ${ev.remindPreset === 'event' ? 'selected' : ''}>${t('事件：提前60分钟 + 开始时')}</option>
          <option value="start" ${ev.remindPreset === 'start' ? 'selected' : ''}>${t('任务开始：提前5分钟 + 开始时')}</option>
          <option value="only_start" ${ev.remindPreset === 'only_start' ? 'selected' : ''}>${t('仅开始时（提醒一次）')}</option>
          <option value="deadline" ${ev.remindPreset === 'deadline' ? 'selected' : ''}>${t('截止：提前120分钟 + 截止时')}</option>
          <option value="none" ${ev.remindPreset === 'none' ? 'selected' : ''}>${t('不提醒')}</option>
        </select></div>
      <div class="field"><span class="label">${t('开始时间')}</span><input type="datetime-local" id="f-start" value="${dtLocal(ev.start)}"></div>
      <div class="field"><span class="label">${t('时长（分钟，可空）')}</span><input type="number" id="f-dur" min="5" max="1440" value="${ev.durationMin || ''}"></div>
      <div class="field"><span class="label">${t('截止时间（任务可空）')}</span><input type="datetime-local" id="f-deadline" value="${dtLocal(ev.deadline)}"></div>
      <div class="field"><span class="label">${t('重复')}</span>
        <select id="f-repeat">
          <option value="none" ${!ev.repeat || ev.repeat === 'none' ? 'selected' : ''}>${t('不重复')}</option>
          <option value="daily" ${ev.repeat === 'daily' ? 'selected' : ''}>${t('每天')}</option>
          <option value="weekdays" ${ev.repeat === 'weekdays' ? 'selected' : ''}>${t('每个工作日')}</option>
          <option value="weekly" ${ev.repeat === 'weekly' ? 'selected' : ''}>${t('每周')}</option>
        </select></div>
      <div class="field"><span class="label">${t('备注')}</span><input type="text" id="f-notes" value="${esc(ev.notes || '')}" maxlength="100"></div>
    </div>
    <div class="hint" id="f-hint"></div>`;
  const foot = document.createElement('div');
  foot.className = 'modal-foot';
  foot.innerHTML = `<button class="btn" id="f-cancel">${t('取消')}</button><button class="btn btn-primary" id="f-save">${t('保存')}</button>`;
  m.el.appendChild(foot);

  const readForm = () => ({
    id: ev.id,
    kind: m.body.querySelector('#f-kind').value,
    title: m.body.querySelector('#f-title').value.trim() || t('未命名日程'),
    start: m.body.querySelector('#f-start').value ? m.body.querySelector('#f-start').value.replace('T', ' ') : null,
    durationMin: +m.body.querySelector('#f-dur').value || null,
    deadline: m.body.querySelector('#f-deadline').value ? m.body.querySelector('#f-deadline').value.replace('T', ' ') : null,
    remindPreset: m.body.querySelector('#f-preset').value,
    repeat: m.body.querySelector('#f-repeat').value,
    notes: m.body.querySelector('#f-notes').value.trim(),
  });

  foot.querySelector('#f-cancel').addEventListener('click', () => m.close());
  foot.querySelector('#f-save').addEventListener('click', async () => {
    const draft = readForm();
    if (!draft.start && !draft.deadline) return toast(t('开始时间和截止时间至少填一个'), 'warn');
    try {
      if (onSave) await dp.scheduleUpdate({ ...draft, ...{ id: ev.id } });
      else await dp.scheduleAdd({ ...draft, source: ev.source || 'manual' });
      toast(onSave ? t('已更新') : t('已加入日程，到点我会提醒你～'), 'ok');
      m.close();
      refresh();
    } catch (err) { toast(errText(err), 'error'); }
  });
}

// ================= Excel 导入 =================
async function importExcel() {
  const p = await dp.pickFile({ title: t('选择项目管理的 Excel 表'), filters: [{ name: 'Excel', extensions: ['xlsx', 'xlsm'] }] });
  if (!p) return;
  toast(t('读取表格中…'));
  try {
    const sheet = await dp.scheduleExcelParse(p);
    toast(t('AI 拆解任务中…'));
    const { tasks } = await (async () => {
      // 复用主进程 decompose：schedule:excel-parse 只读表，这里再走一次带 rows 的解析
      return await dp.scheduleExcelDecompose(sheet);
    })();
    if (!tasks.length) return toast(t('这份表里没有识别出可安排的任务（或缺少时间信息）'), 'warn', 4000);
    openExcelPreview(sheet, tasks);
  } catch (err) { toast(errText(err), 'error', 4000); }
}

function openExcelPreview(sheet, tasks) {
  const m = openModal({ title: tf('预览并导入任务（识别出 {0} 条）', tasks.length), width: '760px' });
  const rows = tasks.map(x => ({ ...x, on: !!x.valid }));
  m.body.innerHTML = `
    <div class="hint" style="margin-bottom:8px">${tf('来源表：{0} · 可编辑每行内容，取消勾选则跳过；解析失败的行已自动标灰', esc(sheet.sheetNames.join(' / ')))}</div>
    <div style="max-height:46vh;overflow:auto">
      <table class="xl-table">
        <thead><tr><th style="width:34px"></th><th>${t('任务')}</th><th>${t('开始时间')}</th><th>${t('截止时间')}</th><th>${t('提醒')}</th><th>${t('说明')}</th></tr></thead>
        <tbody>
        ${rows.map((task, i) => `
          <tr class="${task.on ? '' : 'off'}" data-i="${i}">
            <td><input type="checkbox" data-f="on" ${task.on ? 'checked' : ''}></td>
            <td><input type="text" data-f="title" value="${esc(task.title)}" ${task.valid ? '' : 'disabled'}></td>
            <td><input type="text" data-f="start" value="${task.start ? fmt(task.start) : ''}" placeholder="YYYY-MM-DD HH:mm"></td>
            <td><input type="text" data-f="deadline" value="${task.deadline ? fmt(task.deadline) : ''}" placeholder="YYYY-MM-DD HH:mm"></td>
            <td><select data-f="remindPreset">
              <option value="deadline" ${task.remindPreset === 'deadline' ? 'selected' : ''}>${t('截止前120分钟')}</option>
              <option value="start" ${task.remindPreset === 'start' ? 'selected' : ''}>${t('开始前5分钟')}</option>
              <option value="none" ${task.remindPreset === 'none' ? 'selected' : ''}>${t('不提醒')}</option>
            </select></td>
            <td><input type="text" data-f="notes" value="${esc(task.notes)}"></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  const foot = document.createElement('div');
  foot.className = 'modal-foot';
  foot.innerHTML = `<span class="hint" id="xl-count"></span><button class="btn" id="xl-cancel">${t('取消')}</button><button class="btn btn-primary" id="xl-import">${t('导入')}</button>`;
  m.el.appendChild(foot);

  const updateCount = () => { foot.querySelector('#xl-count').textContent = tf('将导入 {0} 条', m.body.querySelectorAll('input[data-f=on]:checked').length); };
  m.body.addEventListener('change', (e) => {
    if (e.target.dataset.f === 'on') e.target.closest('tr').classList.toggle('off', !e.target.checked);
    updateCount();
  });
  updateCount();

  foot.querySelector('#xl-cancel').addEventListener('click', () => m.close());
  foot.querySelector('#xl-import').addEventListener('click', async () => {
    const out = [];
    m.body.querySelectorAll('tr[data-i]').forEach(tr => {
      const i = +tr.dataset.i;
      const on = tr.querySelector('[data-f=on]').checked;
      if (!on) return;
      const g = f => tr.querySelector(`[data-f=${f}]`);
      out.push({
        title: g('title').value.trim(),
        notes: g('notes').value.trim(),
        start: g('start').value.trim() || null,
        deadline: g('deadline').value.trim() || null,
        remindPreset: g('remindPreset').value,
        valid: true,
      });
    });
    if (!out.length) return toast(t('没有勾选任何任务'), 'warn');
    try {
      const { imported } = await dp.scheduleExcelImport(out);
      toast(tf('已导入 {0} 条任务', imported), 'ok');
      m.close();
      refresh();
    } catch (err) { toast(errText(err), 'error'); }
  });
}

// ================= 列表 =================
async function refresh() {
  events = await dp.scheduleList();
  renderWeekStrip();
  renderList();
}

function renderWeekStrip() {
  const host = root.querySelector('#weekStrip');
  const days = [];
  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    days.push(d);
  }
  host.innerHTML = days.map((d, i) => {
    const key = ymd(d);
    const n = events.filter(e => e.status === 'pending' && [e.start, e.deadline].some(x => x && ymd(x) === key)).length;
    return `<div class="day-chip ${dayFilter === key ? 'active' : ''}" data-day="${key}" role="button" tabindex="0" aria-pressed="${dayFilter === key}">
      <div>${i === 0 ? t('今天') : i === 1 ? t('明天') : (i18nLang() === 'en' ? WEEK_EN[d.getDay()] : tf('周{0}', WEEK_CN[d.getDay()]))}</div>
      <div class="d-num">${d.getDate()}</div>
      <div class="d-dot">${n ? `<div style="width:${Math.min(34, 6 + n * 8)}px"></div>` : ''}</div>
    </div>`;
  }).join('');
  const toggleDay = (el) => {
    dayFilter = dayFilter === el.dataset.day ? null : el.dataset.day;
    renderWeekStrip(); renderList();
  };
  host.querySelectorAll('.day-chip').forEach(c => {
    c.addEventListener('click', () => toggleDay(c));
    c.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDay(c); }
    });
  });
}

function renderList() {
  const host = root.querySelector('#listHost');
  const now = new Date();
  const todayKey = ymd(now);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const tomorrowKey = ymd(tomorrow);
  const weekEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);

  const visible = events.filter(e => {
    if (dayFilter) return [e.start, e.deadline].some(x => x && ymd(x) === dayFilter);
    return true;
  });
  const active = visible.filter(e => e.status === 'pending');
  const groups = [
    { name: t('今天'), match: e => [e.start, e.deadline].some(x => x && ymd(x) === todayKey) },
    { name: t('明天'), match: e => [e.start, e.deadline].some(x => x && ymd(x) === tomorrowKey) },
    { name: t('本周'), match: e => [e.start, e.deadline].some(x => x && new Date(x) <= weekEnd && new Date(x) > tomorrow) },
    { name: t('更晚'), match: e => [e.start, e.deadline].some(x => x && new Date(x) > weekEnd) },
  ];

  let html = '';
  let used = new Set();
  for (const g of groups) {
    const items = active.filter(e => !used.has(e.id) && g.match(e));
    if (!items.length) continue;
    items.forEach(e => used.add(e.id));
    html += `<div class="group-title">${icon('calendar', 13)} ${g.name}（${items.length}）</div>` + items.map(cardHTML).join('');
  }
  const rest = active.filter(e => !used.has(e.id));
  if (rest.length) html += `<div class="group-title">${icon('calendar', 13)} ${t('无具体时间')}</div>` + rest.map(cardHTML).join('');

  const doneList = visible.filter(e => e.status === 'done');
  if (doneList.length) html += `<div class="group-title" style="cursor:pointer" id="toggleDone">${icon('checkCircle', 13)} ${tf('已完成（{0}）', doneList.length)}${icon('chevronR', 12)}</div><div id="doneList" style="display:none">${doneList.map(cardHTML).join('')}</div>`;
  const cancelList = visible.filter(e => e.status === 'cancelled');
  if (cancelList.length) html += `<div class="group-title">${icon('xCircle', 13)} ${tf('已取消（{0}）', cancelList.length)}</div>` + cancelList.map(cardHTML).join('');

  host.innerHTML = html || `<div class="empty">${dayFilter ? t('这一天没有安排') : t('还没有日程。说一句话试试：「明天晚上18点我要跟女朋友约会」')}</div>`;

  // 事件委托：编辑/完成/删除/补报
  host.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = btn.closest('[data-id]').dataset.id;
    const ev = events.find(x => x.id === id);
    const act = btn.dataset.act;
    if (act === 'edit') openConfirmCard(ev, { onSave: true });
    if (act === 'done') { await dp.scheduleDone(id); toast(t('已完成'), 'ok'); refresh(); }
    if (act === 'del') {
      if (await confirmBox(tf('删除日程「{0}」？', ev.title), { danger: true, okText: t('删除') })) {
        await dp.scheduleDelete(id); refresh();
      }
    }
  }));
  const td = host.querySelector('#toggleDone');
  if (td) td.addEventListener('click', () => {
    const l = host.querySelector('#doneList');
    const show = l.style.display === 'none';
    l.style.display = show ? '' : 'none';
    td.textContent = td.textContent.replace(/[▸▾]/, show ? '▾' : '▸');
  });
}

function cardHTML(e) {
  const timeText = [e.start ? fmt(e.start) : null, e.deadline ? tf('截止 {0}', fmt(e.deadline)) : null].filter(Boolean).join(' · ') || t('无具体时间');
  const srcMap = { nl: t('一句话'), chat: t('聊天'), excel: 'Excel', manual: t('手动') };
  const repeatMap = { daily: t('每天'), weekdays: t('工作日'), weekly: t('每周') };
  return `<div class="ev-card card ${e.status === 'done' ? 'done' : ''}" data-id="${e.id}">
    <div class="l1">
      <span class="badge ${e.kind}">${e.kind === 'task' ? icon('bolt', 11) + t('任务') : icon('calendar', 11) + t('事件')}</span>
      ${e.repeat && e.repeat !== 'none' ? `<span class="badge repeat">${icon('refresh', 11)}${repeatMap[e.repeat] || e.repeat}</span>` : ''}
      <span class="ev-title">${esc(e.title)}</span>
      ${e.status === 'pending' ? `
      <button class="btn btn-sm" data-act="edit">${t('编辑')}</button>
      <button class="btn btn-sm" data-act="done">${t('完成')}</button>
      <button class="btn btn-sm btn-icon" data-act="del" title="${t('删除')}">${icon('trash', 15)}</button>` : ''}
    </div>
    <div class="l2">
      <span>${timeText}${e.durationMin ? tf(' · {0}分钟', e.durationMin) : ''}</span>
      ${(e.reminders || []).map(r => `<span class="rem-chip ${r.status}" title="${fmt(r.at)}">${esc(r.label)}·${fmt(r.at)}</span>`).join('')}
      ${e.source ? `<span class="badge">${srcMap[e.source] || e.source}</span>` : ''}
      ${e.notes ? `<span>${icon('pencil', 11)} ${esc(e.notes)}</span>` : ''}
    </div>
  </div>`;
}

// ================= 补报红条 =================
let catchupItems = [];
dp.on('schedule:catchup', ({ items }) => {
  catchupItems = items;
  renderCatchup();
});
function renderCatchup() {
  const host = root.querySelector('#catchupHost');
  if (!catchupItems.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="catchup-bar" id="cuBar">⏰ ${tf('有 {0} 条错过的提醒：', catchupItems.length)}${catchupItems.slice(0, 3).map(i => `「${esc(i.title)}」`).join(' ')}${catchupItems.length > 3 ? t(' 等') : ''} — ${t('点击查看')}</div>`;
  host.querySelector('#cuBar').addEventListener('click', () => {
    const m = openModal({ title: t('错过的提醒') });
    m.body.innerHTML = catchupItems.map(i => `
      <div class="list-item"><b>${esc(i.title)}</b><div class="small muted">${esc(i.label)} · ${tf('应于 {0} 提醒', fmt(i.at))}</div></div>`).join('');
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    foot.innerHTML = `<button class="btn" id="cu-clear">${t('知道了，清除')}</button>`;
    foot.querySelector('#cu-clear').addEventListener('click', () => { catchupItems = []; renderCatchup(); m.close(); });
    m.el.appendChild(foot);
  });
}

// ================= 事件订阅 =================
dp.on('schedule:changed', () => refresh());
dp.on('schedule:remind', () => refresh());
dp.on('schedule:prefill', ({ text }) => {
  const input = root.querySelector('#qaInput');
  input.value = text || '';
  quickAdd(text);
});

// ================= 工具栏 =================
root.querySelector('#qaAdd').addEventListener('click', () => quickAdd(root.querySelector('#qaInput').value));
root.querySelector('#qaInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') quickAdd(e.target.value); });
root.querySelector('#formAdd').addEventListener('click', () => openConfirmCard({ kind: 'event', remindPreset: 'event', start: null, deadline: null }));
root.querySelector('#xlAdd').addEventListener('click', importExcel);

// ================= 启动 =================
(async function boot() {
  await initTheme();
  await refresh();
})();
