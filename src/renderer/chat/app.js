// 聊天窗：角色扮演 / 快问两标签、流式渲染、停止/重生成、日程确认条、启动器本地匹配
// v0.3：节拍按句触发宠物表情、agent 步骤时间线、写权限卡、diff 卡、中断任务提示条
import { dp, initTheme, esc, errText, uid } from '../common/ipc.js';
import { renderMD } from '../common/md.js';
import { toast, confirmBox, openModal, skeletonBlock } from '../common/ui.js';
import { icon } from '../common/icons.js';
import { renderPet } from '../pet/sprite.js';

const EMO_LABEL = { normal: '平常', happy: '开心', surprised: '惊讶', angry: '愤怒', thinking: '思考', sad: '悲伤' };
const SCHEDULE_RE = /^(提醒我|帮我记一下|记一下|添加日程|加个日程)/;
// 斜杠命令：长期记忆管理面板（与主进程 memory.js 同款；角色无感知）
const MEMORY_CMD_RE = /^\s*\/\s*deep\s+memory\s+forcing\s*$/i;
// 斜杠命令：用户身份档案面板 / 搜索账本面板 / 记忆整理纪律查看（开发版；与主进程同款正则，角色无感知）
const PROFILE_CMD_RE = /^\s*\/\s*user\s+profile\s*$/i;
const SEARCH_CMD_RE = /^\s*\/\s*search\s+ledger\s*$/i;
const DISCIPLINE_CMD_RE = /^\s*\/\s*discipline\s*$/i;
// 斜杠命令：token 看板面板（/tokens 或 /token；角色无感知，不入史不进 LLM）
const TOKEN_CMD_RE = /^\s*\/\s*tokens?\s*$/i;
// 斜杠命令：演示模式 /demo 族（进入/off/status/speed；状态权威在主进程，不入史不进 LLM）
const DEMO_CMD_RE = /^\s*\/\s*demo\b/i;

let tab = 'roleplay';
let streaming = null;           // { tab, el, raw, steps, changes, permTimers, sessionId }
let histories = { roleplay: [], quick: [] };
let sessionInfo = { activeSessionId: '', sessions: [] }; // v0.5 多会话（仅 roleplay）
let spriteSlots = {};           // 表情差分图槽位（空态角色用；boot 时取一次）
let avatarState = { user: null }; // 对话对象头像（设置→人设→对话对象上传）
// 演示模式（v0.6.2，会话级）：主进程是权威，这里只存副本供打字机/徽标用
let demoState = { on: false, rounds: 0, speed: 300, sessionId: '' };

const app = document.getElementById('app');

// ---------- 合并顶栏：分段标签 + 会话胶囊 + 动作区 + 窗口按钮（高度 44px） ----------
const topbar = document.createElement('div');
topbar.className = 'chat-topbar';
topbar.innerHTML = `
  <div class="seg" role="tablist" aria-label="聊天模式">
    <div class="seg-item" data-tab="roleplay" role="tab" tabindex="0" aria-selected="true">${icon('message', 15)}<span>角色扮演</span></div>
    <div class="seg-item" data-tab="quick" role="tab" tabindex="0" aria-selected="false">${icon('bolt', 15)}<span>快问</span></div>
  </div>
  <button class="tb-session" id="sessionBtn" title="切换会话（切换前会自动固化未提取的记忆）">
    <span class="ss-kind" id="sessionKind">主</span>
    <span class="ss-name" id="sessionName">主对话</span>
    <span class="ss-count" id="sessionCount"></span>
    ${icon('chevronD', 14)}
  </button>
  <span class="tb-demo" id="demoBadge" hidden title="演示模式进行中：主动推进 / 术语必附短解 / 回复提速 / 打字机显示。/demo off 退出，/demo status 看状态"></span>
  <span class="tb-spacer"></span>
  <div class="tb-actions">
    <button class="win-btn" id="norekiMailBtn" title="NOREKI-Mail 信箱：克莉奥（clio@hermes）的来信。点按查看——信文将进入对话，缇托即可读信回应">${icon('mail', 16)}<span id="norekiMailBadge" class="mail-badge" style="display:none">0</span></button>
    <button class="win-btn" id="exportBtn" title="导出当前会话为 Markdown">${icon('upload', 16)}</button>
    <button class="win-btn" id="clearBtn" title="清空当前会话">${icon('sweep', 16)}</button>
    <span class="tb-sep"></span>
    <button class="win-btn" id="minBtn" title="最小化">${icon('minimize', 16)}</button>
    <button class="win-btn close" id="closeBtn" title="关闭">${icon('close', 16)}</button>
  </div>`;
app.appendChild(topbar);

const segEl = topbar.querySelector('.seg');
const sessionBtn = topbar.querySelector('#sessionBtn');
topbar.querySelector('#minBtn').addEventListener('click', () => dp.minimizeWindow());
topbar.querySelector('#closeBtn').addEventListener('click', () => window.close());
topbar.querySelector('#exportBtn').addEventListener('click', () => doExport());
topbar.querySelector('#clearBtn').addEventListener('click', () => doClear());

// 信箱：未读徽标刷新 + 查看动作（v1.5）
async function refreshMailBadge() {
  try {
    const s = await dp.norekiMailbox();
    const badge = document.getElementById('norekiMailBadge');
    if (!badge) return;
    badge.textContent = String(s.unreadCount || 0);
    badge.style.display = s.unreadCount > 0 ? '' : 'none';
  } catch (_) {}
}
document.getElementById('norekiMailBtn').addEventListener('click', async () => {
  try {
    const r = await dp.norekiRead();
    if (r.delivered > 0) {
      await reloadRoleplay();
      toast(`已收取 ${r.delivered} 封来信（信文已进入对话，缇托可以读信回应了）`, 'ok');
    } else {
      toast('信箱没有未读来信', 'ok', 1500);
    }
    refreshMailBadge();
  } catch (err) { toast(errText(err), 'error'); }
});
dp.on('noreki:mail', () => refreshMailBadge());
// 设置页换了/清空头像 → 本窗消息头像即时更新
dp.on('avatar:changed', (st) => { avatarState = st || { user: null }; renderAll(); });

const main = document.createElement('div');
main.className = 'chat-wrap';
main.innerHTML = `
  <div class="interrupt-slot" id="interruptSlot"></div>
  <div class="msg-list" id="list"></div>
  <div class="composer">
    <div class="composer-box">
      <textarea id="input" placeholder="和宠物聊天…（「打开xx」可直接启动程序；「提醒我明天9点开会」直达日程）" rows="1"></textarea>
      <div class="composer-bar">
        <div class="perm-seg" id="permSeg" role="group" aria-label="宠物文件权限（对下一次任务生效）">
          <button type="button" data-v="read" aria-pressed="true" title="只读：只能读取和列目录，不能写文件">${icon('lock', 12)}只读</button>
          <button type="button" data-v="userData" aria-pressed="false" title="可编辑：可写应用数据目录（deskpal 文件夹）及其子目录">${icon('pencil', 12)}可编辑</button>
          <button type="button" data-v="full" aria-pressed="false" title="完全编辑：可读写本机大部分目录（核心系统目录除外），每次写入需在权限卡批准">${icon('shield', 12)}完全</button>
        </div>
        <span class="model-tag" id="modelTag"></span>
        <button class="btn btn-sm btn-icon" id="stopBtn" style="display:none" title="停止生成">${icon('stop', 16)}</button>
        <button class="btn btn-sm btn-primary" id="sendBtn" title="发送（Enter）">${icon('send', 15)}发送</button>
      </div>
    </div>
  </div>`;
