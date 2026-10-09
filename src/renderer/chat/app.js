// 聊天窗：角色扮演 / 快问两标签、流式渲染、停止/重生成、日程确认条、启动器本地匹配
// ★v0.3：节拍按句触发宠物表情、agent 步骤时间线、写权限卡、diff 卡、中断任务提示条
import { dp, initTheme, esc, errText, uid } from '../common/ipc.js';
import { renderMD } from '../common/md.js';
import { toast, confirmBox, openModal } from '../common/ui.js';
import { mountTitlebar } from '../common/windows/titlebar.js';

const EMO_LABEL = { normal: '平常', happy: '开心', surprised: '惊讶', angry: '愤怒', thinking: '思考', sad: '悲伤' };
const SCHEDULE_RE = /^(提醒我|帮我记一下|记一下|添加日程|加个日程)/;
// 斜杠命令：长期记忆管理面板（与主进程 memory.js 同款；角色无感知）
const MEMORY_CMD_RE = /^\s*\/\s*deep\s+memory\s+forcing\s*$/i;
// 斜杠命令：用户身份档案面板 / 搜索账本面板 / 记忆整理纪律查看（开发版；与主进程同款正则，角色无感知）
const PROFILE_CMD_RE = /^\s*\/\s*user\s+profile\s*$/i;
const SEARCH_CMD_RE = /^\s*\/\s*search\s+ledger\s*$/i;
const DISCIPLINE_CMD_RE = /^\s*\/\s*discipline\s*$/i;

let tab = 'roleplay';
let streaming = null;           // { tab, el, raw, steps, changes, permTimers, sessionId }
let histories = { roleplay: [], quick: [] };
let sessionInfo = { activeSessionId: '', sessions: [] }; // v0.5 多会话（仅 roleplay）

const app = document.getElementById('app');
app.appendChild(mountTitlebar('deskpal · 聊天'));

const tabsEl = document.createElement('div');
tabsEl.className = 'tabs';
tabsEl.innerHTML = `
  <div class="tab active" data-tab="roleplay">💬 角色扮演</div>
  <div class="tab" data-tab="quick">⚡ 快问</div>
  <div class="grow"></div>
  <div class="tab" data-act="export" title="导出当前会话为 Markdown">📤 导出</div>
  <div class="tab" data-act="clear" title="清空当前会话">🧹 清空</div>`;
app.appendChild(tabsEl);

// 会话栏（v0.5）：主对话=日常角色扮演常驻；＋ 可开任意数量的专项会话（特定任务/场景扮演）。
// 切换时主进程先把旧会话的未提取记忆固化入库，再落新 active——跨会话不丢长期信息。
const sessionBar = document.createElement('div');
sessionBar.className = 'session-bar';
sessionBar.innerHTML = `
  <span class="session-label">会话</span>
  <select id="sessionSel" class="session-select" title="切换会话（切换前会自动固化未提取的记忆）"></select>
  <button class="btn btn-sm" id="sessionNewBtn" title="新建专项会话（特定任务/场景，与主对话互不干扰）">＋ 专项会话</button>
  <button class="btn btn-sm" id="sessionEditBtn" title="重命名 / 设置本会话主题">✏️</button>
  <button class="btn btn-sm" id="sessionDelBtn" title="删除当前专项会话（主对话不可删）">🗑</button>`;
app.appendChild(sessionBar);

const main = document.createElement('div');
main.className = 'chat-wrap';
main.innerHTML = `
  <div class="interrupt-slot" id="interruptSlot"></div>
  <div class="msg-list" id="list"></div>
  <div class="chat-input">
    <textarea id="input" placeholder="和宠物聊天…（"打开xx"可直接启动程序；"提醒我明天9点开会"直达日程）" rows="1"></textarea>
    <div class="input-row">
      <select id="permMode" class="perm-select" title="宠物文件权限（对下一次任务生效）：
🔒 只读：只能读取和列目录，不能写文件
📝 可编辑：可写应用数据目录（deskpal 文件夹）及其子目录
⚠️ 完全编辑：可读写本机大部分目录（核心系统目录除外），每次写入需在权限卡批准">
        <option value="read">🔒 只读</option>
        <option value="userData">📝 可编辑</option>
        <option value="full">⚠️ 完全编辑</option>
      </select>
      <span class="model-tag" id="modelTag"></span>
      <button class="btn btn-sm" id="stopBtn" style="display:none">⏹ 停止</button>
      <button class="btn btn-sm btn-primary" id="sendBtn">发送</button>
    </div>
  </div>`;
app.appendChild(main);

const list = main.querySelector('#list');
const input = main.querySelector('#input');
const sendBtn = main.querySelector('#sendBtn');
const stopBtn = main.querySelector('#stopBtn');
const permModeSel = main.querySelector('#permMode');

// ---------- 权限模式选择（三档：只读/可编辑/完全编辑，对下一次任务生效） ----------
permModeSel.addEventListener('change', async () => {
  const v = permModeSel.value;
  try {
    await dp.storeSet('settings', { agent: { permissionMode: v } });
    const label = { read: '只读', userData: '可编辑（数据目录内）', full: '完全编辑（大部分目录，逐次批准）' }[v];
    toast(`权限已切换：${label}（下一次任务生效）`, 'ok');
  } catch (err) { toast(errText(err), 'error'); }
});

