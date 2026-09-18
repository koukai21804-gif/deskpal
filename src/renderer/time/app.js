// 时间统计页：今日/本周、应用/类别排行、24h 分布、未知应用标注入口、AI 报告
import { dp, initTheme, esc, errText, fmtMin } from '../common/ipc.js';
import { renderMD } from '../common/md.js';
import { toast } from '../common/ui.js';
import { mountTitlebar } from '../common/windows/titlebar.js';

const app = document.getElementById('app');
app.appendChild(mountTitlebar('deskpal · 时间统计'));

const root = document.createElement('div');
root.className = 'time-wrap';
root.innerHTML = `
  <div class="time-toolbar">
    <div class="tabs" style="border:0;padding:0;background:transparent">
      <div class="tab active" data-r="today">今日</div>
      <div class="tab" data-r="week">本周</div>
    </div>
    <span class="grow"></span>
    <button class="btn btn-sm" id="labelBtn">🏷 标注未知应用</button>
    <button class="btn btn-sm" id="pauseBtn"></button>
    <button class="btn btn-sm btn-primary" id="reportBtn">🤖 AI 时间报告</button>
  </div>
  <div class="time-body" id="body"></div>`;
app.appendChild(root);

const body = root.querySelector('#body');
let range = 'today';
let reportStreaming = null;

// ---------- 数据加载 ----------
async function refresh() {
  const s = await dp.timeStats(range);
  const paused = (await dp.timePaused()).paused;
  root.querySelector('#pauseBtn').textContent = paused ? '▶ 恢复监测' : '⏸ 暂停监测';

  const catTotal = s.categories.reduce((a, c) => a + c.min, 0);
  body.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card card"><div class="num">${fmtMin(s.totalMin)}</div><div class="lbl">${range === 'today' ? '今日' : '本周'}电脑使用</div></div>
      <div class="stat-card card"><div class="num">${s.categories[0] ? s.categories[0].name : '—'}</div><div class="lbl">最常用类别 ${s.categories[0] ? s.categories[0].pct + '%' : ''}</div></div>
      <div class="stat-card card"><div class="num">${s.apps.length}</div><div class="lbl">使用过的应用</div></div>
      <div class="stat-card card"><div class="num">${fmtMin(s.afkMin)}</div><div class="lbl">离开时间（空闲）</div></div>
    </div>

    ${s.unknownCount ? `
    <div class="unknown-bar">
      <span>🏷 有 <b>${s.unknownCount}</b> 个应用还不知道是什么类型，标注后统计更准确</span>
      <span class="grow"></span>
      <button class="btn btn-sm btn-primary" id="labelNow">去标注</button>
    </div>` : ''}

    <div class="card">
      <div style="font-weight:600;margin-bottom:8px">⏰ 24 小时分布</div>
      <div class="hour-chart">
        ${s.hours.map((m, h) => `
          <div class="bar-col" title="${h}:00 · ${m} 分钟">
            <div class="bar" style="height:${Math.max(2, (m / Math.max(...s.hours, 1)) * 88)}px"></div>
            <div class="bar-label">${h % 3 === 0 ? h : ''}</div>
          </div>`).join('')}
      </div>
    </div>

    <div class="card">
      <div style="font-weight:600;margin-bottom:6px">📊 类别占比（共 ${fmtMin(catTotal)}）</div>
      ${s.categories.length ? s.categories.map(c => `
        <div class="rank-row">
          <span class="cat-chip">${esc(c.name)}</span>
          <div class="bar-wrap"><div style="width:${Math.max(3, c.pct)}%"></div></div>
          <span class="small" style="width:150px;text-align:right">${fmtMin(c.min)} · ${c.pct}%</span>
        </div>`).join('') : '<div class="empty">还没有分类数据（先标注未知应用吧）</div>'}
    </div>

    <div class="card">
      <div style="font-weight:600;margin-bottom:6px">📱 应用排行</div>
      ${s.apps.length ? s.apps.slice(0, 15).map(a => `
        <div class="rank-row" title="${esc(a.topTitle || '')}">
          <span class="app-name">${esc(a.app)} ${a.category ? `<span class="cat-chip">${esc(a.category)}</span>` : '<span class="cat-chip" style="color:var(--dp-warn)">未标注</span>'}</span>
          <div class="bar-wrap"><div style="width:${Math.max(3, a.pct)}%"></div></div>
          <span class="small" style="width:150px;text-align:right">${fmtMin(a.min)} · ${a.pct}%</span>
        </div>`).join('') : '<div class="empty">今天还没有使用记录</div>'}
    </div>

    <div class="report-view" id="reportView" style="display:none">
      <div class="row" style="margin-bottom:8px"><b>🤖 AI 时间报告</b><span class="grow"></span><button class="btn btn-sm" id="reportStop">停止</button></div>
      <div class="report-md md" id="reportMd"></div>
    </div>`;

  const labelBtn2 = body.querySelector('#labelNow');
  if (labelBtn2) labelBtn2.addEventListener('click', () => dp.timeOpenLabel());
  const stopBtn = body.querySelector('#reportStop');
  if (stopBtn) stopBtn.addEventListener('click', () => { if (reportStreaming) dp.timeReportStop(reportStreaming); });
}

// ---------- 工具栏 ----------
root.querySelectorAll('.tab[data-r]').forEach(t => t.addEventListener('click', () => {
  range = t.dataset.r;
  root.querySelectorAll('.tab[data-r]').forEach(x => x.classList.toggle('active', x.dataset.r === range));
  refresh().catch(err => toast(errText(err), 'error'));
}));

root.querySelector('#labelBtn').addEventListener('click', () => dp.timeOpenLabel());
root.querySelector('#pauseBtn').addEventListener('click', async () => {
  const paused = (await dp.timePaused()).paused;
  await dp.timeSetPaused(!paused);
  toast(paused ? '已恢复时间监测' : '已暂停时间监测', 'ok');
  refresh().catch(() => {});
});
root.querySelector('#reportBtn').addEventListener('click', async () => {
  try {
    const { reqId } = await dp.timeReport(range);
    reportStreaming = reqId;
    const view = body.querySelector('#reportView');
    const md = body.querySelector('#reportMd');
    view.style.display = '';
    md.innerHTML = '<span class="streaming-cursor"></span>';
    view.scrollIntoView({ behavior: 'smooth' });
  } catch (err) { toast(errText(err), 'error'); }
});

// ---------- 报告流式 ----------
dp.on('report:chunk', ({ reqId, delta }) => {
  if (reqId !== reportStreaming) return;
  const md = body.querySelector('#reportMd');
  if (!md) return;
  md.dataset.raw = (md.dataset.raw || '') + delta;
  md.innerHTML = renderMD(md.dataset.raw) + '<span class="streaming-cursor"></span>';
  md.scrollTop = md.scrollHeight;
});
dp.on('report:done', ({ reqId, ok, markdown, error }) => {
  if (reqId !== reportStreaming) return;
  const md = body.querySelector('#reportMd');
  if (md) md.innerHTML = ok ? renderMD(markdown) : `<span style="color:var(--dp-danger)">${esc(error)}</span>`;
  reportStreaming = null;
});

// 数据变化（标注保存 / 时间推移）→ 刷新
dp.on('time:changed', () => refresh().catch(() => {}));

(async function boot() {
  await initTheme();
  await refresh();
  setInterval(() => refresh().catch(() => {}), 60 * 1000);
})();