app.appendChild(main);

const list = main.querySelector('#list');
const input = main.querySelector('#input');
const sendBtn = main.querySelector('#sendBtn');
const stopBtn = main.querySelector('#stopBtn');
const permSeg = main.querySelector('#permSeg');

// ---------- 权限模式（三档：只读/可编辑/完全编辑，对下一次任务生效） ----------
function setPermMode(v) {
  permSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
}
permSeg.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-v]');
  if (!btn) return;
  const v = btn.dataset.v;
  setPermMode(v);
  try {
    await dp.storeSet('settings', { agent: { permissionMode: v } });
    const label = { read: '只读', userData: '可编辑（数据目录内）', full: '完全编辑（大部分目录，逐次批准）' }[v];
    toast(`权限已切换：${label}（下一次任务生效）`, 'ok');
  } catch (err) { toast(errText(err), 'error'); }
});

// ---------- 标签切换 ----------
function switchTabTo(next) {
  tab = next;
  segEl.querySelectorAll('.seg-item').forEach(x => x.setAttribute('aria-selected', String(x.dataset.tab === tab)));
  sessionBtn.hidden = tab !== 'roleplay';
  input.placeholder = tab === 'quick'
    ? '快问快答：直接问，我简洁回答（可以问知识、代码、命令…）'
    : '和宠物聊天…（「打开xx」可直接启动程序；「提醒我明天9点开会」直达日程）';
  renderAll();
}
segEl.addEventListener('click', (e) => {
  const t = e.target.closest('.seg-item');
  if (t) switchTabTo(t.dataset.tab);
});
segEl.addEventListener('keydown', (e) => {
  const t = e.target.closest('.seg-item');
  if (!t) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTabTo(t.dataset.tab); }
});

// ---------- 会话胶囊（主对话 + 专项会话，切换前主进程先固化未提取记忆） ----------
function renderSessions() {
  const cur = sessionInfo.sessions.find(s => s.id === sessionInfo.activeSessionId);
  if (cur) {
    topbar.querySelector('#sessionKind').textContent = cur.kind === 'main' ? '主' : '专';
    topbar.querySelector('#sessionName').textContent = cur.name;
    topbar.querySelector('#sessionCount').textContent = cur.msgCount ? `${cur.msgCount} 条` : '';
  }
  if (sessionMenuEl) openSessionMenu(true); // 菜单开着时同步刷新
}

async function refreshSessions() {
  try { sessionInfo = await dp.chatSessions(); renderSessions(); } catch (_) {}
}

async function reloadRoleplay() {
  histories.roleplay = await dp.chatHistory('roleplay');
  await refreshSessions();
  await refreshDemoState();
  renderAll();
}

// ---------- 演示模式（v0.6.2）：/demo 命令 + 徽标 + 打字机显示 ----------
function renderDemoBadge() {
  const b = topbar.querySelector('#demoBadge');
  if (!b) return;
  if (demoState.on) {
    b.hidden = false;
    b.textContent = `演示中 · ${demoState.rounds} 轮 · ${demoState.speed} 字/分`;
  } else {
    b.hidden = true;
  }
}
async function refreshDemoState() {
  try { demoState = await dp.demoState(); } catch (_) { return; }
  renderDemoBadge();
}
// 主进程执行命令 → 回执落本地状态；开/关切换时主进程已落「系统事件」入史，这里刷新历史
async function applyDemoResult(r) {
  if (r && r.state) demoState = r.state;
  renderDemoBadge();
  if (r && r.message) toast(r.message, r.ok === false ? 'error' : 'ok', 4200);
  if (r && r.changed && r.transition) await reloadRoleplay().catch(() => {});
}
async function runDemoCommand(text) {
  input.value = ''; autoGrow();
  try { await applyDemoResult(await dp.demoCommand(text)); }
  catch (err) { toast(errText(err), 'error'); }
}

// 打字机：演示模式的回复不再流式弹出——正文收齐（llm:done）后按 每分钟字数 逐字显示。
// 任何 renderAll（新消息/切标签/切会话）都会打断并把全文立即落定；速率按挂钟时间推进
// （tab 间隔不均匀也不影响总时长），每 tick 重渲染 markdown 保证中途排版正确。
let typer = null; // { timer, finish }
function stopTyper(runFinish = true) {
  if (!typer) return;
  clearTimeout(typer.timer);
  const fin = typer.finish;
  typer = null;
  if (runFinish && fin) fin();
}
function startTyper(el, text, onDone) {
  stopTyper(false);
  const body = el.querySelector('.body');
  if (!body) { onDone(); return; }
  const rate = Math.max(1, demoState.speed || 300) / 60000; // 字/毫秒
  let pos = 0, shown = -1, last = performance.now();
  const finish = () => { typer = null; onDone(); };
  const step = () => {
    const now = performance.now();
    pos = Math.min(text.length, pos + (now - last) * rate);
    last = now;
    const n = Math.floor(pos);
    if (n !== shown) {
      shown = n;
      body.innerHTML = renderMD(text.slice(0, n)) + (n < text.length ? '<span class="streaming-cursor"></span>' : '');
      scrollBottom();
    }
    if (n >= text.length) finish();
    else if (typer) typer.timer = setTimeout(step, 40);
  };
  typer = { timer: setTimeout(step, 40), finish: onDone };
}

let sessionMenuEl = null;
function closeSessionMenu() {
  if (!sessionMenuEl) return;
  sessionMenuEl.remove();
  sessionMenuEl = null;
  document.removeEventListener('mousedown', onDocDown, true);
}
function onDocDown(e) {
  if (sessionMenuEl && !sessionMenuEl.contains(e.target) && !sessionBtn.contains(e.target)) closeSessionMenu();
}

async function switchSession(id) {
  if (!id || id === sessionInfo.activeSessionId) { closeSessionMenu(); return; }
  if (streaming && streaming.tab === 'roleplay') {
    toast('正在生成中，等这轮结束再切换会话', 'warn');
    return;
  }
  try {
    await dp.chatSessionSwitch(id);
    await reloadRoleplay();
    const cur = sessionInfo.sessions.find(s => s.id === sessionInfo.activeSessionId);
    toast(`已切换到「${cur ? cur.name : ''}」（切换前已固化未提取的记忆）`, 'ok');
  } catch (err) { toast(errText(err), 'error'); renderSessions(); }
}