// ---------- 标签切换 ----------
tabsEl.addEventListener('click', async (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  if (t.dataset.act === 'export') return doExport();
  if (t.dataset.act === 'clear') return doClear();
  tab = t.dataset.tab;
  tabsEl.querySelectorAll('.tab[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  sessionBar.style.display = tab === 'roleplay' ? '' : 'none';
  input.placeholder = tab === 'quick'
    ? '快问快答：直接问，我简洁回答（可以问知识、代码、命令…）'
    : '和宠物聊天…（"打开xx"可直接启动程序；"提醒我明天9点开会"直达日程）';
  renderAll();
});

// ---------- 会话栏 ----------
function renderSessions() {
  const sel = sessionBar.querySelector('#sessionSel');
  sel.innerHTML = sessionInfo.sessions.map(s => {
    const tag = s.kind === 'main' ? '主' : '专';
    return `<option value="${esc(s.id)}" ${s.id === sessionInfo.activeSessionId ? 'selected' : ''}>${tag}｜${esc(s.name)}（${s.msgCount} 条）</option>`;
  }).join('');
  const cur = sessionInfo.sessions.find(s => s.id === sessionInfo.activeSessionId);
  sessionBar.querySelector('#sessionDelBtn').style.display = cur && cur.kind === 'main' ? 'none' : '';
}

async function refreshSessions() {
  try { sessionInfo = await dp.chatSessions(); renderSessions(); } catch (_) {}
}

async function reloadRoleplay() {
  histories.roleplay = await dp.chatHistory('roleplay');
  await refreshSessions();
  renderAll();
}

sessionBar.querySelector('#sessionSel').addEventListener('change', async (e) => {
  if (streaming && streaming.tab === 'roleplay') {
    toast('正在生成中，等这轮结束再切换会话', 'warn');
    renderSessions(); // 还原下拉
    return;
  }
  try {
    await dp.chatSessionSwitch(e.target.value);
    await reloadRoleplay();
    const cur = sessionInfo.sessions.find(s => s.id === sessionInfo.activeSessionId);
    toast(`已切换到「${cur ? cur.name : ''}」（切换前已固化未提取的记忆）`, 'ok');
  } catch (err) { toast(errText(err), 'error'); renderSessions(); }
});

sessionBar.querySelector('#sessionNewBtn').addEventListener('click', () => {
  if (streaming && streaming.tab === 'roleplay') return toast('正在生成中，稍后再新建', 'warn');
  openSessionModal('new');
});
sessionBar.querySelector('#sessionEditBtn').addEventListener('click', () => {
  const cur = sessionInfo.sessions.find(s => s.id === sessionInfo.activeSessionId);
  if (cur) openSessionModal('edit', cur);
});
sessionBar.querySelector('#sessionDelBtn').addEventListener('click', async () => {
  const cur = sessionInfo.sessions.find(s => s.id === sessionInfo.activeSessionId);
  if (!cur || cur.kind === 'main') return;
  if (!(await confirmBox(`删除专项会话「${cur.name}」？其中未提取记忆的对话内容将一并丢弃（已入长期记忆的不受影响）。`, { danger: true, okText: '删除' }))) return;
  try {
    await dp.chatSessionDelete(cur.id);
    await reloadRoleplay();
    toast('已删除（活跃会话回到主对话）', 'ok');
  } catch (err) { toast(errText(err), 'error'); }
});

// 新建/编辑会话弹窗：名称 + 一句话主题（主题会注入角色上下文的【当前会话】卡）
function openSessionModal(mode, cur = null) {
  const { body, close } = openModal({ title: mode === 'new' ? '＋ 新建专项会话' : '✏️ 会话设置', width: '460px' });
  body.innerHTML = `
    <p class="hint" style="margin:2px 0 10px">专项会话与主对话互不共享聊天记录——适合具体任务（如「整理游戏卡牌数据」）或专项场景扮演。长期记忆与身份档案仍然共用；跨会话想用的信息让宠物「记住」即可。</p>
    <div class="field"><span class="label">会话名称</span>
      <input type="text" id="ss-name" maxlength="24" placeholder="如：游戏数据整理 / 深夜电台扮演" value="${esc(cur ? cur.name : '')}"></div>
    <div class="field"><span class="label">主题（一句话，可选；会注入角色上下文）</span>
      <input type="text" id="ss-goal" maxlength="120" placeholder="如：整理角色立绘的命名规范" value="${esc(cur ? cur.goal : '')}"></div>
    <div class="row" style="margin-top:12px;justify-content:flex-end">
      <button class="btn btn-sm" data-a="cancel">取消</button>
      <button class="btn btn-sm btn-primary" data-a="ok">${mode === 'new' ? '创建并切换' : '保存'}</button>
    </div>`;
  body.querySelector('[data-a=cancel]').addEventListener('click', () => close());
  body.querySelector('[data-a=ok]').addEventListener('click', async () => {
    const name = body.querySelector('#ss-name').value.trim();
    const goal = body.querySelector('#ss-goal').value.trim();
    try {
      if (mode === 'new') {
        await dp.chatSessionNew({ name, goal });
        await reloadRoleplay();
        toast('已创建并切换到新会话', 'ok');
      } else {
        await dp.chatSessionRename(cur.id, { name, goal });
        await reloadRoleplay();
        toast('会话已更新', 'ok');
      }
      close();
    } catch (err) { toast(errText(err), 'error'); }
  });
}

// ---------- 消息渲染 ----------
function msgEl(m) {
  const el = document.createElement('div');
  const kind = m.role === 'user' ? 'user' : m.role === 'system' ? 'system-notice' : m.error ? 'error' : 'assistant';
  // 戏外工作轮（/order 打标）消息 highlight（用户决策 2026-09-29）：真话边界整轮标亮
  el.className = 'msg ' + kind + (m.work ? ' work' : '');
  el.dataset.id = m.id;
  const avatar = m.role === 'user' ? '🧑' : m.role === 'system' ? '' : '🟢';
  const bodyHTML = m.error
    ? esc(m.content)
    : m.role === 'system'
      ? esc(m.content)
      : renderMD(m.content || '');
  const emoHtml = m.emotion ? `<span class="emo-dot ${m.emotion}" title="${EMO_LABEL[m.emotion] || ''}"></span>` : '';
  // 本轮 API 消耗（模型用量回执汇总；供应商未报用量时不显示）
  const usageText = m.role === 'assistant' ? usageMeterText(m.usage) : '';
  const usageHtml = usageText ? `<div class="token-meter" title="本轮 API 消耗（上游用量回执汇总，仅供参考）">⚡ ${esc(usageText)}</div>` : '';
  const opsHtml = m.role !== 'system'
    ? `<div class="ops">
        <button data-op="copy">复制</button>
        <button data-op="del">删除</button>
        ${m.role === 'assistant' ? '<button data-op="regen">重新生成</button>' : ''}
      </div>` : '';
  el.innerHTML = `
    ${avatar ? `<div class="avatar">${avatar}</div>` : ''}
    <div class="bubble">
      ${opsHtml}
      ${m.work ? '<div class="work-tag">戏外 · 工作轮</div>' : ''}
      <div class="md body">${bodyHTML}</div>
      ${usageHtml}
      ${emoHtml ? `<div class="meta">${emoHtml}<span class="small muted">${EMO_LABEL[m.emotion] || ''}</span></div>` : ''}
      <div class="agent-area"></div>
      <div class="sch-slot"></div>
    </div>`;
  // 消息操作
  el.querySelectorAll('.ops button').forEach(btn => btn.addEventListener('click', () => msgOp(btn.dataset.op, m)));
  // agent 附加组件（历史消息回放：时间线 + diff 卡）
  const agentArea = el.querySelector('.agent-area');
  if (m.steps && m.steps.length) renderTimeline(agentArea, m.steps);
  if (m.changes && m.changes.length) renderDiffCard(agentArea, m.changes);
  // 日程确认条
  if (m.schedule && !m.scheduleDismissed) mountScheduleConfirm(el.querySelector('.sch-slot'), m);
  return el;
}

async function msgOp(op, m) {
  const hist = histories[tab];
  if (op === 'copy') {
    await navigator.clipboard.writeText(m.content).catch(() => {});
    toast('已复制', 'ok', 1200);
  } else if (op === 'del') {
    const i = hist.findIndex(x => x.id === m.id);
    if (i >= 0) { hist.splice(i, 1); await persistHistory(tab); renderAll(); }
  } else if (op === 'regen') {
    if (streaming) return toast('正在生成中…', 'warn');
    const i = hist.findIndex(x => x.id === m.id);
    if (i < 0) return;
    const after = hist.length - i;
    const okBtn = await confirmBox(`将删除这条回复及其之后的 ${after} 条消息并重新生成`, { danger: true, okText: '重新生成' });
    if (!okBtn) return;
    hist.splice(i); // 删除该条及之后
    // 找最后一条用户消息重发
    let lastUser = null, ui = -1;
    for (let j = hist.length - 1; j >= 0; j--) if (hist[j].role === 'user') { lastUser = hist[j]; ui = j; break; }
    if (!lastUser) { await persistHistory(tab); renderAll(); return toast('前面没有用户消息了', 'warn'); }
    hist.splice(ui, 1); // 用户消息由 chat:send 重新追加
    await persistHistory(tab);
    renderAll();
    send(lastUser.content);
  }
}

// 日程确认条（C7）
function mountScheduleConfirm(slot, m) {
  const s = m.schedule;
  const box = document.createElement('div');
  box.className = 'sch-confirm';
  const t = s.start ? new Date(s.start.replace(/-/g, '/')) : null;
  const tText = t ? `${t.getMonth() + 1}月${t.getDate()}日 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '';
  box.innerHTML = `📅 检测到日程：${esc(s.title)} · ${tText}
    <button class="btn btn-sm btn-primary" data-a="add">加入日程</button>
    <button class="btn btn-sm" data-a="skip">忽略</button>`;
  box.addEventListener('click', async (e) => {
    const a = e.target.dataset && e.target.dataset.a;
    if (!a) return;
    if (a === 'add') {
      try {
        await dp.scheduleAdd({
          kind: s.kind, title: s.title, notes: '',
          start: s.start || null, deadline: s.deadline || null, durationMin: s.durationMin,
          remindPreset: s.remindPreset || (s.kind === 'task' ? 'deadline' : 'event'),
          source: 'chat',
        });
        m.scheduleDismissed = true;
        box.classList.add('added');
        box.innerHTML = '✓ 已加入日程，到时间我会提醒你哦～';
        toast('已加入日程', 'ok');
      } catch (err) { toast(errText(err), 'error'); }
    } else {
      m.scheduleDismissed = true;
      box.remove();
    }
  });
  slot.appendChild(box);
}

// ---------- Agent 组件：步骤时间线 / 权限卡 / diff 卡 ----------
const PHASE_ICON = { 设计: '📐', 发现: '🔍', 能力: '🛠', 验证: '✅' };

// 步骤时间线（progress + tool + permission + notice 共用；llm 轮只在台账、不上时间线）
// notice 徽章按类型分化：重试类 🔄 / 搜索开启 🌐 / 搜索日限 📵
function noticeBadge(n) {
  if (n === 'search_enabled') return { icon: '🌐', label: '搜索' };
  if (n === 'search_limit') return { icon: '📵', label: '日限' };
  return { icon: '🔄', label: '重试' };
}
function renderTimeline(container, steps) {
  let box = container.querySelector('.agent-steps');
  if (!box) {
    box = document.createElement('details');
    box.className = 'agent-steps';
    box.open = true;
    container.prepend(box);
  }
  const visible = steps.filter(s => s.kind !== 'llm');
  if (!visible.length) { box.remove(); return; }
  box.innerHTML = `<summary>⚙️ 执行过程（${visible.length} 步）</summary>
    <div class="steps-body">${visible.map(s => {
      if (s.kind === 'progress') return `<div class="step"><span class="badge p">${PHASE_ICON[s.phase] || '•'} ${esc(s.phase || '')}</span><span>${esc(s.text || '')}</span></div>`;
      if (s.kind === 'tool') return `<div class="step"><span class="badge t">🔧 ${esc(s.tool || '')}</span><span class="${s.ok === false ? 'step-fail' : ''}">${esc(s.summary || '')}${s.ok === false ? ' ✗' : ' ✓'}</span></div>`;
      if (s.kind === 'permission') return `<div class="step"><span class="badge s">🛡 权限</span><span>${decisionText(s.decision)}</span></div>`;
      if (s.kind === 'notice') { const nb = noticeBadge(s.notice); return `<div class="step"><span class="badge n">${nb.icon} ${nb.label}</span><span>${esc(s.text || '')}</span></div>`; }
      return '';
    }).join('')}</div>`;
}

function decisionText(d) {
  return { allow_once: '已允许一次写入', deny: '已拒绝', timeout: '超时，按拒绝处理', stopped: '任务已停止' }[d] || String(d || '');
}

// 写权限卡（流式期间内嵌聊天窗；终态后保留展示）
function mountPermissionCard(container, req) {
  let box = container.querySelector('.perm-card[data-rid="' + req.id + '"]');
  if (box) return box;
  box = document.createElement('div');
  box.className = 'perm-card';
  box.dataset.rid = req.id;
  box.innerHTML = `
    <div class="perm-head">🛡 写入批准请求 <span class="perm-action">${esc(req.action)}</span></div>
    <div class="perm-path">${esc((req.scopePaths || []).join('\n'))}</div>
    <div class="perm-meta">${esc(req.detail || '')}</div>
    ${req.reason ? `<div class="perm-reason">理由：${esc(req.reason)}</div>` : ''}
    ${req.reversibility ? `<div class="perm-rev">${esc(req.reversibility)}</div>` : ''}
    <div class="perm-row">
      <button class="btn btn-sm btn-primary" data-d="allow_once">允许一次</button>
      <button class="btn btn-sm" data-d="deny">拒绝</button>
      <span class="perm-countdown"></span>
    </div>`;
  const countdown = box.querySelector('.perm-countdown');
  const deadline = (req.createdAt || Date.now()) + (req.timeoutSec || 120) * 1000;
  box._dpTimer = setInterval(() => {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    countdown.textContent = left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 后自动拒绝` : '';
    if (left <= 0) { clearInterval(box._dpTimer); box._dpTimer = null; }
  }, 500);
  countdown.textContent = `${Math.floor((req.timeoutSec || 120) / 60)}:00 后自动拒绝`;
  box.addEventListener('click', (e) => {
    const d = e.target.dataset && e.target.dataset.d;
    if (!d) return;
    box.querySelectorAll('.perm-row button').forEach(b => b.disabled = true);
    dp.agentPermissionResolve(req.id, d).catch(err => { toast(errText(err), 'error'); box.querySelectorAll('.perm-row button').forEach(b => b.disabled = false); });
  });
  container.appendChild(box);
  scrollBottom();
  return box;
}

