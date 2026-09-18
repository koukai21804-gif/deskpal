// 聊天窗：角色扮演 / 快问两标签、流式渲染、停止/重生成、日程确认条、启动器本地匹配
import { dp, initTheme, esc, errText, uid } from '../common/ipc.js';
import { renderMD } from '../common/md.js';
import { toast, confirmBox } from '../common/ui.js';
import { mountTitlebar } from '../common/windows/titlebar.js';

const EMO_LABEL = { normal: '平常', happy: '开心', surprised: '惊讶', angry: '愤怒', thinking: '思考', sad: '悲伤' };
const SCHEDULE_RE = /^(提醒我|帮我记一下|记一下|添加日程|加个日程)/;

let tab = 'roleplay';
let streaming = null;           // { tab, reqId, el, raw }
let histories = { roleplay: [], quick: [] };

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

const main = document.createElement('div');
main.className = 'chat-wrap';
main.innerHTML = `
  <div class="msg-list" id="list"></div>
  <div class="chat-input">
    <textarea id="input" placeholder="和宠物聊天…（"打开xx"可直接启动程序；"提醒我明天9点开会"直达日程）" rows="1"></textarea>
    <div class="input-row">
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

// ---------- 标签切换 ----------
tabsEl.addEventListener('click', async (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  if (t.dataset.act === 'export') return doExport();
  if (t.dataset.act === 'clear') return doClear();
  tab = t.dataset.tab;
  tabsEl.querySelectorAll('.tab[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  input.placeholder = tab === 'quick'
    ? '快问快答：直接问，我简洁回答（可以问知识、代码、命令…）'
    : '和宠物聊天…（"打开xx"可直接启动程序；"提醒我明天9点开会"直达日程）';
  renderAll();
});

// ---------- 消息渲染 ----------
function msgEl(m) {
  const el = document.createElement('div');
  const kind = m.role === 'user' ? 'user' : m.role === 'system' ? 'system-notice' : m.error ? 'error' : 'assistant';
  el.className = 'msg ' + kind;
  el.dataset.id = m.id;
  const avatar = m.role === 'user' ? '🧑' : m.role === 'system' ? '' : '🟢';
  const bodyHTML = m.error
    ? esc(m.content)
    : m.role === 'system'
      ? esc(m.content)
      : renderMD(m.content || '');
  const emoHtml = m.emotion ? `<span class="emo-dot ${m.emotion}" title="${EMO_LABEL[m.emotion] || ''}"></span>` : '';
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
      <div class="md body">${bodyHTML}</div>
      ${emoHtml ? `<div class="meta">${emoHtml}<span class="small muted">${EMO_LABEL[m.emotion] || ''}</span></div>` : ''}
      <div class="sch-slot"></div>
    </div>`;
  // 消息操作
  el.querySelectorAll('.ops button').forEach(btn => btn.addEventListener('click', () => msgOp(btn.dataset.op, m)));
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
    if (i >= 0) { hist.splice(i, 1); await dp.chatSaveHistory(tab, hist); renderAll(); }
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
    if (!lastUser) { await dp.chatSaveHistory(tab, hist); renderAll(); return toast('前面没有用户消息了', 'warn'); }
    hist.splice(ui, 1); // 用户消息由 chat:send 重新追加
    await dp.chatSaveHistory(tab, hist);
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

function renderAll() {
  list.innerHTML = '';
  const hist = histories[tab];
  if (!hist.length) {
    list.innerHTML = `<div class="empty">${tab === 'roleplay' ? '和你的宠物聊聊吧～它会记住重要的事' : '问点什么，我直接回答'}</div>`;
    return;
  }
  for (const m of hist) list.appendChild(msgEl(m));
  scrollBottom();
}

function scrollBottom() { list.scrollTop = list.scrollHeight; }

// ---------- 发送流水线 ----------
async function send(text) {
  text = String(text ?? '').trim();
  if (!text || streaming) return;

  // 1. 本地启动器匹配（零 API）
  try {
    const hit = await dp.launcherMatch(text);
    if (hit && hit.hit) {
      histories[tab].push({ id: uid('m'), role: 'user', content: text, at: new Date().toISOString() });
      const sysMsg = { id: uid('m'), role: 'system', content: `这就为你打开「${hit.label}」～` };
      histories[tab].push(sysMsg);
      await dp.chatSaveHistory(tab, histories[tab]);
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
  el.innerHTML = `<div class="avatar">🟢</div><div class="bubble"><div class="md body"><span class="streaming-cursor"></span></div><div class="sch-slot"></div></div>`;
  list.appendChild(el);
  scrollBottom();

  let raw = '';
  streaming = { tab, el, raw: '' };
  setStreamUI(true);

  try {
    const { reqId } = await dp.chatSend(tab, text);
    streaming.reqId = reqId;
  } catch (err) {
    streaming = null;
    setStreamUI(false);
    el.remove();
    histories[tab].push({ id: uid('m'), role: 'assistant', content: errText(err), error: true, at: new Date().toISOString() });
    renderAll();
  }
}

// ---------- 流式事件 ----------
dp.on('llm:chunk', ({ tab: t, reqId, delta }) => {
  if (!streaming || streaming.tab !== t) return;
  if (delta) streaming.raw += delta;
  const body = streaming.el.querySelector('.body');
  body.innerHTML = renderMD(streaming.raw) + '<span class="streaming-cursor"></span>';
  scrollBottom();
});

dp.on('llm:done', async ({ tab: t, reqId, clean, emotion, schedule, aborted }) => {
  if (!streaming || streaming.tab !== t) return;
  const el = streaming.el;
  const raw = aborted ? streaming.raw + '\n\n（已停止生成）' : (clean ?? streaming.raw);
  streaming = null;
  setStreamUI(false);

  const msg = {
    id: uid('m'), role: 'assistant', content: raw, emotion: emotion || undefined,
    schedule: schedule || undefined, aborted: !!aborted, at: new Date().toISOString(),
  };
  histories[t].push(msg);
  renderAll();
  // 保存由主进程负责（历史权威在主进程）；渲染层刷新本地副本
  try { histories[t] = await dp.chatHistory(t); renderAll(); } catch (_) {}
});

dp.on('llm:error', ({ tab: t, error }) => {
  if (!streaming || streaming.tab !== t) return;
  streaming.el.remove();
  streaming = null;
  setStreamUI(false);
  histories[t].push({ id: uid('m'), role: 'assistant', content: error, error: true, at: new Date().toISOString() });
  renderAll();
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

// ---------- 导出 / 清空 ----------
async function doExport() {
  try {
    const saved = await dp.chatExport(tab);
    if (saved) toast('已导出：' + saved, 'ok');
  } catch (err) { toast(errText(err), 'error'); }
}
async function doClear() {
  if (!histories[tab].length) return;
  if (!(await confirmBox(`清空「${tab === 'roleplay' ? '角色扮演' : '快问'}」的全部聊天记录？`, { danger: true, okText: '清空' }))) return;
  histories[tab] = [];
  await dp.chatSaveHistory(tab, []);
  renderAll();
}

// ---------- 启动 ----------
(async function boot() {
  await initTheme();
  histories.roleplay = await dp.chatHistory('roleplay');
  histories.quick = await dp.chatHistory('quick');
  try {
    const api = await dp.storeGet('api');
    if (api.model) main.querySelector('#modelTag').textContent = '模型：' + api.model + (api.hasKey ? '' : '（未配置 Key）');
    else main.querySelector('#modelTag').textContent = '尚未配置 API（设置 → API）';
  } catch (_) {}
  renderAll();
  input.focus();
})();
