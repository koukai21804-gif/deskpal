// 聊天窗：角色扮演 / 快问两标签、流式渲染、停止/重生成、日程确认条、启动器本地匹配
// ★v0.3：节拍按句触发宠物表情、agent 步骤时间线、写权限卡、diff 卡、中断任务提示条
import { dp, initTheme, esc, errText, uid } from '../common/ipc.js';
import { renderMD } from '../common/md.js';
import { toast, confirmBox } from '../common/ui.js';
import { mountTitlebar } from '../common/windows/titlebar.js';

const EMO_LABEL = { normal: '平常', happy: '开心', surprised: '惊讶', angry: '愤怒', thinking: '思考', sad: '悲伤' };
const SCHEDULE_RE = /^(提醒我|帮我记一下|记一下|添加日程|加个日程)/;

let tab = 'roleplay';
let streaming = null;           // { tab, reqId, el, raw, steps, changes, permTimers }
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
      if (s.kind === 'notice') return `<div class="step"><span class="badge n">🔄 重试</span><span>${esc(s.text || '')}</span></div>`;
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
    list.innerHTML = `<div class="empty">${tab === 'roleplay' ? '和你的宠物聊聊吧～它会记住重要的事' : '问点什么，我直接回答'}</div>`;
    return;
  }
  for (const m of hist) list.appendChild(msgEl(m));
  scrollBottom();
}

// 保存到主进程时剥离仅存渲染层的附加数据（时间线/diff 归档在 agent/runs.jsonl，不进 chats）
async function persistHistory(t) {
  const clean = histories[t].map(m => {
    const { steps, changes, runId, ...rest } = m;
    return rest;
  });
  await dp.chatSaveHistory(t, clean);
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

dp.on('llm:done', async ({ tab: t, reqId, clean, emotion, schedule, aborted, beats, runId, changes, msgId }) => {
  if (!streaming || streaming.tab !== t) return;
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
  try {
    const s = await dp.storeGet('settings');
    permModeSel.value = (s.agent && s.agent.permissionMode) || 'read';
  } catch (_) {}
  loadInterrupted();
  renderAll();
  input.focus();
})();