function settlePermissionCard(requestId, decision) {
  document.querySelectorAll('.perm-card[data-rid="' + requestId + '"]').forEach(box => {
    if (box._dpTimer) { clearInterval(box._dpTimer); box._dpTimer = null; }
    const row = box.querySelector('.perm-row');
    if (row) row.innerHTML = `<span class="perm-final ${decision === 'allow_once' ? 'ok' : 'no'}">${decisionText(decision)}</span>`;
    box.classList.add(decision === 'allow_once' ? 'allowed' : 'denied');
  });
}

// diff 卡：以下变更由前后快照实测得出，非模型自述
function renderDiffCard(container, changed) {
  if (!changed || !changed.length) return;
  let box = container.querySelector('.diff-card');
  if (!box) {
    box = document.createElement('details');
    box.className = 'diff-card';
    box.open = true;
    container.appendChild(box);
  }
  const hasAmbiguous = changed.some(c => c.origin === 'ambiguous');
  const KIND_CN = { create: '新建', overwrite: '覆盖', modify: '修改' };
  box.innerHTML = `
    <summary>🗂 文件变更（${changed.length}）</summary>
    <div class="diff-note">以下变更由 deskpal 前后快照实测得出，非模型自述</div>
    ${hasAmbiguous ? '<div class="diff-warn">⚠ 检测到工具声明之外的变更，请人工确认</div>' : ''}
    ${changed.map(c => `
      <div class="diff-file">
        <div class="diff-file-head">
          <span class="badge k">${KIND_CN[c.kind] || c.kind}</span>
          <span class="diff-path">${esc(c.path)}</span>
          ${c.origin === 'ambiguous' ? '<span class="badge a">来源不明</span>' : ''}
        </div>
        ${c.note ? `<div class="diff-note">${esc(c.note)}</div>` : ''}
        ${(c.hunks && c.hunks.length) ? `<pre class="diff-hunks">${c.hunks.map(h =>
          h.aLines.map(l => '<span class="dl">-' + esc(l) + '</span>').join('')
          + h.bLines.map(l => '<span class="di">+' + esc(l) + '</span>').join('')).join('')
        }</pre>` : '<div class="diff-note">（无内容差异或文件过大未生成 diff）</div>'}
        ${c.truncated ? '<div class="diff-note">差异行数超过 200，已截断</div>' : ''}
      </div>`).join('')}`;
}

