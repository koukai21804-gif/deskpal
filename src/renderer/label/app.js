// 未知应用标注小窗：列出当天未知应用（名称/标题/时长）→ 选择类别（含自定义）
import { dp, initTheme, esc, errText, fmtMin } from '../common/ipc.js';
import { toast } from '../common/ui.js';
import { mountTitlebar } from '../common/windows/titlebar.js';

const app = document.getElementById('app');
app.appendChild(mountTitlebar('deskpal · 标注应用'));

const root = document.createElement('div');
root.style.cssText = 'flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px';
app.appendChild(root);

async function load() {
  let unknown;
  try { unknown = await dp.timeUnknownApps(); }
  catch (err) { root.innerHTML = `<div class="empty">${esc(errText(err))}</div>`; return; }

  if (!unknown.length) {
    root.innerHTML = `<div class="empty">今天没有需要标注的应用啦～<br>（宠物只在你空闲回来后问一次）</div>`;
    return;
  }

  root.innerHTML = `<div class="hint" style="margin-bottom:2px">这些应用我还看不懂是干什么的，帮它们选个类型吧：</div>`;
  const customs = (await dp.storeGet('categories')).categories || ['工作', '学习', '娱乐', '社交', '其他'];
  const rows = [];

  for (const u of unknown) {
    const card = document.createElement('div');
    card.className = 'list-item';
    card.innerHTML = `
      <div class="row" style="margin-bottom:6px">
        <b>${esc(u.app)}</b>
        <span class="small muted">今天用了 ${fmtMin(u.min)}</span>
        <span class="grow"></span>
        <select style="min-width:110px">
          ${customs.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
          <option value="__custom__">✏️ 自定义…</option>
        </select>
      </div>
      ${u.titles && u.titles.length ? `<div class="small muted" style="line-height:1.5">窗口标题例：${esc(u.titles[0])}</div>` : ''}
      <input type="text" placeholder="自定义类别名" style="display:none;margin-top:6px">`;
    const sel = card.querySelector('select');
    const customInput = card.querySelector('input');
    sel.addEventListener('change', () => { customInput.style.display = sel.value === '__custom__' ? '' : 'none'; });
    root.appendChild(card);
    rows.push({ app: u.app, sel, customInput });
  }

  const btnBar = document.createElement('div');
  btnBar.className = 'row';
  btnBar.innerHTML = `<span class="grow"></span><button class="btn btn-primary" id="saveBtn">保存标注</button>`;
  root.appendChild(btnBar);

  btnBar.querySelector('#saveBtn').addEventListener('click', async () => {
    const labels = [];
    for (const r of rows) {
      let cat = r.sel.value;
      if (cat === '__custom__') {
        cat = r.customInput.value.trim();
        if (!cat) { toast('自定义类别不能为空（' + r.app + '）', 'warn'); return; }
      }
      labels.push({ app: r.app, category: cat });
    }
    try {
      await dp.timeLabelSave(labels);
      toast(`已保存 ${labels.length} 条标注，统计已更新`, 'ok');
      setTimeout(() => window.close(), 600);
    } catch (err) { toast(errText(err), 'error'); }
  });
}

(async function boot() {
  await initTheme();
  await load();
})();