function openSessionMenu(toggleOnly = false) {
  if (sessionMenuEl) { closeSessionMenu(); if (toggleOnly) return; return; }
  if (toggleOnly) return;
  const menu = document.createElement('div');
  menu.className = 'tb-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = (sessionInfo.sessions.length ? sessionInfo.sessions.map(s => `
      <div class="sm-item ${s.id === sessionInfo.activeSessionId ? 'active' : ''}" data-id="${esc(s.id)}" role="menuitem" tabindex="0">
        <span class="ss-kind">${s.kind === 'main' ? '主' : '专'}</span>
        <span class="ss-name">${esc(s.name)}</span>
        <span class="ss-count">${s.msgCount} 条</span>
        ${s.id === sessionInfo.activeSessionId ? icon('check', 14) : ''}
      </div>`).join('') : '<div class="sm-empty">暂无会话</div>')
    + `<div class="sm-foot">
        <button class="btn btn-sm" data-act="new">${icon('plus', 14)}专项会话</button>
        <button class="btn btn-sm" data-act="edit">${icon('pencil', 14)}重命名</button>
        <span class="grow"></span>
        <button class="btn btn-sm btn-icon" data-act="del" title="删除当前专项会话（主对话不可删）">${icon('trash', 16)}</button>
      </div>`;
  document.body.appendChild(menu);
  const r = sessionBtn.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - h - 8)) + 'px';
  sessionMenuEl = menu;
  document.addEventListener('mousedown', onDocDown, true);
  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('.sm-item');
    if (item) { closeSessionMenu(); switchSession(item.dataset.id); return; }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const a = act.dataset.act;
    closeSessionMenu();
    if (a === 'new') {
      if (streaming && streaming.tab === 'roleplay') return toast('正在生成中，稍后再新建', 'warn');
      openSessionModal('new');
    } else if (a === 'edit') {
      const cur = sessionInfo.sessions.find(s => s.id === sessionInfo.activeSessionId);
      if (cur) openSessionModal('edit', cur);
    } else if (a === 'del') {
      const cur = sessionInfo.sessions.find(s => s.id === sessionInfo.activeSessionId);
      if (!cur || cur.kind === 'main') return toast('主对话不可删除', 'warn');
      if (!(await confirmBox(`删除专项会话「${cur.name}」？其中未提取记忆的对话内容将一并丢弃（已入长期记忆的不受影响）。`, { danger: true, okText: '删除' }))) return;
      try {
        await dp.chatSessionDelete(cur.id);
        await reloadRoleplay();
        toast('已删除（活跃会话回到主对话）', 'ok');
      } catch (err) { toast(errText(err), 'error'); }
    }
  });
  menu.addEventListener('keydown', (e) => {
    const item = e.target.closest('.sm-item');
    if (item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); closeSessionMenu(); switchSession(item.dataset.id); }
    if (e.key === 'Escape') closeSessionMenu();
  });
}
sessionBtn.addEventListener('click', () => openSessionMenu());

// 新建/编辑会话弹窗：名称 + 一句话主题（主题会注入角色上下文的【当前会话】卡）
function openSessionModal(mode, cur = null) {
  const { body, close } = openModal({ title: mode === 'new' ? '新建专项会话' : '会话设置', width: '460px' });
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

// ---------- 头像 ----------
// 助手头像 = 仓库根 icon.png（随包分发的角色画）；用户头像 = 设置里上传到数据目录的图片。
const ASSISTANT_AVATAR = '../../icon.png';
function fileUrl(p) { return 'file:///' + String(p).replace(/\\/g, '/'); }
function userAvatarHtml() {
  const u = avatarState && avatarState.user;
  return u && u.path
    ? `<img class="avatar-img" src="${esc(fileUrl(u.path))}" alt="我的头像" draggable="false">`
    : icon('user', 16);
}
function assistantAvatarHtml() {
  const a = avatarState && avatarState.assistant;
  const src = a && a.path ? fileUrl(a.path) : ASSISTANT_AVATAR;
  return `<img class="avatar-img" src="${esc(src)}" alt="缇托" draggable="false">`;
}

// ---------- 消息渲染 ----------
function fmtClock(at) {
  if (!at) return '';
  const d = new Date(at);
  if (isNaN(d)) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function msgEl(m, group = 'solo') {
  const el = document.createElement('div');
  // 演示模式开/关的系统事件注入（主进程 pushDemoNote）：按居中系统提示条渲染（角色无头像）
  if (m.demoNote) {
    el.className = 'msg system-notice';
    el.dataset.id = m.id;
    el.dataset.group = group;
    el.innerHTML = `<div class="bubble">${icon(m.demoNote === 'off' ? 'xCircle' : 'play', 12)} ${esc(m.content)}</div>`;
    return el;
  }
  const kind = m.role === 'user' ? 'user' : m.role === 'system' ? 'system-notice' : m.error ? 'error' : 'assistant';
  // 戏外工作轮（/order 打标）消息 highlight（用户决策 2026-09-29）：真话边界整轮标亮
  el.className = 'msg ' + kind + (m.work ? ' work' : '') + (m.mailInject ? ' noreki-mail' : '');
  el.dataset.id = m.id;
  el.dataset.group = group;
  // 信纸卡（v1.5）：NOREKI-Mail 注入消息——头像换成信封，气泡加信头
  if (m.mailInject) {
    const mi = m.mailInject;
    el.innerHTML = `
      <div class="avatar">${icon('mail', 16)}</div>
      <div class="msg-main"><div class="bubble mail-card">
        <div class="mail-head">来信 · ${esc(mi.from)} <span class="mail-meta">｜${esc(mi.kind)}｜${esc(mi.sentAt)}</span></div>
        <div class="md body">${renderMD(m.content || '')}</div>
      </div></div>`;
    return el;
  }
  const isAssistant = m.role === 'assistant';
  const bodyHTML = m.error || m.role === 'system'
    ? esc(m.content)
    : renderMD(m.content || '');
  // 本轮 API 消耗（模型用量回执汇总；供应商未报用量时不显示）
  const usageText = isAssistant ? usageMeterText(m.usage) : '';
  const usageHtml = usageText
    ? `<span class="token-meter" title="本轮 API 消耗（上游用量回执汇总，仅供参考）">${esc(usageText)}</span>` : '';
  const opsHtml = m.role !== 'system'
    ? `<div class="ops">
        <button data-op="copy" title="复制">${icon('copy', 15)}</button>
        <button data-op="del" title="删除">${icon('trash', 15)}</button>
        ${isAssistant ? `<button data-op="regen" title="重新生成">${icon('refresh', 15)}</button>` : ''}
      </div>` : '';
  const timeTxt = fmtClock(m.at);
  const footBits = [];
  if (timeTxt) footBits.push(`<span class="mf-time">${timeTxt}</span>`);
  if (m.emotion) {
    footBits.push(`<span class="emo-dot ${m.emotion}" title="${EMO_LABEL[m.emotion] || ''}"></span>`);
    footBits.push(`<span class="emo-label">${EMO_LABEL[m.emotion] || ''}</span>`);
  }
  if (usageHtml) footBits.push(usageHtml);
  const footHtml = footBits.length
    ? `<div class="msg-foot">${footBits.join('<span class="mf-sep">·</span>')}</div>` : '';
  el.innerHTML = `
    ${m.role === 'system' ? '' : `<div class="avatar">${m.role === 'user' ? userAvatarHtml() : assistantAvatarHtml()}</div>`}
    <div class="msg-main">
      <div class="bubble">
        ${opsHtml}
        ${m.work ? '<div class="work-tag">戏外 · 工作轮</div>' : ''}
        <div class="md body">${bodyHTML}</div>
        <div class="agent-area"></div>
        <div class="sch-slot"></div>
      </div>
      ${footHtml}
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
  box.innerHTML = `${icon('calendar', 14)} 检测到日程：${esc(s.title)} · ${tText}
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
        box.innerHTML = `${icon('checkCircle', 14)} 已加入日程，到时间我会提醒你哦～`;
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
const PHASE_ICON = { 设计: 'pencil', 发现: 'search', 能力: 'sliders', 验证: 'checkCircle' };

// 步骤时间线（progress + tool + permission + notice 共用；llm 轮只在台账、不上时间线）
// notice 徽章按类型分化：重试 / 搜索开启 / 搜索日限
function noticeBadge(n) {
  if (n === 'search_enabled') return { icon: 'search', label: '搜索' };
  if (n === 'search_limit') return { icon: 'xCircle', label: '日限' };
  return { icon: 'refresh', label: '重试' };
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
  box.innerHTML = `<summary>${icon('sliders', 14)} 执行过程（${visible.length} 步）</summary>
    <div class="steps-body">${visible.map(s => {
      if (s.kind === 'progress') return `<div class="step"><span class="badge p">${icon(PHASE_ICON[s.phase] || 'dot', 11)} ${esc(s.phase || '')}</span><span>${esc(s.text || '')}</span></div>`;
      if (s.kind === 'tool') return `<div class="step"><span class="badge t">${icon('terminal', 11)} ${esc(s.tool || '')}</span><span class="${s.ok === false ? 'step-fail' : ''}">${esc(s.summary || '')}${s.ok === false ? ` ${icon('close', 11)}` : ` ${icon('check', 11)}`}</span></div>`;
      if (s.kind === 'permission') return `<div class="step"><span class="badge s">${icon('shield', 11)} 权限</span><span>${decisionText(s.decision)}</span></div>`;
      if (s.kind === 'notice') { const nb = noticeBadge(s.notice); return `<div class="step"><span class="badge n">${icon(nb.icon, 11)} ${nb.label}</span><span>${esc(s.text || '')}</span></div>`; }
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
    <div class="perm-head">${icon('shield', 14)} 写入批准请求 <span class="perm-action">${esc(req.action)}</span></div>
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
    <summary>${icon('folder', 14)} 文件变更（${changed.length}）</summary>
    <div class="diff-note">以下变更由 deskpal 前后快照实测得出，非模型自述</div>
    ${hasAmbiguous ? `<div class="diff-warn">${icon('alert', 12)} 检测到工具声明之外的变更，请人工确认</div>` : ''}
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
    box.innerHTML = `<span>${icon('alert', 14)} 上次有个任务被中断</span><button class="btn btn-sm" data-a="view">查看</button>`;
    box.addEventListener('click', (e) => {
      if (!(e.target.dataset && e.target.dataset.a === 'view')) return;
      if (box.dataset.expanded) { box.remove(); return; }
      box.dataset.expanded = '1';
      const d = new Date(last.at || '');
      const stepLines = (last.steps || []).map(s => {
        if (s.kind === 'progress') return `[${s.phase}] ${s.text}`;
        if (s.kind === 'tool') return `· ${s.tool} ${s.summary || ''} ${s.ok === false ? '（失败）' : '（成功）'}`;
        if (s.kind === 'permission') return `权限：${decisionText(s.decision)}`;
        if (s.kind === 'llm') return `· 第 ${s.round} 轮（${s.finishReason}）`;
        return '';
      }).filter(Boolean).join('\n') || '（无步骤记录）';
      box.innerHTML = `
        <div class="ib-title">${icon('alert', 14)} 上次有个任务被中断（${esc(isNaN(d) ? String(last.at || '') : d.toLocaleString())}）</div>
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

const GROUP_GAP_MS = 5 * 60 * 1000;
function groupOf(hist, i) {
  const m = hist[i], p = hist[i - 1], n = hist[i + 1];
  const same = (a, b) => a && b && a.role === b.role && !a.error && !b.error
    && a.role !== 'system' && !a.mailInject && !b.mailInject && !a.demoNote && !b.demoNote
    && Math.abs(new Date(b.at || 0) - new Date(a.at || 0)) < GROUP_GAP_MS;
  const up = same(p, m), down = same(m, n);
  return up && down ? 'mid' : up ? 'end' : down ? 'start' : 'solo';
}

function renderAll() {
  stopTyper(false); // 外部重渲染会拆掉打字中的气泡——先停动画，完整正文由历史渲染补上
  list.innerHTML = '';
  const hist = histories[tab];
  if (!hist.length) {
    const sess = sessionInfo.sessions.find(s => s.id === sessionInfo.activeSessionId);
    const sessName = tab === 'roleplay' && sess ? `「${sess.name}」` : '';
    list.innerHTML = `<div class="empty">
      <div class="empty-ic" id="emptyPet"></div>
      <div class="empty-title">${tab === 'roleplay' ? `这是${sessName}的开头` : '问点什么，我直接回答'}</div>
      <div class="empty-desc">${tab === 'roleplay' ? '和你的宠物聊聊吧——重要的事它会记住。' : '快问快答，不写入长期记忆。'}</div>
    </div>`;
    const pet = list.querySelector('#emptyPet');
    if (pet) renderPet(pet, 'happy', spriteSlots.happy || { mode: 'svg' });
    return;
  }
  hist.forEach((m, i) => list.appendChild(msgEl(m, groupOf(hist, i))));
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
    if (TOKEN_CMD_RE.test(text)) {
      input.value = ''; autoGrow(); openTokenBoard(); return;
    }
    if (DEMO_CMD_RE.test(text)) { runDemoCommand(text); return; }
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
  el.className = 'msg assistant streaming enter';
  el.dataset.group = 'solo';
  el.innerHTML = `<div class="avatar">${assistantAvatarHtml()}</div>
    <div class="msg-main"><div class="bubble"><div class="md body"><span class="thinking-dots"><i></i><i></i><i></i></span></div><div class="agent-area"></div><div class="sch-slot"></div></div></div>`;
  list.appendChild(el);
  scrollBottom();

  streaming = { tab, el, raw: '', reqId: undefined, steps: [], changes: null };
  setStreamUI(true);

  try {
    const res = await dp.chatSend(tab, text);
    // 主进程兜底命中斜杠命令（渲染层正则失效时）：撤销本地用户消息与流式气泡，按命令类型接管
    if (res && (res.memoryCommand || res.profileCommand || res.ledgerCommand || res.disciplineCommand || res.tokenBoardCommand || res.demoCommand)) {
      streaming = null;
      setStreamUI(false);
      el.remove();
      const ui = histories[tab].findIndex(x => x.role === 'user' && x.content === text);
      if (ui >= 0) { histories[tab].splice(ui, 1); renderAll(); }
      if (res.disciplineCommand) openDisciplineModal();
      if (res.tokenBoardCommand) openTokenBoard();
      if (res.demoCommand) applyDemoResult(res.demo);
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
  // 演示模式：正文不随流弹出（收齐后由打字机逐字显示）；节拍照常触发宠物表情
  if (!(demoState.on && t === 'roleplay')) {
    const body = streaming.el.querySelector('.body');
    body.innerHTML = renderMD(streaming.raw) + '<span class="streaming-cursor"></span>';
    scrollBottom();
  }
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
  // 演示模式：正文收齐后不立即落定——在原气泡里按打字机逐字显示，播完再做常规
  // 刷新+重渲染（中途任何 renderAll 会打断并直接显示全文）。停止/出错半截不走打字机。
  const demoType = demoState.on && t === 'roleplay' && !aborted && typeof clean === 'string' && clean.trim();
  const settle = async () => {
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
  };
  if (demoType) {
    refreshDemoState(); // 轮次在主进程 send 时已 +1，取回最新数刷新徽标
    // 吐字前清空执行区（演示态下至多剩已决权限卡；倒计时 interval 先停防泄漏）——
    // 吐字期间气泡只有正文；吐完 settle→renderAll 一次性带出时间线与 diff 卡
    const area = el.querySelector('.agent-area');
    if (area) {
      area.querySelectorAll('.perm-card').forEach(pc => { if (pc._dpTimer) { clearInterval(pc._dpTimer); pc._dpTimer = null; } });
      area.innerHTML = '';
    }
    startTyper(el, raw, settle);
    return;
  }
  await settle();
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
// 演示模式的执行过程/diff 卡不随流实时上屏：正文还在打字机吐字时子卡片先冒出来，
// 吐字区随内容增长下移、难以定位阅读（20261026 用户反馈）。改为——演示态下步骤/
// 变更只入 streaming.steps/changes 缓存，吐字完成后的 settle→renderAll 一次性带出
// 时间线与 diff 卡（顺序=先吐字、后瞬间展示子卡片）。权限卡例外：它是阻塞运行的
// 交互组件（等待用户点击），必须实时可见可点，不参与抑制。
function demoSuppressExtras(t) { return demoState.on && t === 'roleplay'; }

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
  if (demoSuppressExtras(d.tab)) return; // 演示态：缓存进 steps，吐字后再展示
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
  if (demoSuppressExtras(d.tab)) return; // 演示态：只缓存，吐字后随 settle 展示
  renderDiffCard(streaming.el.querySelector('.agent-area'), streaming.changes);
  scrollBottom();
});

dp.on('agent:done', (d) => {
  // run 收尾（含 aborted）：diff 卡兜底刷新；llm:done 随后关闭流式状态
  if (!streaming || streaming.tab !== d.tab) return;
  if (streaming.reqId && d.reqId !== streaming.reqId) return;
  if (d.changes && d.changes.length) {
    streaming.changes = d.changes;
    if (!demoSuppressExtras(d.tab)) renderDiffCard(streaming.el.querySelector('.agent-area'), streaming.changes);
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
  const { body } = openModal({ title: '长期记忆 · 角色无感知', width: '680px' });

  async function refresh() {
    let items = [], coreUsage = { used: 0, budget: 1000 }, archive = [];
    try {
      [items, coreUsage, archive] = await Promise.all([dp.memoryList(), dp.memoryCoreUsage(), dp.memoryArchiveList().catch(() => [])]);
    } catch (err) { toast(errText(err), 'error'); }
    body.innerHTML = `
      <p class="hint" style="margin:4px 0 10px">宠物的长期记忆，分三层：<b>core</b>（身份级认知，全量每轮注入，共 ${coreUsage.used}/${coreUsage.budget} 字，不自动淘汰）、<b>working</b>（滚动记忆，最近 8 条注入）、<b>ephemeral</b>（限时事件，默认 14 天过期进归档，不注入）。本面板的查看/添加/删除/改层/恢复归档不进聊天记录，角色不会察觉。打开本面板时会自动补提取未入库的近期对话。</p>
      <div class="mem-add">
        <select id="memType">${Object.entries(MEM_TYPE_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <select id="memImp" title="重要性">${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n} 级${n === 5 ? '（最高）' : n === 1 ? '（最低）' : ''}</option>`).join('')}</select>
        <select id="memScope">${Object.entries(MEM_SCOPE_LABEL).map(([v, l]) => `<option value="${v}" ${v === 'working' ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input id="memContent" type="text" maxlength="60" placeholder="新增记忆内容（≤60字）…">
        <button class="btn btn-sm btn-primary" id="memAddBtn">添加</button>
      </div>
      <div class="mem-list">
        ${items.length ? items.map(it => `
          <div class="mem-item">
            <div class="mem-main">
              <span class="mem-type t-${esc(it.type)}">${MEM_TYPE_LABEL[it.type] || esc(it.type)}</span>
              ${it.demo ? '<span class="badge a" title="该条来自演示模式对话（demo 来源标记）">demo</span>' : ''}
              <select class="mem-scope-sel" data-id="${esc(it.id)}" title="记忆层级">${Object.entries(MEM_SCOPE_LABEL).map(([v, l]) => `<option value="${v}" ${it.scope === v ? 'selected' : ''}>${l.split('·')[0]}</option>`).join('')}</select>
              <span class="mem-imp" title="重要性 ${it.importance}/5">${Math.max(1, Math.min(5, it.importance || 1))}/5</span>
              <span class="mem-content" title="${esc(it.content)}">${esc(it.content)}</span>
              ${it.note ? `<span class="hint" title="${esc(it.note)}">${icon('alert', 12)}</span>` : ''}
            </div>
            <div class="mem-side">
              <span class="small muted">${esc(String(it.createdAt || '').slice(0, 10))}</span>
              <button class="btn btn-sm btn-danger" data-del="${esc(it.id)}">删除</button>
            </div>
          </div>`).join('')
        : '<p class="hint" style="text-align:center;padding:18px 0">暂无长期记忆——聊到重要信息（每 6 条用户消息 / 会话冷却后 / 打开本面板时）会自动提取；角色也会在你说「记住…」时主动写入。也可在上方手动添加。</p>'}
      </div>
      <details class="mem-archive" ${archive.length ? '' : 'hidden'}>
        <summary>${icon('layers', 13)} 淘汰归档（${archive.length}）——过期/库满时移出的记忆，可恢复</summary>
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
  const { body } = openModal({ title: '用户身份档案 · 角色无感知', width: '680px' });
  profileModalBody = body;
  body.innerHTML = `<div style="padding:12px">${skeletonBlock(3)}<p class="hint">如有未漂移的新消息，会先补跑一次提取</p></div>`;
  let doc;
  try { doc = await dp.profileGet(); } catch (err) { body.innerHTML = `<p class="hint">加载失败：${esc(errText(err))}</p>`; return; }
  renderProfile(doc);

  function kvRows(layer, obj) {
    return Object.entries(obj || {}).map(([k, v]) => `
      <div class="row prof-kv" data-layer="${layer}" style="gap:6px;margin:4px 0">
        <input type="text" class="pf-key" value="${esc(k)}" maxlength="12" style="width:120px" placeholder="字段名">
        <input type="text" class="pf-val" value="${esc(v)}" maxlength="240" style="flex:1" placeholder="内容">
        <button class="btn btn-sm btn-icon" data-a="del-kv" title="删除">${icon('trash', 15)}</button>
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
        <button class="btn btn-sm" id="pf-import">${icon('download', 14)} 导入预填文件（senpai-model 全量字段，只补空缺不覆盖）</button>
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
        <button class="btn btn-primary btn-sm" id="pf-save">${icon('save', 14)} 保存档案</button>
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
      <div id="pf-archive" class="pf-log" style="max-height:160px;overflow:auto"><div style="padding:8px 0">${skeletonBlock(2)}</div></div>`;

    // 交互：加/删字段行
    body.querySelectorAll('[data-a=add-kv]').forEach(btn => btn.addEventListener('click', () => {
      const L = btn.dataset.layer;
      const host = body.querySelector('#pf-' + L);
      const row = document.createElement('div');
      row.className = 'row prof-kv';
      row.dataset.layer = L;
      row.style.cssText = 'gap:6px;margin:4px 0';
      row.innerHTML = `<input type="text" class="pf-key" maxlength="12" style="width:120px" placeholder="字段名"><input type="text" class="pf-val" maxlength="160" style="flex:1" placeholder="内容"><button class="btn btn-sm btn-icon" data-a="del-kv" title="删除">${icon('trash', 15)}</button>`;
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
        res.textContent = `已新增 P0 ${r.added.P0} / P1 ${r.added.P1} / P2 ${r.added.P2} / P2b ${r.added.P2b} / P3 ${r.added.P3} 字段（已有值未动）`;
        toast('预填导入完成', 'ok');
        doc = await dp.profileGet();
        renderProfile(doc);
      } catch (err) { res.textContent = '失败：' + errText(err); toast(errText(err), 'error'); }
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
const STATUS_CN = { ok: '成功', blocked: '拦截', denied: '拒绝', failed: '失败', cached: '缓存' };
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
  const { body } = openModal({ title: '记忆整理纪律 · 角色无感知', width: '640px' });
  body.innerHTML = `<div style="padding:12px">${skeletonBlock(3)}</div>`;
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
  const { body } = openModal({ title: '联网搜索账本 · 角色无感知', width: '700px' });
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
    <p class="hint" style="margin:4px 0 10px">每一次检索（含被拦截/被拒/失败/缓存）都落账。自主轨条目可裁决：「认可」计入有效产出；「划除」后角色汇报时须表述为「已作废」。「轨道存疑」= 自报指定轨但当轮指令与查询词重合度低，建议抽查。花费为应用层估算 token（搜索源多不返回精确用量）。</p>
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
              <button class="btn btn-sm btn-primary" data-a="accept" data-id="${esc(e.id)}">${icon('check', 13)} 认可</button>
              <button class="btn btn-sm" data-a="reject" data-id="${esc(e.id)}">${icon('close', 13)} 划除</button>
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

// ---------- Token 看板面板（/tokens；角色无感知） ----------
// 数据：本地扫描 11 个 AI 工具 + deskpal 自身的用量记录（claude/zcode/dsh/opencode 等各家本地文件）。
// 合计口径 = 输入+输出+缓存读+缓存写（思考 token 含在输出里）；各工具「输入是否含缓存」语义
// 差异已在主进程归一。限额是用户自填的本地参考值（官方额度都在各账号云端，本地拿不到）。
const TK_WINDOWS = [['today', '今日'], ['d7', '近7天'], ['d30', '近30天'], ['all', '全部']];
const TK_TABS = [['sessions', '会话'], ['models', '模型'], ['devices', '设备'], ['limits', '限额与数据源']];
const TK_STATUS_CN = { ok: '', meta: '元信息', empty: '无数据', missing: '未安装', error: '读取失败' };
let tkModalBody = null, tkRange = 'today', tkTab = 'sessions';
let tkCfg = { devices: [], limits: {} }, tkData = null, tkToolFilter = 'all';

function fmtTok(n) {
  n = +n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function fmtRel(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 0) return '刚刚';
  if (d < 60e3) return Math.max(1, Math.round(d / 1000)) + ' 秒前';
  if (d < 3600e3) return Math.round(d / 60e3) + ' 分前';
  if (d < 86400e3) return Math.round(d / 3600e3) + ' 时前';
  return Math.round(d / 86400e3) + ' 天前';
}

function tkLimitHtml(lim, label) {
  if (!lim) return '';
  const pct = Math.min(100, Math.round(lim.pct));
  const eta = lim.etaMin != null ? ` · 按近1h速率约 ${lim.etaMin >= 60 ? Math.round(lim.etaMin / 60) + ' 时' : lim.etaMin + ' 分'}后到限` : '';
  return `<div class="tk-lim ${pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : ''}" title="${label}限额 ${fmtTok(lim.limit)} tok${eta}">
    <span class="tk-lim-label">${label}</span>
    <span class="tk-bar"><span style="width:${pct}%"></span></span>
    <span class="tk-lim-val">${pct}%</span>
  </div>`;
}

function tkCard(t) {
  const w = t.windows[tkRange] || { total: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const statusTxt = t.status === 'ok'
    ? `${t.sessions} 会话`
    : (TK_STATUS_CN[t.status] || t.status);
  const stCls = t.status === 'ok' ? 'st-ok' : t.status === 'meta' ? 'st-meta' : t.status === 'error' ? 'st-err' : 'st-off';
  const rate = Math.round((t.rates.h1 || 0) / 60);
  const lims = (t.limits && (t.limits.hour5 || t.limits.daily || t.limits.weekly))
    ? tkLimitHtml(t.limits.hour5, '5h') + tkLimitHtml(t.limits.daily, '日') + tkLimitHtml(t.limits.weekly, '周')
    : '';
  return `<div class="tk-card">
    <div class="tk-card-head">
      <b>${esc(t.name)}</b><span class="tk-status ${stCls}">${esc(statusTxt)}</span>
      <span class="grow"></span><span class="muted small">${t.lastActive ? fmtRel(t.lastActive) : ''}</span>
    </div>
    <div class="tk-big">${fmtTok(w.total)}<span class="tk-unit"> tok</span></div>
    <div class="tk-sub">输入 ${fmtTok(w.input)} · 输出 ${fmtTok(w.output)} · 缓存读 ${fmtTok(w.cacheRead)} · 缓存写 ${fmtTok(w.cacheWrite)} · ${w.requests} 次调用</div>
    ${t.windows.all.costUsd > 0 ? `<div class="tk-sub">累计成本 ≈ $${t.windows.all.costUsd.toFixed(2)}（工具自报）</div>` : ''}
    ${t.status === 'ok' && rate > 0 ? `<div class="tk-sub muted">近1h ≈ ${fmtTok(rate)} tok/min</div>` : ''}
    ${lims}
    ${t.statusNote ? `<div class="tk-note">${esc(t.statusNote)}</div>` : ''}
  </div>`;
}

function tkSessionsHtml() {
  const tools = new Map((tkData.tools || []).map(t => [t.id, t]));
  const filterOpts = [['all', `全部（${(tkData.sessions || []).length}）`]]
    .concat((tkData.tools || []).filter(t => t.sessions > 0).map(t => [t.id, `${t.name}（${t.sessions}）`]));
  const rows = (tkData.sessions || [])
    .filter(s => tkToolFilter === 'all' || s.tool === tkToolFilter)
    .slice(0, 200);
  const multiDev = (tkData.devices || []).length > 1;
  return `
    <div class="row" style="gap:8px;margin-bottom:8px">
      <select id="tkToolFilter" class="session-select" style="max-width:220px">${filterOptions(filterOpts, tkToolFilter)}</select>
      <span class="hint grow">每个会话一行（最多列 200 条，按最近活跃排序）；数字为当前时间窗内</span>
    </div>
    <div class="tk-srows">
      ${rows.map(s => {
        const w = s.windows[tkRange] || { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
        return `<div class="tk-srow" title="会话 ${esc(s.sessionId)}${s.project ? '\n项目 ' + esc(s.project) : ''}">
          <span class="tk-s-tool">${esc((tools.get(s.tool) || {}).name || s.tool)}</span>
          <span class="tk-s-title">${esc(s.title || s.sessionId)}</span>
          <span class="tk-s-models">${(s.models || []).map(m => esc(m.model)).join(' + ')}</span>
          ${multiDev ? `<span class="badge">${esc(s.device)}</span>` : ''}
          <span class="tk-num b">${fmtTok(w.total)}</span>
          <span class="tk-num">↑${fmtTok(w.input)} ↓${fmtTok(w.output)} ⤒${fmtTok(w.cacheRead)}</span>
          <span class="tk-num">${w.requests} 次</span>
          <span class="muted small">${fmtRel(s.lastAt)}</span>
        </div>`;
      }).join('') || '<p class="hint" style="padding:12px 0">这个时间窗内没有会话记录。</p>'}
    </div>`;
}

function tkModelsHtml() {
  const tools = new Map((tkData.tools || []).map(t => [t.id, t.name]));
  const rows = (tkData.models || []).filter(m => (m.windows[tkRange] || {}).total > 0);
  const max = Math.max(1, ...rows.map(m => m.windows[tkRange].total));
  return `<div class="tk-srows">
    ${rows.map(m => {
      const w = m.windows[tkRange];
      // 同名模型跨工具合并展示：悬浮列出各工具在当前时间窗内的占比（数据来自 index.js byTool 分桶）
      const byToolTip = ((m.byTool || {})[tkRange] || []).map(t => `${tools.get(t.tool) || t.tool} ${fmtTok(t.total)}`).join(' · ');
      return `<div class="tk-srow">
        <span class="tk-s-tool" style="flex:1.2;min-width:0"><span class="tk-mname">${esc(m.model)}</span></span>
        <span class="tk-s-models" style="flex:none"${byToolTip ? ` title="${esc(byToolTip)}"` : ''}>${m.tools.map(t => esc(tools.get(t) || t)).join(' · ')}</span>
        <span class="tk-num b">${fmtTok(w.total)}</span>
        <span class="tk-share"><span style="width:${Math.max(2, Math.round(w.total / max * 100))}%"></span></span>
        <span class="tk-num">${w.requests} 次</span>
      </div>`;
    }).join('') || '<p class="hint" style="padding:12px 0">这个时间窗内没有模型用量。</p>'}
  </div>`;
}

function tkDevicesHtml() {
  const devs = tkData.devices || [];
  return `
    <div class="tk-devs">
      ${devs.map(d => {
        const w = d.windows[tkRange] || { total: 0, requests: 0 };
        return `<div class="tk-card">
          <div class="tk-card-head"><b>${icon('monitor', 14)} ${esc(d.label)}</b>${d.label === tkData.hostname ? '<span class="tk-status st-ok">本机</span>' : ''}</div>
          <div class="tk-big">${fmtTok(w.total)}<span class="tk-unit"> tok</span></div>
          <div class="tk-sub">${w.requests} 次调用 · ${(d.tools || []).slice(0, 4).map(t => `${esc((tkData.tools.find(x => x.id === t.tool) || {}).name || t.tool)} ${fmtTok(t.total)}`).join(' · ')}</div>
        </div>`;
      }).join('')}
    </div>
    <h4 style="margin:12px 0 6px">额外数据根（其他设备 / 同步盘 / WSL）</h4>
    <p class="hint" style="margin:0 0 8px">添加其他电脑上的工具数据目录（如同步盘里的 <b>.claude 等所在的主目录</b>），会按各工具的标准相对路径探测并归入你标注的设备名。路径只读，不会写入。</p>
    <div id="tkDevList">
      ${(tkCfg.devices || []).map((v, i) => `
        <div class="row tk-dev-row" data-i="${i}" style="gap:6px;margin:4px 0">
          <input type="text" class="tk-in" data-k="label" value="${esc(v.label)}" maxlength="40" style="width:120px" placeholder="设备名">
          <input type="text" class="tk-in" data-k="path" value="${esc(v.path)}" maxlength="300" style="flex:1" placeholder="如 D:\\sync\\pc2-home（该机用户主目录）">
          <button class="btn btn-sm btn-icon" data-a="tk-dev-del" data-i="${i}" title="删除">${icon('trash', 15)}</button>
        </div>`).join('') || '<p class="hint" id="tkDevEmpty">（暂无额外设备）</p>'}
    </div>
    <div class="row" style="gap:6px;margin-top:6px">
      <button class="btn btn-sm" data-a="tk-dev-add">＋ 添加</button>
      <button class="btn btn-sm btn-primary" data-a="tk-dev-save">${icon('save', 14)} 保存并重扫</button>
      <span class="hint grow" id="tkDevSaved"></span>
    </div>`;
}

function tkLimitsHtml() {
  return `
    <p class="hint" style="margin:4px 0 10px">官方额度都在各家账号云端（Claude/Codex/GLM 均无本地档位表），这里的限额是<b>你自填的本地参考线</b>：达到后进度条变色，并按近 1 小时燃烧速率估算到限时间。单位 token，留空/0 = 不设。5h 为滚动 5 小时窗口；日 = 本地自然日；周 = 滚动 7 天。</p>
    <div class="tk-srows" id="tkLimRows">
      ${(tkData.tools || []).map(t => {
        const lim = (tkCfg.limits || {})[t.id] || {};
        return `<div class="tk-srow" data-tool="${esc(t.id)}">
          <span class="tk-s-tool" style="flex:1">${esc(t.name)}</span>
          <label class="tk-lim-in">5h <input type="number" min="0" data-k="hour5" value="${lim.hour5 || ''}" placeholder="—"></label>
          <label class="tk-lim-in">日 <input type="number" min="0" data-k="daily" value="${lim.daily || ''}" placeholder="—"></label>
          <label class="tk-lim-in">周 <input type="number" min="0" data-k="weekly" value="${lim.weekly || ''}" placeholder="—"></label>
        </div>`;
      }).join('')}
    </div>
    <div class="row" style="gap:8px;margin-top:10px">
      <button class="btn btn-sm btn-primary" data-a="tk-lim-save">${icon('save', 14)} 保存限额</button>
      <span class="hint grow" id="tkLimSaved"></span>
    </div>`;
}

function filterOptions(opts, cur) {
  return opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
}

function tkRender() {
  const body = tkModalBody;
  if (!body || !body.isConnected || !tkData) return;
  const toolsOk = (tkData.tools || []).filter(t => t.status === 'ok');
  const sum = toolsOk.reduce((a, t) => ({
    total: a.total + t.windows[tkRange].total, requests: a.requests + t.windows[tkRange].requests,
  }), { total: 0, requests: 0 });
  body.innerHTML = `
    <div class="row" style="gap:8px;margin-bottom:8px;flex-wrap:wrap">
      ${TK_WINDOWS.map(([v, l]) => `<button class="btn btn-sm ${tkRange === v ? 'btn-primary' : ''}" data-range="${v}">${l}</button>`).join('')}
      <span class="badge p" title="有用量数据的工具合计">合计 ${fmtTok(sum.total)} tok · ${sum.requests} 次</span>
      <span class="grow"></span>
      <button class="btn btn-sm" data-a="tk-refresh">⟳ 刷新</button>
    </div>
    <div class="tk-cards">${(tkData.tools || []).map(tkCard).join('')}</div>
    <div class="tabs" style="margin:12px 0 8px">
      ${TK_TABS.map(([v, l]) => `<div class="tab ${tkTab === v ? 'active' : ''}" data-tk-tab="${v}" role="tab" tabindex="0" aria-selected="${tkTab === v}">${l}</div>`).join('')}
      <span class="grow"></span>
      <span class="hint" title="扫描耗时 ${tkData.scanMs}ms${tkData.zstd ? ' · zstd 解压组件：' + tkData.zstd : ' · 无 zstd 组件：DSH 压缩会话读不了明细'}">扫描于 ${fmtRel(Date.parse(tkData.scannedAt))} · 每 60s 自动刷新</span>
    </div>
    <div id="tkTabBody">${tkTab === 'sessions' ? tkSessionsHtml() : tkTab === 'models' ? tkModelsHtml() : tkTab === 'devices' ? tkDevicesHtml() : tkLimitsHtml()}</div>`;
  bindTkEvents();
}

function tkCollectLimits() {
  const limits = {};
  const box = tkModalBody && tkModalBody.querySelector('#tkLimRows');
  if (!box) return limits;
  box.querySelectorAll('.tk-srow[data-tool]').forEach(row => {
    const tool = row.dataset.tool;
    const get = (k) => { const v = +row.querySelector(`[data-k=${k}]`).value; return Number.isFinite(v) && v > 0 ? Math.round(v) : 0; };
    const lim = { hour5: get('hour5'), daily: get('daily'), weekly: get('weekly') };
    if (lim.hour5 || lim.daily || lim.weekly) limits[tool] = lim;
  });
  return limits;
}

async function tkSaveCfg() {
  try {
    tkCfg = await dp.tokenBoardConfigSave(tkCfg);
    toast('已保存', 'ok');
    await tkLoad(true);
  } catch (err) { toast(errText(err), 'error'); }
}

function bindTkEvents() {
  const body = tkModalBody;
  if (!body) return;
  body.querySelectorAll('[data-range]').forEach(btn => btn.addEventListener('click', () => { tkRange = btn.dataset.range; tkRender(); }));
  body.querySelectorAll('[data-tk-tab]').forEach(t => {
    const pick = () => { tkTab = t.dataset.tkTab; tkRender(); };
    t.addEventListener('click', pick);
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
  });
  const refreshBtn = body.querySelector('[data-a=tk-refresh]');
  if (refreshBtn) refreshBtn.addEventListener('click', () => tkLoad());
  const filterSel = body.querySelector('#tkToolFilter');
  if (filterSel) filterSel.addEventListener('change', () => { tkToolFilter = filterSel.value; tkRender(); });
  // 设备根编辑
  const devAdd = body.querySelector('[data-a=tk-dev-add]');
  if (devAdd) devAdd.addEventListener('click', () => {
    tkCfg.devices = tkCfg.devices || [];
    tkCfg.devices.push({ label: '', path: '' });
    tkTab = 'devices'; tkRender();
  });
  body.querySelectorAll('[data-a=tk-dev-del]').forEach(btn => btn.addEventListener('click', () => {
    tkCfg.devices.splice(+btn.dataset.i, 1);
    tkTab = 'devices'; tkRender();
  }));
  const devSave = body.querySelector('[data-a=tk-dev-save]');
  if (devSave) devSave.addEventListener('click', async () => {
    const rows = [...body.querySelectorAll('.tk-dev-row')];
    tkCfg.devices = rows.map(r => ({
      label: r.querySelector('[data-k=label]').value.trim(),
      path: r.querySelector('[data-k=path]').value.trim(),
    })).filter(v => v.label && v.path);
    await tkSaveCfg();
    tkTab = 'devices'; tkRender();
  });
  // 限额编辑
  const limSave = body.querySelector('[data-a=tk-lim-save]');
  if (limSave) limSave.addEventListener('click', async () => {
    tkCfg.limits = tkCollectLimits();
    await tkSaveCfg();
    tkTab = 'limits'; tkRender();
  });
}

async function openTokenBoard() {
  // 防重复：面板已开着（宠物菜单再点一次/推送与 pending 双触发）→ 只刷新不叠弹窗
  if (tkModalBody && tkModalBody.isConnected) { tkLoad(); return; }
  const { body } = openModal({ title: 'Token 看板 · 11 个 AI 工具 + deskpal · 角色无感知', width: '820px' });
  tkModalBody = body;
  try { tkCfg = await dp.tokenBoardConfig(); } catch (_) {}
  await tkLoad();
  // 面板开着每 60s 自动重扫（增量：没变的文件不重解析）；面板关闭即停
  const timer = setInterval(() => {
    if (!body.isConnected) { clearInterval(timer); if (tkModalBody === body) tkModalBody = null; return; }
    tkLoad(true);
  }, 60000);
}

async function tkLoad(silent) {
  const body = tkModalBody;
  if (!body || !body.isConnected) { tkModalBody = null; return; }
  if (!silent) body.innerHTML = `<div style="padding:12px">${skeletonBlock(4)}<p class="hint">正在扫描各工具的本地用量记录…（首次可能要几秒）</p></div>`;
  let data;
  try { data = await dp.tokenBoardQuery(); }
  catch (err) { body.innerHTML = `<p class="hint">加载失败：${esc(errText(err))}</p>`; return; }
  tkData = data;
  tkRender();
}

// ---------- 面板直达（宠物右键菜单「Token 看板」→ 本窗打开） ----------
dp.on('ui:open-panel', ({ panel } = {}) => { if (panel === 'tokens') openTokenBoard(); });

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
  try {
    const sp = await dp.spritesGet();
    spriteSlots = (sp && sp.slots) || {};
  } catch (_) { spriteSlots = {}; }
  try { avatarState = (await dp.avatarGet()) || { user: null }; } catch (_) { avatarState = { user: null }; }
  await refreshSessions();
  await refreshDemoState(); // 演示模式徽标（重启后恒为关；速度设置从主进程带出）
  refreshMailBadge(); // v1.5：信箱未读徽标
  histories.roleplay = await dp.chatHistory('roleplay');
  histories.quick = await dp.chatHistory('quick');
  try {
    const api = await dp.storeGet('api');
    if (api.model) main.querySelector('#modelTag').textContent = '模型：' + api.model + (api.hasKey ? '' : '（未配置 Key）');
    else main.querySelector('#modelTag').textContent = '尚未配置 API（设置 → API）';
    // 图像识别徽标：多模态可用时提示（模型名词表命中或用户强制开启）
    try {
      const v = await dp.llmVisionDetect({});
      if (v && v.capable) main.querySelector('#modelTag').textContent += ' · 视觉';
    } catch (_) {}
  } catch (_) {}
  try {
    const s = await dp.storeGet('settings');
    setPermMode((s.agent && s.agent.permissionMode) || 'read');
  } catch (_) {}
  loadInterrupted();
  renderAll();
  input.focus();
  // 宠物菜单在窗口未就绪时触发的面板直达（pending 兜底，取后即清）
  try { const pend = await dp.takePendingPanel(); if (pend && pend.panel === 'tokens') openTokenBoard(); } catch (_) {}
})();