// ---------- 中断任务提示条 ----------
async function loadInterrupted() {
  try {
    const { runs } = await dp.agentRuns(20);
    const last = (runs || []).find(r => r.status === 'interrupted');
    if (!last) return;
    const slot = main.querySelector('#interruptSlot');
    const box = document.createElement('div');
    box.className = 'interrupt-bar';
    box.innerHTML = `<span>⚠ 上次有个任务被中断</span><button class="btn btn-sm" data-a="view">查看</button>`;
    box.addEventListener('click', (e) => {
      if (!(e.target.dataset && e.target.dataset.a === 'view')) return;
      if (box.dataset.expanded) { box.remove(); return; }
      box.dataset.expanded = '1';
      const d = new Date(last.at || '');
      const stepLines = (last.steps || []).map(s => {
        if (s.kind === 'progress') return `${PHASE_ICON[s.phase] || '•'} [${s.phase}] ${s.text}`;
        if (s.kind === 'tool') return `🔧 ${s.tool} ${s.summary || ''} ${s.ok === false ? '✗' : '✓'}`;
        if (s.kind === 'permission') return `🛡 权限：${decisionText(s.decision)}`;
        if (s.kind === 'llm') return `· 第 ${s.round} 轮（${s.finishReason}）`;
        return '';
      }).filter(Boolean).join('\n') || '（无步骤记录）';
      box.innerHTML = `
        <div class="ib-title">⚠ 上次有个任务被中断（${esc(isNaN(d) ? String(last.at || '') : d.toLocaleString())}）</div>
        <div class="ib-cmd">指令：${esc(last.instruction || '')}</div>
        <pre class="ib-steps">${esc(stepLines)}</pre>
        ${last.changed && last.changed.length ? `<div class="ib-changes">已发生的写入：${last.changed.map(c => esc(c.path)).join('、')}</div>` : ''}
        <div class="ib-row">
          <button class="btn btn-sm btn-primary" data-a="redo">重新发起</button>
          <button class="btn btn-sm" data-a="close">关闭</button>
        </div>`;
      box.querySelector('[data-a=redo]').addEventListener('click', () => {
        input.value = String(last.instruction || '');
        autoGrow();
        input.focus();
        box.remove();
        toast('已填入输入框，确认后发送', 'ok');
      });
      box.querySelector('[data-a=close]').addEventListener('click', () => box.remove());
    });
    slot.appendChild(box);
  } catch (_) { /* 台账不可用（旧版本无 agent:runs） */ }
}

function renderAll() {
  list.innerHTML = '';
  const hist = histories[tab];
  if (!hist.length) {
    const sess = sessionInfo.sessions.find(s => s.id === sessionInfo.activeSessionId);
    const sessName = tab === 'roleplay' && sess ? `「${sess.name}」` : '';
    list.innerHTML = `<div class="empty">${tab === 'roleplay' ? `这是${sessName}的开头——和你的宠物聊聊吧，重要的事它会记住` : '问点什么，我直接回答'}</div>`;
    return;
  }
  for (const m of hist) list.appendChild(msgEl(m));
  scrollBottom();
}

// 保存到主进程时剥离仅存渲染层的附加数据（时间线/diff 归档在 agent/runs.jsonl，不进 chats）。
// agentRun 从 runId 派生保留：主进程据此在上下文里做戏外工作报告的摘要化隔离
async function persistHistory(t) {
  const clean = histories[t].map(m => {
    const { steps, changes, runId, ...rest } = m;
    return runId ? { ...rest, agentRun: true } : rest;
  });
  await dp.chatSaveHistory(t, clean);
}

function scrollBottom() { list.scrollTop = list.scrollHeight; }

// ---------- 发送流水线 ----------
async function send(text) {
  text = String(text ?? '').trim();
  if (!text || streaming) return;

  // 0. 斜杠命令：长期记忆 / 用户身份档案 / 搜索账本（仅角色扮演标签；不入史/不计数/不进 LLM，角色无感知）
  if (tab === 'roleplay') {
    if (MEMORY_CMD_RE.test(text)) {
      input.value = ''; autoGrow(); openMemoryManager(); return;
    }
    if (PROFILE_CMD_RE.test(text)) {
      input.value = ''; autoGrow(); openProfileManager(); return;
    }
    if (SEARCH_CMD_RE.test(text)) {
      input.value = ''; autoGrow(); openSearchLedger(); return;
    }
    if (DISCIPLINE_CMD_RE.test(text)) {
      input.value = ''; autoGrow(); openDisciplineModal(); return;
    }
  }

  // 1. 本地启动器匹配（零 API）
  try {
    const hit = await dp.launcherMatch(text);
    if (hit && hit.hit) {
      histories[tab].push({ id: uid('m'), role: 'user', content: text, at: new Date().toISOString() });
      const sysMsg = { id: uid('m'), role: 'system', content: `这就为你打开「${hit.label}」～` };
      histories[tab].push(sysMsg);
      await persistHistory(tab);
      renderAll();
      dp.launcherRun(hit.id).catch(err => toast(errText(err), 'error'));
      return;
    }
  } catch (_) { /* 匹配失败继续走 LLM */ }

  // 2. 日程指令直达（打开日程窗并预填解析）
  if (SCHEDULE_RE.test(text)) {
    dp.schedulePrefill(text);
    return;
  }

  // 3. 走 LLM
  const userMsg = { id: uid('m'), role: 'user', content: text, at: new Date().toISOString() };
  histories[tab].push(userMsg);
  renderAll();
  input.value = '';
  autoGrow();

  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `<div class="avatar">🟢</div><div class="bubble"><div class="md body"><span class="streaming-cursor"></span></div><div class="agent-area"></div><div class="sch-slot"></div></div>`;
  list.appendChild(el);
  scrollBottom();

  streaming = { tab, el, raw: '', reqId: undefined, steps: [], changes: null };
  setStreamUI(true);

  try {
    const res = await dp.chatSend(tab, text);
    // 主进程兜底命中斜杠命令（渲染层正则失效时）：撤销本地用户消息与流式气泡，按命令类型接管
    if (res && (res.memoryCommand || res.profileCommand || res.ledgerCommand || res.disciplineCommand)) {
      streaming = null;
      setStreamUI(false);
      el.remove();
      const ui = histories[tab].findIndex(x => x.role === 'user' && x.content === text);
      if (ui >= 0) { histories[tab].splice(ui, 1); renderAll(); }
      if (res.disciplineCommand) openDisciplineModal();
      return;
    }
    if (res.work) userMsg.work = true; // 主进程通道判定回填，renderAll 时用户气泡带「戏外」标
    if (res.sessionId) streaming.sessionId = res.sessionId;
    streaming.reqId = res.reqId;
  } catch (err) {
    streaming = null;
    setStreamUI(false);
    el.remove();
    histories[tab].push({ id: uid('m'), role: 'assistant', content: errText(err), error: true, at: new Date().toISOString() });
    renderAll();
  }
}

// ---------- 流式事件 ----------
dp.on('llm:chunk', ({ tab: t, reqId, delta, beat }) => {
  if (!streaming || streaming.tab !== t) return;
  if (reqId && streaming.reqId && reqId !== streaming.reqId) return;
  if (delta) streaming.raw += delta;
  const body = streaming.el.querySelector('.body');
  body.innerHTML = renderMD(streaming.raw) + '<span class="streaming-cursor"></span>';
  scrollBottom();
  // 节拍：该句正文已显示完成，触发宠物表情（roleplay 持续保持；quick 6s 回落）
  if (beat) dp.petEmote(beat, 'chat', t === 'roleplay' ? 0 : 6000);
});

