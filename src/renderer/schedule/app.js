// 日程页：一句话速添 / 表单添加 / Excel 导入 / 7天条 / 分组列表 / 补报红条
import { dp, initTheme, esc, errText } from '../common/ipc.js';
import { openModal, toast, confirmBox } from '../common/ui.js';
import { mountTitlebar } from '../common/windows/titlebar.js';

const app = document.getElementById('app');
app.appendChild(mountTitlebar('deskpal · 日程'));

const root = document.createElement('div');
root.className = 'sch-wrap';
root.innerHTML = `
  <div class="sch-body">
    <div>
      <div class="quick-add">
        <input type="text" id="qaInput" placeholder="试试：明天晚上18点我要跟女朋友约会">
        <button class="btn btn-primary" id="qaAdd">➕ 添加</button>
        <button class="btn" id="formAdd">📋 表单添加</button>
        <button class="btn" id="xlAdd">📄 导入 Excel</button>
      </div>
      <div class="hint qa-tip" id="qaTip">说一句话就行：我会解析出时间并按类型自动设好提醒（事件提前 60 分钟、任务截止提前 120 分钟，可在设置调整）</div>
    </div>
    <div id="catchupHost"></div>
    <div class="week-strip" id="weekStrip"></div>
    <div id="listHost"></div>
  </div>`;
app.appendChild(root);