dp.on('llm:done', async ({ tab: t, reqId, clean, emotion, schedule, aborted, beats, runId, changes, msgId, usage, sessionId }) => {
  if (!streaming || streaming.tab !== t) return;
  // 会话守卫：回复落在了另一个会话（极端情况：流式期间会话被外部切换）——本地不再渲染，
  // 消息已由主进程存进它自己的会话，切回去自然可见
  if (t === 'roleplay' && sessionId && sessionInfo.activeSessionId && sessionId !== sessionInfo.activeSessionId) {
    streaming = null;
    setStreamUI(false);
    return;
  }
  const el = streaming.el;
  const localSteps = streaming.steps;
  const localChanges = streaming.changes || changes || null;
  const raw = aborted ? streaming.raw + '\n\n（已停止生成）' : (clean ?? streaming.raw);
  streaming = null; // 回合结束：本地节拍表随之作废，表情按 pet.js 持续/回落机制自然接管
  setStreamUI(false);

  const msg = {
    id: msgId || uid('m'), role: 'assistant', content: raw,
    emotion: emotion || undefined, beats: beats || undefined,
    schedule: schedule || undefined, aborted: !!aborted, at: new Date().toISOString(),
    runId: runId || undefined,
    steps: localSteps && localSteps.length ? localSteps : undefined,
    changes: localChanges || undefined,
    usage: usage || undefined,
  };
  histories[t].push(msg);
  renderAll();
  // 保存由主进程负责（历史权威在主进程）；刷新本地副本并回填主进程不存的附加数据（时间线/diff/中断半截）
  try {
    const fresh = await dp.chatHistory(t);
    const extras = new Map(histories[t].filter(m => m.id && (m.steps || m.changes || m.aborted)).map(m => [m.id, m]));
    histories[t] = fresh.map(m => (extras.has(m.id) ? { ...m, ...extras.get(m.id), content: m.content } : m));
    // 主进程未保存的消息（停止半截）保留在末尾——agent 中止时 diff 卡与时间线不丢
    const preserved = msg && !fresh.some(m => m.id === msg.id) && (msg.aborted || msg.steps || msg.changes) ? [msg] : [];
    histories[t] = [...histories[t], ...preserved];
    renderAll();
  } catch (_) {}
});

dp.on('llm:error', ({ tab: t, error }) => {
  if (!streaming || streaming.tab !== t) return;
  streaming.el.remove();
  streaming = null;
  setStreamUI(false);
  histories[t].push({ id: uid('m'), role: 'assistant', content: error, error: true, at: new Date().toISOString() });
  renderAll();
});

// ---------- Agent 流式事件（仅 roleplay） ----------
dp.on('agent:step', (d) => {
  if (!streaming || streaming.tab !== d.tab) return;
  if (streaming.reqId && d.reqId !== streaming.reqId) return;
  streaming.steps.push(d);
  // 假完成重试 / 截断重试：主进程管线已重置，本地正文同步清空
  if (d.kind === 'notice') {
    streaming.raw = '';
    const body = streaming.el.querySelector('.body');
    body.innerHTML = '<span class="streaming-cursor"></span>';
  }
  renderTimeline(streaming.el.querySelector('.agent-area'), streaming.steps);
  scrollBottom();
});

dp.on('agent:permission', (d) => {
  if (d.final !== undefined && d.final) {
    settlePermissionCard(d.requestId, d.decision);
    return;
  }
  if (!streaming || streaming.tab !== d.tab) return;
  if (streaming.reqId && d.reqId !== streaming.reqId) return;
  mountPermissionCard(streaming.el.querySelector('.agent-area'), d.request, d.reqId);
});

dp.on('agent:artifact', (d) => {
  if (!streaming || streaming.tab !== d.tab) return;
  if (streaming.reqId && d.reqId !== streaming.reqId) return;
  streaming.changes = d.changed || [];
  renderDiffCard(streaming.el.querySelector('.agent-area'), streaming.changes);
  scrollBottom();
});

dp.on('agent:done', (d) => {
  // run 收尾（含 aborted）：diff 卡兜底刷新；llm:done 随后关闭流式状态
  if (!streaming || streaming.tab !== d.tab) return;
  if (streaming.reqId && d.reqId !== streaming.reqId) return;
  if (d.changes && d.changes.length) {
    streaming.changes = d.changes;
    renderDiffCard(streaming.el.querySelector('.agent-area'), streaming.changes);
  }
});

function setStreamUI(on) {
  sendBtn.disabled = on;
  stopBtn.style.display = on ? '' : 'none';
  if (on) input.focus();
}

stopBtn.addEventListener('click', () => {
  if (streaming && streaming.reqId) dp.chatStop(streaming.reqId);
});

// ---------- 输入区 ----------
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(150, input.scrollHeight) + 'px';
}
input.addEventListener('input', autoGrow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
});
sendBtn.addEventListener('click', () => send(input.value));

// ---------- 长期记忆管理面板（/deep memory forcing；角色无感知） ----------
const MEM_TYPE_LABEL = { relationship: '关系', event: '事件', fact: '事实', preference: '偏好' };
const MEM_SCOPE_LABEL = { core: 'core·身份级', working: 'working·滚动', ephemeral: 'ephemeral·限时' };
async function openMemoryManager() {
  const { body } = openModal({ title: '🧠 长期记忆 · 角色无感知', width: '680px' });

  async function refresh() {
    let items = [], coreUsage = { used: 0, budget: 1000 }, archive = [];
    try {
      [items, coreUsage, archive] = await Promise.all([dp.memoryList(), dp.memoryCoreUsage(), dp.memoryArchiveList().catch(() => [])]);
    } catch (err) { toast(errText(err), 'error'); }
    body.innerHTML = `
      <p class="hint" style="margin:4px 0 10px">宠物的长期记忆，分三层：<b>core</b>（身份级认知，全量每轮注入，共 ${coreUsage.used}/${coreUsage.budget} 字，不自动淘汰）、<b>working</b>（滚动记忆，最近 8 条注入）、<b>ephemeral</b>（限时事件，默认 14 天过期进归档，不注入）。本面板的查看/添加/删除/改层/恢复归档不进聊天记录，角色不会察觉。打开本面板时会自动补提取未入库的近期对话。</p>
      <div class="mem-add">
        <select id="memType">${Object.entries(MEM_TYPE_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <select id="memImp">${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${'★'.repeat(n)}</option>`).join('')}</select>
        <select id="memScope">${Object.entries(MEM_SCOPE_LABEL).map(([v, l]) => `<option value="${v}" ${v === 'working' ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input id="memContent" type="text" maxlength="60" placeholder="新增记忆内容（≤60字）…">
        <button class="btn btn-sm btn-primary" id="memAddBtn">添加</button>
      </div>
      <div class="mem-list">
        ${items.length ? items.map(it => `
          <div class="mem-item">
            <div class="mem-main">
              <span class="mem-type t-${esc(it.type)}">${MEM_TYPE_LABEL[it.type] || esc(it.type)}</span>
              <select class="mem-scope-sel" data-id="${esc(it.id)}" title="记忆层级">${Object.entries(MEM_SCOPE_LABEL).map(([v, l]) => `<option value="${v}" ${it.scope === v ? 'selected' : ''}>${l.split('·')[0]}</option>`).join('')}</select>
              <span class="mem-imp" title="重要性 ${it.importance}/5">${'★'.repeat(Math.max(1, Math.min(5, it.importance || 1)))}</span>
              <span class="mem-content" title="${esc(it.content)}">${esc(it.content)}</span>
              ${it.note ? `<span class="hint" title="${esc(it.note)}">⚠</span>` : ''}
            </div>
            <div class="mem-side">
              <span class="small muted">${esc(String(it.createdAt || '').slice(0, 10))}</span>
              <button class="btn btn-sm btn-danger" data-del="${esc(it.id)}">删除</button>
            </div>
          </div>`).join('')
        : '<p class="hint" style="text-align:center;padding:18px 0">暂无长期记忆——聊到重要信息（每 6 条用户消息 / 会话冷却后 / 打开本面板时）会自动提取；角色也会在你说「记住…」时主动写入。也可在上方手动添加。</p>'}
      </div>
      <details class="mem-archive" ${archive.length ? '' : 'hidden'}>
        <summary>🗄 淘汰归档（${archive.length}）——过期/库满时移出的记忆，可恢复</summary>
        <p class="hint" style="margin:6px 0 8px">恢复 = 重新确认：条目回到记忆库并按最新计入注入顺位；若库已满（50 条），会如实顶掉另一条最旧记忆进归档（下方操作回执会注明）。已过期的限时事件恢复后自动转为 working 长期记忆。</p>
        <div class="mem-arc-list">
          ${archive.map(e => `
            <div class="mem-arc-item">
              <div class="mem-main">
                <span class="mem-type t-${esc(e.type)}">${MEM_TYPE_LABEL[e.type] || esc(e.type)}</span>
                <span class="badge ${e.reason === 'ttl' ? 'n' : 'a'}">${e.reason === 'ttl' ? '限时到期' : '库满腾位'}</span>
                <span class="mem-content" title="${esc(e.content)}">${esc(e.content)}</span>
              </div>
              <div class="mem-side">
                <span class="small muted" title="原记忆日期｜归档日期">${esc(String(e.createdAt || '').slice(0, 10))} → ${esc(String(e.archivedAt || '').slice(0, 10))}</span>
                <button class="btn btn-sm" data-arc-restore="${esc(e.id)}">↩ 恢复</button>
              </div>
            </div>`).join('')}
        </div>
      </details>`;
    const contentInput = body.querySelector('#memContent');
    const addBtn = body.querySelector('#memAddBtn');
    const doAdd = async () => {
      const content = contentInput.value.trim();
      if (!content) return toast('记忆内容不能为空', 'error');
      try {
        await dp.memoryAdd({ type: body.querySelector('#memType').value, importance: +body.querySelector('#memImp').value, scope: body.querySelector('#memScope').value, content });
        toast('已添加记忆', 'ok');
        refresh();
      } catch (err) { toast(errText(err), 'error'); }
    };
    addBtn.addEventListener('click', doAdd);
    contentInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) doAdd(); });
    body.querySelectorAll('.mem-scope-sel').forEach(sel => sel.addEventListener('change', async () => {
      try { await dp.memorySetScope(sel.dataset.id, sel.value); toast('层级已调整', 'ok'); refresh(); }
      catch (err) { toast(errText(err), 'error'); refresh(); }
    }));
    body.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
      if (!(await confirmBox('删除这条长期记忆？角色将不再记得它。', { okText: '删除', danger: true }))) return;
      try { await dp.memoryDelete(btn.dataset.del); toast('已删除', 'ok'); refresh(); } catch (err) { toast(errText(err), 'error'); }
    }));
    // 归档恢复：回执如实转告「为腾位又归档了什么」「过期限时事件已转 working」
    body.querySelectorAll('[data-arc-restore]').forEach(btn => btn.addEventListener('click', async () => {
      try {
        const r = await dp.memoryArchiveRestore(btn.dataset.arcRestore);
        const parts = [`已恢复：${r.content}`];
        if (r.evicted && r.evicted.length) parts.push(`库已满，为腾位又归档了 ${r.evicted.length} 条最旧记忆（${r.evicted.map(e => esc(e.content)).join('、')}）`);
        if (r.note) parts.push(r.note);
        toast(parts.join('；'), 'ok', 5000);
        refresh();
      } catch (err) { toast(errText(err), 'error'); refresh(); }
    }));
  }
  await refresh();
}

// ---------- 用户身份档案面板（/user profile；角色无感知） ----------
const LAYER_CN = { P1: 'P1 性格与相处', P2: 'P2 职业与经济（稳定层）', P2b: 'P2b 项目流水（高频滚动，满 20 自动归档最旧的）', P3: 'P3 关系档案' };
let profileModalBody = null;
async function openProfileManager() {
  const { body } = openModal({ title: '🪪 用户身份档案 · 角色无感知', width: '680px' });
  profileModalBody = body;
  body.innerHTML = '<p class="hint" style="padding:12px">加载中…（如有未漂移的新消息会先补跑一次提取）</p>';
  let doc;
  try { doc = await dp.profileGet(); } catch (err) { body.innerHTML = `<p class="hint">加载失败：${esc(errText(err))}</p>`; return; }
  renderProfile(doc);

  function kvRows(layer, obj) {
    return Object.entries(obj || {}).map(([k, v]) => `
      <div class="row prof-kv" data-layer="${layer}" style="gap:6px;margin:4px 0">
        <input type="text" class="pf-key" value="${esc(k)}" maxlength="12" style="width:120px" placeholder="字段名">
        <input type="text" class="pf-val" value="${esc(v)}" maxlength="240" style="flex:1" placeholder="内容">
        <button class="btn btn-sm btn-icon" data-a="del-kv" title="删除">🗑</button>
      </div>`).join('');
  }

  function renderProfile(d) {
    body.innerHTML = `
      <p class="hint" style="margin:4px 0 10px">「宠物对你的长期认知」档案，分层对照 senpai-model 十组架构：P0=身份基座（A组）；P1=生理节奏/认知架构/价值动机/情绪关系/交互偏好（B–F组）；P2=职业与经济稳定层（G–H组）；<b>P2b=项目流水层（v0.5 新增：项目进展/里程碑/工具链/单次审计结论，高频覆盖，满载自动归档）</b>；P3=关系档案/元规则（E6-8、I组）。P1–P3 随对话自动漂移（每 6 条消息一次），全部变更落在下方日志可回滚。每层上限 P1/P2/P3=30、P2b=20、单字段 240 字；注入预算 12000 字符（超出按 P2b→P2→P3 优先级截断并注明）。面板操作不进聊天记录。</p>
      <div class="row" style="gap:16px;margin-bottom:8px">
        <label class="row" style="gap:6px"><input type="checkbox" id="pf-enabled" ${d.enabled !== false ? 'checked' : ''}> 注入角色上下文</label>
        <label class="row" style="gap:6px"><input type="checkbox" id="pf-drift" ${d.drift !== false ? 'checked' : ''}> 允许对话漂移更新</label>
      </div>
      <div class="row" style="margin-bottom:8px">
        <button class="btn btn-sm" id="pf-import">📥 导入预填文件（senpai-model 全量字段，只补空缺不覆盖）</button>
        <span class="hint" id="pf-import-result"></span>
      </div>
      <div class="field"><span class="label">P0 身份锚（A组 7 字段：年龄/性别/所在地/学历/信仰/婚姻家庭/称呼体系，任何对话必须正确；漂移锁定，仅此处可编辑）</span>
        <textarea id="pf-p0" rows="6" maxlength="1200" placeholder="例：年龄段，所在城市，职业，家庭/信仰状况……">${esc(d.P0 || '')}</textarea></div>
      ${['P1', 'P2', 'P2b', 'P3'].map(L => `
        <div class="field" style="margin-top:10px"><span class="label">${LAYER_CN[L]}${L === 'P2b' ? '' : L === 'P2' ? '' : ''}</span>
          <div id="pf-${L}">${kvRows(L, d[L])}</div>
          <button class="btn btn-sm" data-a="add-kv" data-layer="${L}">＋ 添加字段</button>
        </div>`).join('')}
      <div class="row" style="margin:14px 0 6px">
        <button class="btn btn-primary btn-sm" id="pf-save">💾 保存档案</button>
        <span class="hint grow" id="pf-saved"></span>
      </div>
      <h4 style="margin:10px 0 6px">变更日志（${(d.log || []).length}）</h4>
      <div class="pf-log" style="max-height:220px;overflow:auto">
        ${(d.log || []).slice().reverse().map(e => `
          <div class="prof-log-item" style="padding:6px 0;border-bottom:1px dashed var(--dp-border);font-size:12px">
            <div class="row" style="gap:6px;align-items:center">
              <span class="badge ${e.source === 'drift' ? 'n' : 'p'}">${e.source === 'drift' ? '漂移' : e.source === 'user' ? '手动' : '回滚'}</span>
              <b>${esc(e.layer)}.${esc(e.key)}</b>
              ${e.applied ? '' : '<span class="hint">（未生效：' + esc(e.note || '') + '）</span>'}
              ${e.revertedAt ? '<span class="hint">（已回滚）</span>' : ''}
              <span class="grow"></span>
              <span class="muted small">${esc(String(e.at || '').replace('T', ' ').slice(0, 16))}</span>
            </div>
            ${e.applied ? `<div class="row" style="gap:6px;margin-top:2px;flex-wrap:wrap"><span class="muted">旧：</span><span>${esc(e.old == null ? '（新增字段）' : e.old)}</span><span class="muted">→ 新：</span><span>${esc(e.new)}</span></div>` : ''}
            ${e.quote ? `<div class="hint">依据：「${esc(e.quote)}」 · ${esc(e.reason || '')}</div>` : ''}
            ${e.source === 'drift' && e.applied && !e.revertedAt ? `<button class="btn btn-sm" style="margin-top:4px" data-a="revert" data-id="${esc(e.id)}">↩ 回滚这条</button>` : ''}
          </div>`).join('') || '<p class="hint" style="padding:8px 0">暂无变更。角色扮演聊天中出现的身份信息变化会自动漂移到这里。</p>'}
      </div>
      <h4 style="margin:12px 0 6px">满载归档 <span class="hint" id="pf-arc-n"></span></h4>
      <div id="pf-archive" class="pf-log" style="max-height:160px;overflow:auto"><p class="hint" style="padding:8px 0">加载中…</p></div>`;

    // 交互：加/删字段行
    body.querySelectorAll('[data-a=add-kv]').forEach(btn => btn.addEventListener('click', () => {
      const L = btn.dataset.layer;
      const host = body.querySelector('#pf-' + L);
      const row = document.createElement('div');
      row.className = 'row prof-kv';
      row.dataset.layer = L;
      row.style.cssText = 'gap:6px;margin:4px 0';
      row.innerHTML = `<input type="text" class="pf-key" maxlength="12" style="width:120px" placeholder="字段名"><input type="text" class="pf-val" maxlength="160" style="flex:1" placeholder="内容"><button class="btn btn-sm btn-icon" data-a="del-kv" title="删除">🗑</button>`;
      host.appendChild(row);
      row.querySelector('.pf-key').focus();
    }));
    body.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-a=del-kv]');
      if (btn) btn.closest('.prof-kv').remove();
    });
    // 保存
    body.querySelector('#pf-save').addEventListener('click', async () => {
      const collectLayer = (L) => {
        const out = {};
        body.querySelectorAll(`.prof-kv[data-layer=${L}]`).forEach(row => {
          const k = row.querySelector('.pf-key').value.trim(), v = row.querySelector('.pf-val').value.trim();
          if (k && v) out[k] = v;
        });
        return out;
      };
      const doc2 = {
        enabled: body.querySelector('#pf-enabled').checked,
        drift: body.querySelector('#pf-drift').checked,
        P0: body.querySelector('#pf-p0').value,
        P1: collectLayer('P1'), P2: collectLayer('P2'), P2b: collectLayer('P2b'), P3: collectLayer('P3'),
        log: doc.log || [],
      };
      try {
        const saved = await dp.profileSave(doc2);
        doc = saved;
        toast('档案已保存', 'ok');
        renderProfile(saved); // 重渲染：清洗后的 key/value（超长截断等）立即可见
      } catch (err) { toast(errText(err), 'error'); }
    });
    // 导入预填文件（senpai-model 全量字段；fill-empty：已有值一律保留；文件由主进程读取）
    body.querySelector('#pf-import').addEventListener('click', async () => {
      const p = await dp.pickFile({ title: '选择档案预填 JSON（如 docs/profile-seed.json）', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!p) return;
      const res = body.querySelector('#pf-import-result');
      try {
        const r = await dp.profileSeed(p);
        res.textContent = `✓ 新增 P0 ${r.added.P0} / P1 ${r.added.P1} / P2 ${r.added.P2} / P2b ${r.added.P2b} / P3 ${r.added.P3} 字段（已有值未动）`;
        toast('预填导入完成', 'ok');
        doc = await dp.profileGet();
        renderProfile(doc);
      } catch (err) { res.textContent = '✗ ' + errText(err); toast(errText(err), 'error'); }
    });
    // 回滚
    body.querySelectorAll('[data-a=revert]').forEach(btn => btn.addEventListener('click', async () => {
      try {
        await dp.profileRevert(btn.dataset.id);
        toast('已回滚', 'ok');
        doc = await dp.profileGet();
        renderProfile(doc);
      } catch (err) { toast(errText(err), 'error'); }
    }));
    // 满载归档：查看 + 一键还原（还原时若目标层已满，主进程会先归档腾位）
    (async () => {
      const box = body.querySelector('#pf-archive');
      if (!box || !box.isConnected) return;
      let arc = [];
      try { arc = await dp.profileArchiveList(); } catch (_) {}
      body.querySelector('#pf-arc-n').textContent = arc.length ? `（${arc.length} 条）` : '（空）';
      box.innerHTML = arc.length ? arc.map((e, i) => `
        <div style="padding:6px 0;border-bottom:1px dashed var(--dp-border);font-size:12px">
          <div class="row" style="gap:6px;align-items:center">
            <span class="badge a">${esc(e.layer)}</span><b>${esc(e.key)}</b>
            <span class="grow"></span><span class="muted small">${esc(String(e.at || '').replace('T', ' ').slice(0, 16))}</span>
            ${e.restoredAt ? '<span class="hint">（已还原）</span>' : `<button class="btn btn-sm" data-a="arc-restore" data-i="${i}">↩ 还原</button>`}
          </div>
          <div class="hint">${esc(e.value)}</div>
        </div>`).join('') : '<p class="hint" style="padding:8px 0">还没有满载归档。P2b 满载即时归档、P2 满载高频（30 天 ≥3 次）归档，被腾位的条目会出现在这里。</p>';
      box.querySelectorAll('[data-a=arc-restore]').forEach(btn => btn.addEventListener('click', async () => {
        try {
          await dp.profileArchiveRestore(btn.dataset.i);
          toast('已还原到档案', 'ok');
          doc = await dp.profileGet();
          renderProfile(doc);
        } catch (err) { toast(errText(err), 'error'); }
      }));
    })();
  }
}