let events = [];
let dayFilter = null; // 'YYYY-MM-DD' | null

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
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
  return `${x.getMonth() + 1}月${x.getDate()}日 ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
}
function ymd(d) {
  const x = dayjs(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// ================= 速添 =================
async function quickAdd(text) {
  text = String(text || '').trim();
  if (!text) return;
  root.querySelector('#qaTip').textContent = '正在解析…';
  root.querySelector('#qaTip').style.color = 'var(--dp-text-muted)';
  try {
    const r = await dp.scheduleParse(text);
    if (r.understood && r.draft) {
      openConfirmCard(r.draft, { fromParse: true });
      root.querySelector('#qaTip').textContent = '解析成功，确认一下就入库～';
    } else if (r.question) {
      const tip = root.querySelector('#qaTip');
      tip.textContent = '🤔 ' + r.question;
      tip.style.color = 'var(--dp-warn)';
    } else {
      toast('这句话像是在安排日程吗？试试「明天下午3点开会」这样的说法', 'warn');
    }
  } catch (err) {
    toast(errText(err) + '（也可以用「表单添加」手动录入）', 'error', 4000);
  }
}

// ================= 确认卡（速添/表单/编辑共用） =================
function openConfirmCard(ev, { fromParse = false, onSave } = {}) {
  const m = openModal({ title: onSave ? '编辑日程' : (fromParse ? '确认日程' : '添加日程'), width: '560px' });
  const kind = ev.kind || 'event';
  const dtLocal = (iso) => {
    if (!iso) return '';
    const d = dayjs(iso);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  m.body.innerHTML = `
    <div class="ev-form">
      <div class="field full"><span class="label">标题</span><input type="text" id="f-title" value="${esc(ev.title || '')}" maxlength="30"></div>
      <div class="field"><span class="label">类型</span>
        <select id="f-kind">
          <option value="event" ${kind === 'event' ? 'selected' : ''}>📅 事件（约会/会议/外出）</option>
          <option value="task" ${kind === 'task' ? 'selected' : ''}>⚡ 任务（有开始/截止的工作）</option>
        </select></div>
      <div class="field"><span class="label">提醒预设</span>
        <select id="f-preset">
          <option value="event" ${ev.remindPreset === 'event' ? 'selected' : ''}>事件：提前60分钟 + 开始时</option>
          <option value="start" ${ev.remindPreset === 'start' ? 'selected' : ''}>任务开始：提前5分钟 + 开始时</option>
          <option value="deadline" ${ev.remindPreset === 'deadline' ? 'selected' : ''}>截止：提前120分钟 + 截止时</option>
          <option value="none" ${ev.remindPreset === 'none' ? 'selected' : ''}>不提醒</option>
        </select></div>
      <div class="field"><span class="label">开始时间</span><input type="datetime-local" id="f-start" value="${dtLocal(ev.start)}"></div>
      <div class="field"><span class="label">时长（分钟，可空）</span><input type="number" id="f-dur" min="5" max="1440" value="${ev.durationMin || ''}"></div>
      <div class="field"><span class="label">截止时间（任务可空）</span><input type="datetime-local" id="f-deadline" value="${dtLocal(ev.deadline)}"></div>
      <div class="field"><span class="label">备注</span><input type="text" id="f-notes" value="${esc(ev.notes || '')}" maxlength="100"></div>
    </div>
    <div class="hint" id="f-hint"></div>`;
  const foot = document.createElement('div');
  foot.className = 'modal-foot';
  foot.innerHTML = `<button class="btn" id="f-cancel">取消</button><button class="btn btn-primary" id="f-save">保存</button>`;
  m.el.appendChild(foot);

  const readForm = () => ({
    id: ev.id,
    kind: m.body.querySelector('#f-kind').value,
    title: m.body.querySelector('#f-title').value.trim() || '未命名日程',
    start: m.body.querySelector('#f-start').value ? m.body.querySelector('#f-start').value.replace('T', ' ') : null,
    durationMin: +m.body.querySelector('#f-dur').value || null,
    deadline: m.body.querySelector('#f-deadline').value ? m.body.querySelector('#f-deadline').value.replace('T', ' ') : null,
    remindPreset: m.body.querySelector('#f-preset').value,
    notes: m.body.querySelector('#f-notes').value.trim(),
  });

  foot.querySelector('#f-cancel').addEventListener('click', () => m.close());
  foot.querySelector('#f-save').addEventListener('click', async () => {
    const draft = readForm();
    if (!draft.start && !draft.deadline) return toast('开始时间和截止时间至少填一个', 'warn');
    try {
      if (onSave) await dp.scheduleUpdate({ ...draft, ...{ id: ev.id } });
      else await dp.scheduleAdd({ ...draft, source: ev.source || 'manual' });
      toast(onSave ? '已更新' : '已加入日程，到点我会提醒你～', 'ok');
      m.close();
      refresh();
    } catch (err) { toast(errText(err), 'error'); }
  });
}

// ================= Excel 导入 =================
async function importExcel() {
  const p = await dp.pickFile({ title: '选择项目管理的 Excel 表', filters: [{ name: 'Excel', extensions: ['xlsx', 'xlsm'] }] });
  if (!p) return;
  toast('读取表格中…');
  try {
    const sheet = await dp.scheduleExcelParse(p);
    toast('AI 拆解任务中…');
    const { tasks } = await (async () => {
      // 复用主进程 decompose：schedule:excel-parse 只读表，这里再走一次带 rows 的解析
      return await dp.scheduleExcelDecompose(sheet);
    })();
    if (!tasks.length) return toast('这份表里没有识别出可安排的任务（或缺少时间信息）', 'warn', 4000);
    openExcelPreview(sheet, tasks);
  } catch (err) { toast(errText(err), 'error', 4000); }
}

function openExcelPreview(sheet, tasks) {
  const m = openModal({ title: `预览并导入任务（识别出 ${tasks.length} 条）`, width: '760px' });
  const rows = tasks.map(t => ({ ...t, on: !!t.valid }));
  m.body.innerHTML = `
    <div class="hint" style="margin-bottom:8px">来源表：${esc(sheet.sheetNames.join(' / '))} · 可编辑每行内容，取消勾选则跳过；解析失败的行已自动标灰</div>
    <div style="max-height:46vh;overflow:auto">
      <table class="xl-table">
        <thead><tr><th style="width:34px"></th><th>任务</th><th>开始时间</th><th>截止时间</th><th>提醒</th><th>说明</th></tr></thead>
        <tbody>
        ${rows.map((t, i) => `
          <tr class="${t.on ? '' : 'off'}" data-i="${i}">
            <td><input type="checkbox" data-f="on" ${t.on ? 'checked' : ''}></td>
            <td><input type="text" data-f="title" value="${esc(t.title)}" ${t.valid ? '' : 'disabled'}></td>
            <td><input type="text" data-f="start" value="${t.start ? fmt(t.start) : ''}" placeholder="YYYY-MM-DD HH:mm"></td>
            <td><input type="text" data-f="deadline" value="${t.deadline ? fmt(t.deadline) : ''}" placeholder="YYYY-MM-DD HH:mm"></td>
            <td><select data-f="remindPreset">
              <option value="deadline" ${t.remindPreset === 'deadline' ? 'selected' : ''}>截止前120分钟</option>
              <option value="start" ${t.remindPreset === 'start' ? 'selected' : ''}>开始前5分钟</option>
              <option value="none" ${t.remindPreset === 'none' ? 'selected' : ''}>不提醒</option>
            </select></td>
            <td><input type="text" data-f="notes" value="${esc(t.notes)}"></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  const foot = document.createElement('div');
  foot.className = 'modal-foot';
  foot.innerHTML = `<span class="hint" id="xl-count"></span><button class="btn" id="xl-cancel">取消</button><button class="btn btn-primary" id="xl-import">导入</button>`;
  m.el.appendChild(foot);

  const updateCount = () => { foot.querySelector('#xl-count').textContent = `将导入 ${m.body.querySelectorAll('input[data-f=on]:checked').length} 条`; };
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
    if (!out.length) return toast('没有勾选任何任务', 'warn');
    try {
      const { imported } = await dp.scheduleExcelImport(out);
      toast(`已导入 ${imported} 条任务`, 'ok');
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
    return `<div class="day-chip ${dayFilter === key ? 'active' : ''}" data-day="${key}">
      <div>${i === 0 ? '今天' : i === 1 ? '明天' : '周' + WEEK_CN[d.getDay()]}</div>
      <div class="d-num">${d.getDate()}</div>
      <div class="d-dot">${n ? `<div style="width:${Math.min(34, 6 + n * 8)}px"></div>` : ''}</div>
    </div>`;
  }).join('');
  host.querySelectorAll('.day-chip').forEach(c => c.addEventListener('click', () => {
    dayFilter = dayFilter === c.dataset.day ? null : c.dataset.day;
    renderWeekStrip(); renderList();
  }));
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
    { name: '今天', match: e => [e.start, e.deadline].some(x => x && ymd(x) === todayKey) },
    { name: '明天', match: e => [e.start, e.deadline].some(x => x && ymd(x) === tomorrowKey) },
    { name: '本周', match: e => [e.start, e.deadline].some(x => x && new Date(x) <= weekEnd && new Date(x) > tomorrow) },
    { name: '更晚', match: e => [e.start, e.deadline].some(x => x && new Date(x) > weekEnd) },
  ];

  let html = '';
  let used = new Set();
  for (const g of groups) {
    const items = active.filter(e => !used.has(e.id) && g.match(e));
    if (!items.length) continue;
    items.forEach(e => used.add(e.id));
    html += `<div class="group-title">🗓 ${g.name}（${items.length}）</div>` + items.map(cardHTML).join('');
  }
  const rest = active.filter(e => !used.has(e.id));
  if (rest.length) html += `<div class="group-title">🗓 无具体时间</div>` + rest.map(cardHTML).join('');

  const doneList = visible.filter(e => e.status === 'done');
  if (doneList.length) html += `<div class="group-title" style="cursor:pointer" id="toggleDone">✅ 已完成（${doneList.length}）▸</div><div id="doneList" style="display:none">${doneList.map(cardHTML).join('')}</div>`;
  const cancelList = visible.filter(e => e.status === 'cancelled');
  if (cancelList.length) html += `<div class="group-title">🚫 已取消（${cancelList.length}）</div>` + cancelList.map(cardHTML).join('');

  host.innerHTML = html || `<div class="empty">${dayFilter ? '这一天没有安排' : '还没有日程。说一句话试试：「明天晚上18点我要跟女朋友约会」'}</div>`;

  // 事件委托：编辑/完成/删除/补报
  host.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = btn.closest('[data-id]').dataset.id;
    const ev = events.find(x => x.id === id);
    const act = btn.dataset.act;
    if (act === 'edit') openConfirmCard(ev, { onSave: true });
    if (act === 'done') { await dp.scheduleDone(id); toast('已完成 ✓', 'ok'); refresh(); }
    if (act === 'del') {
      if (await confirmBox(`删除日程「${ev.title}」？`, { danger: true, okText: '删除' })) {
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
  const timeText = [e.start ? fmt(e.start) : null, e.deadline ? `截止 ${fmt(e.deadline)}` : null].filter(Boolean).join(' · ') || '无具体时间';
  const srcMap = { nl: '一句话', chat: '聊天', excel: 'Excel', manual: '手动' };
  return `<div class="ev-card card ${e.status === 'done' ? 'done' : ''}" data-id="${e.id}">
    <div class="l1">
      <span class="badge ${e.kind}">${e.kind === 'task' ? '⚡任务' : '📅事件'}</span>
      <span class="ev-title">${esc(e.title)}</span>
      ${e.status === 'pending' ? `
      <button class="btn btn-sm" data-act="edit">编辑</button>
      <button class="btn btn-sm" data-act="done">完成</button>
      <button class="btn btn-sm btn-icon" data-act="del">🗑</button>` : ''}
    </div>
    <div class="l2">
      <span>${timeText}${e.durationMin ? ` · ${e.durationMin}分钟` : ''}</span>
      ${(e.reminders || []).map(r => `<span class="rem-chip ${r.status}" title="${fmt(r.at)}">${esc(r.label)}·${fmt(r.at)}</span>`).join('')}
      ${e.source ? `<span class="badge">${srcMap[e.source] || e.source}</span>` : ''}
      ${e.notes ? `<span>📝 ${esc(e.notes)}</span>` : ''}
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
  host.innerHTML = `<div class="catchup-bar" id="cuBar">⏰ 有 ${catchupItems.length} 条错过的提醒：${catchupItems.slice(0, 3).map(i => `「${esc(i.title)}」`).join(' ')}${catchupItems.length > 3 ? ' 等' : ''} — 点击查看</div>`;
  host.querySelector('#cuBar').addEventListener('click', () => {
    const m = openModal({ title: '错过的提醒' });
    m.body.innerHTML = catchupItems.map(i => `
      <div class="list-item"><b>${esc(i.title)}</b><div class="small muted">${esc(i.label)} · 应于 ${fmt(i.at)} 提醒</div></div>`).join('');
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    foot.innerHTML = `<button class="btn" id="cu-clear">知道了，清除</button>`;
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