// ---------- 搜索账本面板（/search ledger；角色无感知） ----------
const STATUS_CN = { ok: '✓ 成功', blocked: '⛔ 拦截', denied: '🚫 拒绝', failed: '✗ 失败', cached: '♻ 缓存' };
const TRACK_CN = { designated: '指定轨', autonomous: '自主轨' };
let ledgerModalBody = null, ledgerRange = 'all';
// ---------- 本轮 API 消耗外显（模型用量回执汇总） ----------
// 输入=prompt_tokens（含缓存命中拆分）；思考=reasoning_tokens；回复=completion−思考。
// 供应商不报的维度不显示（不造数）；agent 轮含多次请求时为合计并注次数。
// 有效消耗：缓存命中部分按 ~1/10 计价（DeepSeek 前缀缓存口径），未命中全价——
// 多轮工具任务的原始输入累加会很大，但大头被缓存吸收，这个数才接近真实账单。
function usageMeterText(u) {
  if (!u || (u.input == null && u.output == null)) return '';
  const n = (x) => (x == null ? null : Math.round(x).toLocaleString('en-US'));
  const parts = [];
  if (n(u.input) != null) {
    parts.push('输入 ' + n(u.input) + (u.cacheHit != null ? `（命中 ${n(u.cacheHit)}）` : ''));
    if (u.cacheHit != null && u.cacheHit > 0 && u.input > u.cacheHit) {
      const effective = Math.round(u.input - u.cacheHit + u.cacheHit * 0.1);
      parts.push('有效 ≈ ' + effective.toLocaleString('en-US'));
    }
  }
  if (n(u.output) != null) {
    if (u.reasoning != null) {
      const visible = Math.max(0, Math.round(u.output) - Math.round(u.reasoning));
      parts.push('思考 ' + n(u.reasoning), '回复 ' + n(visible));
    } else {
      parts.push('回复 ' + n(u.output) + '（含思考）');
    }
  }
  if (u.requests > 1) parts.push(u.requests + ' 次调用');
  return parts.join(' · ');
}

async function openDisciplineModal() {
  const { body } = openModal({ title: '📐 记忆整理纪律 · 角色无感知', width: '640px' });
  body.innerHTML = '<p class="hint" style="padding:12px">加载中…</p>';
  let sections;
  try { sections = await dp.disciplineView(); } catch (err) { body.innerHTML = `<p class="hint">加载失败：${esc(errText(err))}</p>`; return; }
  const order = ['extract', 'drift', 'overwrite'];
  const keys = Object.keys(sections || {}).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  body.innerHTML = `
    <p class="hint" style="margin:4px 0 10px">以下是约束「记忆/档案自动整理行为」的纪律条款——注入在主进程的整理提示词与工具回执里，角色本身看不到这份清单（不进聊天历史、不进角色上下文）。这里只读展示，供你核对角色没有违背它们。</p>
    ${keys.map(k => {
      const s = sections[k] || {};
      return `<div class="disc-sec">
        <div class="disc-title">${esc(s.title || k)}</div>
        <div class="disc-target">${esc(s.target || '')}</div>
        <ul class="disc-items">${(s.items || []).map(it => `<li>${esc(it)}</li>`).join('')}</ul>
      </div>`;
    }).join('')}`;
}

async function openSearchLedger() {
  const { body } = openModal({ title: '🌐 联网搜索账本 · 角色无感知', width: '700px' });
  ledgerModalBody = body;
  await refreshLedger();
}
async function refreshLedger() {
  const body = ledgerModalBody;
  if (!body || !body.isConnected) { ledgerModalBody = null; return; }
  let data;
  try { data = await dp.searchLedger(ledgerRange); } catch (err) { body.innerHTML = `<p class="hint">加载失败：${esc(errText(err))}</p>`; return; }
  const s = data.summary || {};
  const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0));
  body.innerHTML = `
    <p class="hint" style="margin:4px 0 10px">每一次检索（含被拦截/被拒/失败/缓存）都落账。自主轨条目可裁决：✓ 认可计入有效产出；✗ 划除后角色汇报时须表述为「已作废」。「轨道存疑」= 自报指定轨但当轮指令与查询词重合度低，建议抽查。花费为应用层估算 token（搜索源多不返回精确用量）。</p>
    <div class="row" style="gap:8px;margin-bottom:10px">
      ${[['today', '今日'], ['week', '本周'], ['month', '本月'], ['all', '全部']].map(([v, l]) =>
        `<button class="btn btn-sm ${ledgerRange === v ? 'btn-primary' : ''}" data-range="${v}">${l}</button>`).join('')}
    </div>
    <div class="row" style="gap:10px;flex-wrap:wrap;margin-bottom:10px;font-size:12px">
      <span class="badge p">指定轨 ${s.designated ? s.designated.count : 0} 条 · ${fmtTok(s.designated && s.designated.estTokens)} tok</span>
      <span class="badge n">自主轨 ${s.autonomous ? s.autonomous.count : 0} 条 · ${fmtTok(s.autonomous && s.autonomous.estTokens)} tok · 划除 ${s.autonomous ? s.autonomous.rejected : 0}</span>
      <span class="badge s">拦截 ${s.blocked || 0}</span><span class="badge t">拒绝 ${s.denied || 0}</span>
      <span class="badge">失败 ${s.failed || 0}</span><span class="badge">缓存 ${s.cached || 0}</span>
    </div>
    <div style="max-height:360px;overflow:auto">
      ${(data.entries || []).map(e => `
        <div style="padding:8px 0;border-bottom:1px dashed var(--dp-border);font-size:12px" data-id="${esc(e.id)}">
          <div class="row" style="gap:6px;align-items:center;flex-wrap:wrap">
            <span class="badge ${e.track === 'autonomous' ? 'n' : 'p'}">${TRACK_CN[e.track] || e.track}</span>
            <span class="badge">${STATUS_CN[e.status] || e.status}</span>
            <b style="font-size:12px">${esc(e.query)}</b>
            ${e.suspect ? '<span class="badge a">轨道存疑</span>' : ''}
            <span class="grow"></span>
            <span class="muted small">${esc(String(e.at || '').replace('T', ' ').slice(5, 16))}</span>
          </div>
          ${e.reason ? `<div class="hint">理由：${esc(e.reason)}</div>` : ''}
          <div class="hint">${esc(e.source)} · ${e.results} 条结果 · ${e.estTokens || 0} tok 估算${e.status === 'cached' ? ' · 缓存命中（未重复请求）' : ''}${e.blockRule ? ' · 拦截规则：' + esc(e.blockRule) : ''}${e.verdict === 'rejected' ? ' · 已划除' : e.verdict === 'accepted' ? ' · 已认可' : ''}</div>
          ${e.track === 'autonomous' && e.status === 'ok' && !e.verdict ? `
            <div class="row" style="margin-top:4px;gap:6px">
              <button class="btn btn-sm btn-primary" data-a="accept" data-id="${esc(e.id)}">✓ 认可</button>
              <button class="btn btn-sm" data-a="reject" data-id="${esc(e.id)}">✗ 划除</button>
            </div>` : ''}
        </div>`).join('') || '<p class="hint" style="padding:12px 0">还没有任何检索记录。</p>'}
    </div>`;
  body.querySelectorAll('[data-range]').forEach(btn => btn.addEventListener('click', async () => {
    ledgerRange = btn.dataset.range;
    await refreshLedger();
  }));
  body.querySelectorAll('[data-a=accept],[data-a=reject]').forEach(btn => btn.addEventListener('click', async () => {
    const verdict = btn.dataset.a === 'accept' ? 'accepted' : 'rejected';
    try { await dp.searchVerdict(btn.dataset.id, verdict); toast(verdict === 'accepted' ? '已认可' : '已划除', 'ok'); await refreshLedger(); }
    catch (err) { toast(errText(err), 'error'); }
  }));
}
// 账本增量刷新（面板开着时每次落账推送一次）
dp.on('search:ledger-changed', () => { if (ledgerModalBody) refreshLedger(); });

// ---------- 导出 / 清空 ----------
async function doExport() {
  try {
    const saved = await dp.chatExport(tab);
    if (saved) toast('已导出：' + saved, 'ok');
  } catch (err) { toast(errText(err), 'error'); }
}
async function doClear() {
  if (!histories[tab].length) return;
  const sess = sessionInfo.sessions.find(s => s.id === sessionInfo.activeSessionId);
  const label = tab === 'roleplay' && sess ? `会话「${sess.name}」` : (tab === 'roleplay' ? '当前会话' : '「快问」');
  if (!(await confirmBox(`清空${label}的全部聊天记录？（只清这一条时间线，其他会话与长期记忆不受影响）`, { danger: true, okText: '清空' }))) return;
  histories[tab] = [];
  await dp.chatSaveHistory(tab, []);
  renderAll();
}

// ---------- 启动 ----------
(async function boot() {
  await initTheme();
  await refreshSessions();
  histories.roleplay = await dp.chatHistory('roleplay');
  histories.quick = await dp.chatHistory('quick');
  try {
    const api = await dp.storeGet('api');
    if (api.model) main.querySelector('#modelTag').textContent = '模型：' + api.model + (api.hasKey ? '' : '（未配置 Key）');
    else main.querySelector('#modelTag').textContent = '尚未配置 API（设置 → API）';
  } catch (_) {}
  try {
    const s = await dp.storeGet('settings');
    permModeSel.value = (s.agent && s.agent.permissionMode) || 'read';
  } catch (_) {}
  loadInterrupted();
  renderAll();
  input.focus();
})();
