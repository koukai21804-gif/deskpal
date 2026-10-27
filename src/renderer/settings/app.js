// 设置页：人设 / 形象 / 配色 / API / 指令 / 分类 / 日程偏好 / 关于 —— 全部即时保存
import { dp, initTheme, esc, errText, debounce } from '../common/ipc.js';
import { t, tf, lang as i18nLang } from '../common/i18n.js';
import { toast, confirmBox } from '../common/ui.js';
import { icon } from '../common/icons.js';
import { mountTitlebar } from '../common/windows/titlebar.js';
import { renderPet, EMOTION_KEYS } from '../pet/sprite.js';

const EMO_CN = { normal: t('平常'), happy: t('开心'), surprised: t('惊讶'), angry: t('愤怒'), thinking: t('思考'), sad: t('悲伤') };

const app = document.getElementById('app');
app.appendChild(mountTitlebar(t('deskpal · 设置')));

const TAB_GROUPS = [
  [t('角色'), [['persona', t('人设'), 'user'], ['sprite', t('形象'), 'image']]],
  [t('外观'), [['theme', t('配色'), 'palette']]],
  [t('能力'), [['api', t('API 与模型'), 'plug'], ['commands', t('快捷指令'), 'terminal'],
            ['categories', t('应用分类'), 'tag'], ['schedule', t('日程偏好'), 'clock']]],
  [t('系统'), [['about', t('关于 deskpal'), 'info']]],
];

const root = document.createElement('div');
root.className = 'set-wrap';
root.innerHTML = `
  <div class="side-nav" role="tablist">${TAB_GROUPS.map(([g, items]) =>
    `<div class="nav-group-label">${g}</div>` +
    items.map(([k, n, ic]) =>
      `<div class="nav-item" data-tab="${k}" role="tab" tabindex="0">${icon(ic, 16)}<span>${n}</span></div>`
    ).join('')).join('')}</div>
  <div class="set-body" id="body"></div>`;
app.appendChild(root);
const body = root.querySelector('#body');
const sideNav = root.querySelector('.side-nav');

let tabLeave = null; // 当前标签页的离开钩子（如：指令页自动保存）

function switchTab(tab) {
  if (tabLeave) { const leave = tabLeave; tabLeave = null; leave().catch(() => {}); }
  sideNav.querySelectorAll('.nav-item').forEach(n => {
    const on = n.dataset.tab === tab;
    n.classList.toggle('active', on);
    n.setAttribute('aria-selected', String(on));
  });
  ({ persona: renderPersona, sprite: renderSprite, theme: renderTheme, api: renderApi,
     commands: renderCommands, categories: renderCategories, schedule: renderSchedulePref, about: renderAbout }[tab] || renderAbout)();
}

sideNav.addEventListener('click', (e) => {
  const t = e.target.closest('.nav-item');
  if (t) switchTab(t.dataset.tab);
});
sideNav.addEventListener('keydown', (e) => {
  const t = e.target.closest('.nav-item');
  if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); switchTab(t.dataset.tab); }
});

const saveDebounced = debounce((name, patch) => dp.storeSet(name, patch).catch(err => toast(errText(err), 'error')), 300);

// ================= ① 人设 =================
// v0.4.0-dev.5 分层改造：persona = canon（锁层，解锁→批准→provenance 留痕）/ ops（可迭代，即时保存）/
// user（对话对象，即时保存）。宪法原文与封存状态走 canon:get，不再经通用 storeSet 通道。
const CANON_GROUPS = [
  { key: 'identity', label: t('L1 身份锚'), fields: [['name', t('名字'), 1], ['category', t('身份类别'), 2], ['purpose', t('存在的目的'), 2], ['background', t('来路（身份叙事）'), 4]] },
  { key: 'bond', label: t('L2 关系定义'), fields: [['nature', t('羁绊性质'), 2], ['division', t('分工'), 2], ['address', t('互称'), 2], ['pledge', t('不可替代性声明（前辈原话）'), 2]] },
  { key: 'principles', label: t('L3 性格内核三铁律'), fields: null },
  { key: 'taboos', label: t('L3 禁忌条款'), fields: null },
  { key: 'signature', label: t('L4 语言签名'), fields: [['speechStyle', t('说话风格（语速/术语习惯）'), 3], ['emotionalPatterns', t('情绪六态外部表现'), 5]] },
];

// 用户头像预览（数据目录里的图片 → file:// URL；未上传回落到人形图标）
function avatarPreviewHtml(st) {
  const u = st && st.user;
  if (!u || !u.path) return icon('user', 26);
  return `<img src="file:///${String(u.path).replace(/\\/g, '/')}" alt="${t('我的头像')}" draggable="false">`;
}

// 助手头像预览：未自定义时显示随包分发的默认 icon.png（settings/ → 仓库根）
function assistantAvatarPreviewHtml(st) {
  const a = st && st.assistant;
  if (!a || !a.path) return `<img src="../../../icon.png" alt="${t('默认助手头像')}" draggable="false">`;
  return `<img src="file:///${String(a.path).replace(/\\/g, '/')}" alt="${t('助手头像')}" draggable="false">`;
}

async function renderPersona() {
  const [{ persona, status: seal }, avatarSt] = await Promise.all([
    dp.canonGet(),
    dp.avatarGet().catch(() => ({ user: null })),
  ]);
  const c = persona.canon, ops = persona.ops, user = persona.user;
  const F = (id, label, val, ph = '') =>
    `<div class="field"><span class="label">${label}</span><textarea id="${id}" rows="${id.includes('catchphrases') ? 2 : 3}" placeholder="${ph}">${esc(val || '')}</textarea></div>`;
  const canonField = (id, label, val, rows) =>
    `<div class="field"><span class="label">${label}</span><textarea id="${id}" class="canon-field" rows="${rows}" disabled>${esc(val || '')}</textarea></div>`;

  body.innerHTML = `<div class="set-section">
    <div class="card" id="profileCard" style="margin-bottom:18px">
      <div class="row"><b>${t('宠物设定档案')}</b><span class="hint grow" style="margin-left:8px">${t('人设 + 形象差分图 + 缩放绑定为完整设定；可保存多套、一键切换、导出 .pet.json 分享。全部角色（含导入）统一遵循 canon/ops/user 分层与锁层')}</span></div>
      <div class="avatar-edit" style="margin:12px 0 4px">
        <div class="avatar-preview" id="assistantAvatarPreview">${assistantAvatarPreviewHtml(avatarSt)}</div>
        <div class="avatar-edit-main">
          <div class="row" style="gap:8px">
            <button class="btn btn-sm" id="assistantAvatarPick">${icon('upload', 14)} ${t('上传助手头像')}</button>
            <button class="btn btn-sm" id="assistantAvatarReset" ${avatarSt && avatarSt.assistant ? '' : 'disabled'}>${t('恢复默认')}</button>
          </div>
          <p class="hint">${t('显示在聊天窗每条回复旁；默认使用内置 icon.png。头像是本机外观设置，不写入人设、不会进入长期记忆。')}</p>
        </div>
      </div>
      <div class="row" style="margin:10px 0 4px">
        <input type="text" id="profName" placeholder="${t('设定名称，如：缇托·日常版')}" style="width:210px">
        <button class="btn btn-sm btn-primary" id="profSave">${icon('save', 14)} ${t('保存当前设定')}</button>
        <button class="btn btn-sm" id="profImport">${icon('download', 14)} ${t('导入设定文件')}</button>
      </div>
      <div id="profList"></div>
    </div>

    <div class="card" style="margin-bottom:18px;border-left:4px solid var(--dp-accent)">
      <div class="row"><b>${icon('lock', 15)} ${t('人格宪法（canon 锁层）')}</b>
        <span class="hint grow" style="margin-left:8px">${t('身份内核：改到什么程度，她就不再是她。改动需逐项批准并留痕（谁/何时/改了什么/为什么）')}</span></div>
      <div class="hint" style="margin:6px 0 10px" id="canonStatus"></div>
      <div id="canonForm">
        ${CANON_GROUPS.map(g => {
          if (!g.fields) return canonField(`c-${g.key}`, g.label, c[g.key], g.key === 'taboos' ? 6 : 4);
          return `<div class="hint" style="margin:8px 0 2px;font-weight:bold">${g.label}</div>` +
            g.fields.map(([f, label, rows]) => canonField(`c-${g.key}-${f}`, label, (c[g.key] || {})[f], rows)).join('');
        }).join('')}
      </div>
      <div class="row" style="margin-top:10px" id="canonActions">
        <button class="btn btn-sm" id="canonUnlock">${icon('unlock', 14)} ${t('申请修改')}</button>
        <button class="btn btn-sm btn-primary" id="canonSign" style="${seal.status === 'approved' ? 'display:none' : ''}">${icon('pencil', 14)} ${t('签署批准')}</button>
        <button class="btn btn-sm" id="canonReprovision" style="${seal.protection === 'protected' && !seal.recoverPending ? 'display:none' : ''}">${icon('key', 14)} ${t('重新配置保护')}${seal.recoverPending ? tf('（{0} 条未签名修订待收编）', seal.unsignedRevisions) : ''}</button>
        <input type="text" id="canonReason" placeholder="${t('批准理由（必填，将写入变更留痕）')}" style="flex:1;display:none" maxlength="200">
        <button class="btn btn-sm btn-primary" id="canonSubmit" style="display:none">${icon('checkCircle', 14)} ${t('提交批准')}</button>
        <button class="btn btn-sm" id="canonCancel" style="display:none">${icon('close', 14)} ${t('放弃')}</button>
      </div>
      <details style="margin-top:10px"><summary style="cursor:pointer;font-size:13px;color:var(--dp-text-muted)">${icon('clock', 14)} ${t('变更留痕（provenance）')}</summary>
        <div id="canonHistory" style="margin-top:8px"></div></details>
      <details style="margin-top:6px"><summary style="cursor:pointer;font-size:13px;color:var(--dp-text-muted)">${t('⏱ 表现层快照（ops 误改/误清空后的兜底，保留最近 10 份）')}</summary>
        <div id="opsHistory" style="margin-top:8px"></div></details>
    </div>

    <div id="personaForm">
    <h3 style="margin-top:0">${t('表现层（ops，可迭代：语气细节/口头禅/外貌/自定义指令，改动即时生效）')}</h3>
    <div class="row" style="gap:12px">
      <div class="field grow"><span class="label">${t('一句话简介')}</span><input type="text" id="p-tagline" value="${esc(ops.tagline)}" style="width:100%"></div>
      <div class="field" style="width:160px"><span class="label">${t('语言')}</span>
        <select id="p-language">${['中文', 'English', '日本語', '中英混合'].map(l => `<option ${ops.language === l ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    ${F('p-appearance', t('外貌'), ops.appearance)}
    ${F('p-personality', t('表层性格'), ops.personality)}
    ${F('p-catchphrases', t('口头禅（每行一句；句中可用 [开心] [惊讶] [悲伤] 等标签，点到这句时宠物会同步切换成对应表情）'), ops.catchphrases)}
    ${F('p-thinkingLogic', t('思维逻辑'), ops.thinkingLogic)}
    ${F('p-customPrompt', t('自定义指令（附加到 system prompt 末尾）'), ops.customPrompt)}
    <h3>${t('对话对象（user 层）')}</h3>
    <div class="avatar-edit">
      <div class="avatar-preview" id="userAvatarPreview">${avatarPreviewHtml(avatarSt)}</div>
      <div class="avatar-edit-main">
        <div class="row" style="gap:8px">
          <button class="btn btn-sm" id="userAvatarPick">${icon('upload', 14)} ${t('上传头像')}</button>
          <button class="btn btn-sm" id="userAvatarReset" ${avatarSt && avatarSt.user ? '' : 'disabled'}>${t('恢复默认')}</button>
        </div>
        <p class="hint">${t('头像会显示在聊天窗你的消息旁。模型具备视觉感知（设置 → API → 图像识别）时，角色可调用 look_user_avatar 看到并识别它；未开启视觉则只显示、不识别。')}</p>
      </div>
    </div>
    <div class="row" style="gap:12px">
      <div class="field grow"><span class="label">${t('称呼')}</span><input type="text" id="u-name" value="${esc(user.name)}" maxlength="12"></div>
    </div>
    <div class="field"><span class="label">${t('介绍（宠物眼中的你，帮助对话更贴心；更细的滚动档案在聊天窗输入 /user profile 维护）')}</span><textarea id="u-description" rows="2">${esc(user.description || '')}</textarea></div>
    <details><summary style="cursor:pointer;font-size:13px;color:var(--dp-text-muted)">${t('实时预览：角色扮演 system prompt')}</summary>
      <div class="prompt-preview" id="promptPreview" style="margin-top:8px"></div></details>
    </div>
  </div>`;

  // ---- 宪法状态与留痕 ----
  const sealBox = body.querySelector('#canonStatus');
  const signState = seal.status === 'approved'
    ? `<span style="color:var(--dp-ok)">${tf('已签署（{0} {1}）', esc(seal.approvedBy || ''), esc(String(seal.approvedAt || '').replace('T', ' ').slice(0, 16)))}</span>`
    : t('草案（行为约束生效中，批准待签署）');
  const PROT_CN = {
    protected: `<span style="color:var(--dp-ok)">${t('签名保护生效中')}</span>`,
    degraded: `<span style="color:var(--dp-warn)">${t('签名保护降级（密钥不可用：期间修订将标记未签名，不判篡改）')}</span>`,
    unsigned: t('○ 未配置签名保护'),
  };
  sealBox.innerHTML = `${tf('宪法版本 <b>v{0}</b>', seal.version)} · ${esc(seal.doc)} · ${signState} · ${PROT_CN[seal.protection] || esc(seal.protection)} · ${tf('封存于 {0}', esc(String(seal.sealedAt || '').replace('T', ' ').slice(0, 16)))} · ${seal.intact ? t('完整性 与封存一致') : `<span style="color:var(--dp-danger)">${t('不一致，已按快照恢复（见留痕）')}</span>`}`;
  const histHost = body.querySelector('#canonHistory');
  const entries = [...(seal.history || [])].reverse();
  histHost.innerHTML = entries.length ? entries.slice(0, 30).map(e => `
    <div class="hint" style="padding:4px 0;border-bottom:1px dashed var(--dp-border)">
      <b>v${e.version}</b> · ${esc(String(e.at || '').replace('T', ' ').slice(0, 16))} · ${esc(e.by || '')} · ${esc(e.type || '')}
      ${e.reason ? tf('· 理由：{0}', esc(e.reason)) : ''}${e.note ? `<br>${esc(e.note)}` : ''}
      ${(e.diff || []).map(d => `<br>· ${esc(d.path)}：「${esc(d.old)}」→「${esc(d.new)}」`).join('')}
    </div>`).join('') : `<div class="hint">${t('暂无变更记录')}</div>`;

  // ---- 签署批准（risk note R2：唯一写 seal.status=approved 的用户动作） ----
  body.querySelector('#canonSign').addEventListener('click', async () => {
    const go = await confirmBox(
      tf('签署批准宪法 v{0}？\n\n签署 = 前辈本人批准当前封存的宪法内容（TITOR-CANON 状态由草案转已签署），批准人/时间将落入变更留痕。之后的每次修订都会回到「草案」重新等待签署。', seal.version),
      { title: t('签署批准人格宪法'), okText: t('签署') });
    if (!go) return;
    try {
      await dp.canonApprove();
      toast(tf('宪法 v{0} 已签署批准', seal.version), 'ok');
      renderPersona();
    } catch (err) { toast(errText(err), 'error'); }
  });

  // ---- 重新配置保护（Q1 恢复仪式 + R12a 收编闸）----
  // 存在未签名修订时，先逐条列出 diff 让前辈确认，确认才允许收编（把确认挪到「重建之前」）
  body.querySelector('#canonReprovision').addEventListener('click', async () => {
    let pending = [];
    try { pending = await dp.canonPendingAmendments(); } catch (_) { pending = []; }
    const pendingTxt = pending.length
      ? '\n' + tf('注意：存在 {0} 条未签名修订（密钥降级期间产生），收编前请逐条核对：', pending.length) + '\n' +
        pending.slice(0, 6).map((a, i) => `${i + 1}. ${String(a.at || '').replace('T', ' ').slice(5, 16)} ${a.type}${a.reason ? '（' + a.reason + '）' : ''}：${(a.diff || []).map(d => `${d.path}「${d.old}」→「${d.new}」`).join('；') || t('（无字段级 diff）')}`).join('\n') +
        (pending.length > 6 ? '\n' + tf('…其余 {0} 条见「变更留痕」', pending.length - 6) : '') + '\n\n'
      : '';
    const go = await confirmBox(
      t('重新配置宪法签名保护？\n\n') +
      (seal.recoverPending
        ? t('密钥已恢复：重新配置后将收编降级期间的未签名修订。')
        : t('密钥当前不可用：将尝试重建保护（需要系统安全存储可用）；旧签名随之作废并留痕。')) +
      '\n\n' + pendingTxt +
      (pending.length ? t('确认以上修订内容无误并收编？') : t('此操作会留下 provenance 记录。')),
      { title: t('重新配置签名保护'), okText: pending.length ? tf('确认收编 {0} 条并重新配置', pending.length) : t('重新配置'), danger: true });
    if (!go) return;
    try {
      await dp.canonReprovision('前辈人工确认：重新配置签名保护' + (pending.length ? `并收编 ${pending.length} 条未签名修订` : ''), pending.length > 0);
      toast(t('签名保护已重新配置，宪法重新封存为草案'), 'ok');
      renderPersona();
    } catch (err) { toast(errText(err), 'error'); }
  });

  // ---- ops 快照恢复（risk note R5） ----
  const opsHost = body.querySelector('#opsHistory');
  const snaps = seal.opsSnapshots || [];
  opsHost.innerHTML = snaps.length ? snaps.map(s => `
    <div class="row" style="padding:4px 0;border-bottom:1px dashed var(--dp-border)">
      <span class="hint">${esc(String(s.at || '').replace('T', ' ').slice(0, 16))} · ${esc(s.reason)} · ${esc(s.name)} · ${esc(s.tagline || '')}${s.customPrompt ? t(' · 含自定义指令') : ''}</span>
      <span class="grow"></span>
      <button class="btn btn-sm" data-idx="${s.index}">${t('恢复此快照')}</button>
    </div>`).join('') : `<div class="hint">${t('暂无快照（启动/应用档案/编辑时会自动留）')}</div>`;
  opsHost.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-idx]');
    if (!btn) return;
    if (await confirmBox(t('把表现层（ops：外貌/口头禅/表层性格/自定义指令等）恢复到这份快照？宪法与对话对象不受影响。'), { title: t('恢复 ops 快照'), okText: t('恢复') })) {
      try {
        await dp.canonOpsRestore(+btn.dataset.idx);
        toast(t('ops 已恢复到快照'), 'ok');
        renderPersona();
      } catch (err) { toast(errText(err), 'error'); }
    }
  });

  // ---- 宪法解锁→批准流（唯一合法修改路径；主进程强制书面理由 + provenance） ----
  const canonEls = [...body.querySelectorAll('.canon-field')];
  let baseline = null; // 解锁瞬间的宪法快照（提交时逐字段 diff）
  const groupVal = (key) => {
    const g = CANON_GROUPS.find(x => x.key === key);
    if (!g.fields) return body.querySelector(`#c-${key}`).value.trim();
    return Object.fromEntries(g.fields.map(([f]) => [f, body.querySelector(`#c-${key}-${f}`).value.trim()]));
  };
  const collectCanonChanges = () => {
    const changes = {};
    for (const g of CANON_GROUPS) {
      const cur = groupVal(g.key), base = baseline[g.key];
      if (JSON.stringify(cur) !== JSON.stringify(base)) changes[g.key] = cur;
    }
    return changes;
  };
  body.querySelector('#canonUnlock').addEventListener('click', async () => {
    const go = await confirmBox(
      t('解锁「人格宪法」编辑：\n\n宪法是身份内核（L1 身份锚 / L2 关系定义 / L3 三铁律与禁忌 / L4 语言签名）。任何修改都会逐字段落变更留痕，提交时必须填写批准理由。\n\n确认由你本人（前辈）发起这次修改吗？'),
      { title: t('申请修改人格宪法'), okText: t('解锁'), danger: true });
    if (!go) return;
    baseline = {};
    for (const g of CANON_GROUPS) baseline[g.key] = groupVal(g.key);
    canonEls.forEach(el => { el.disabled = false; el.style.background = 'var(--dp-bg, #fffbe6)'; });
    body.querySelector('#canonUnlock').style.display = 'none';
    for (const id of ['canonReason', 'canonSubmit', 'canonCancel']) body.querySelector('#' + id).style.display = '';
  });
  const lockCanon = () => {
    canonEls.forEach(el => { el.disabled = true; el.style.background = ''; });
    body.querySelector('#canonUnlock').style.display = '';
    for (const id of ['canonReason', 'canonSubmit', 'canonCancel']) body.querySelector('#' + id).style.display = 'none';
    body.querySelector('#canonReason').value = '';
  };
  body.querySelector('#canonCancel').addEventListener('click', async () => { lockCanon(); await renderPersona(); });
  body.querySelector('#canonSubmit').addEventListener('click', async () => {
    const reason = body.querySelector('#canonReason').value.trim();
    if (!reason) return toast(t('批准理由必填（将写入变更留痕）'), 'warn');
    const changes = collectCanonChanges();
    if (!Object.keys(changes).length) return toast(t('没有实际改动'), 'warn');
    try {
      const r = await dp.canonUpdate(changes, reason);
      toast(tf('宪法已修订并封存为 v{0}，{1} 处变更已留痕', r.version, (r.diff || []).length), 'ok');
      lockCanon();
      renderPersona();
    } catch (err) { toast(errText(err), 'error'); }
  });

  // ---- ops / user 层：即时保存（canon 字段不在此通道） ----
  const v = id => body.querySelector('#' + id).value;
  const sel = id => body.querySelector('#' + id).value;
  const collectOps = () => ({
    ops: {
      tagline: v('p-tagline'), appearance: v('p-appearance'), personality: v('p-personality'),
      catchphrases: v('p-catchphrases'), thinkingLogic: v('p-thinkingLogic'),
      customPrompt: v('p-customPrompt'), language: sel('p-language'),
    },
  });
  const collectUser = () => ({ user: { name: v('u-name'), description: v('u-description') } });

  const onChange = debounce(async () => {
    await dp.storeSet('persona', collectOps());
    const sys = await dp.buildSystemPreview();
    body.querySelector('#promptPreview').textContent = sys;
  }, 400);
  const onUserChange = debounce(async () => {
    await dp.storeSet('persona', collectUser());
  }, 400);

  const formEl = body.querySelector('#personaForm');
  formEl.querySelectorAll('input,textarea,select').forEach(el => el.addEventListener('input', el.id.startsWith('u-') ? onUserChange : onChange));
  // ---- 助手头像（宠物设定档案内）：上传/恢复；聊天窗经 avatar:changed 即时刷新 ----
  const asPreview = body.querySelector('#assistantAvatarPreview');
  const asReset = body.querySelector('#assistantAvatarReset');
  const paintAssistantAvatar = (st) => {
    asPreview.innerHTML = assistantAvatarPreviewHtml(st);
    asReset.disabled = !(st && st.assistant);
  };
  body.querySelector('#assistantAvatarPick').addEventListener('click', async () => {
    try {
      const st = await dp.avatarPickAssistant();
      if (!st) return; // 用户取消选择
      paintAssistantAvatar(st);
      toast(t('助手头像已更新（聊天窗即时生效）'), 'ok');
    } catch (err) { toast(errText(err), 'error'); }
  });
  asReset.addEventListener('click', async () => {
    try {
      const st = await dp.avatarResetAssistant();
      paintAssistantAvatar(st);
      toast(t('已恢复默认助手头像'), 'ok');
    } catch (err) { toast(errText(err), 'error'); }
  });
  // ---- 对话对象头像：上传/恢复（落盘在主进程数据目录，聊天窗经 avatar:changed 即时更新） ----
  const avPreview = body.querySelector('#userAvatarPreview');
  const avReset = body.querySelector('#userAvatarReset');
  const paintAvatar = (st) => {
    avPreview.innerHTML = avatarPreviewHtml(st);
    avReset.disabled = !(st && st.user);
  };
  body.querySelector('#userAvatarPick').addEventListener('click', async () => {
    try {
      const st = await dp.avatarPickUser();
      if (!st) return; // 用户取消选择
      paintAvatar(st);
      toast(t('头像已更新（聊天窗即时生效）'), 'ok');
    } catch (err) { toast(errText(err), 'error'); }
  });
  avReset.addEventListener('click', async () => {
    try {
      const st = await dp.avatarResetUser();
      paintAvatar(st);
      toast(t('已恢复默认头像'), 'ok');
    } catch (err) { toast(errText(err), 'error'); }
  });
  // 初始预览
  dp.buildSystemPreview().then(s => { const el = body.querySelector('#promptPreview'); if (el) el.textContent = s; });

  // ---- 宠物设定档案 ----
  body.querySelector('#profSave').addEventListener('click', async () => {
    const name = body.querySelector('#profName').value;
    try {
      await dp.petsSave(name);
      toast(tf('已保存设定「{0}」', name || t('未命名')), 'ok');
      loadProfiles();
    } catch (err) { toast(errText(err), 'error'); }
  });
  body.querySelector('#profImport').addEventListener('click', async () => {
    try {
      const r = await dp.petsImport();
      if (!r) return;
      toast(tf('已导入「{0}」，点击列表中的「应用」即可切换', r.importedName), 'ok');
      loadProfiles();
    } catch (err) { toast(errText(err), 'error'); }
  });
  loadProfiles();
}

async function loadProfiles() {
  const host = body.querySelector('#profList');
  if (!host) return;
  let profiles = [];
  try { profiles = await dp.petsList(); } catch (_) { return; }
  host.innerHTML = profiles.length ? '' : `<div class="hint" style="padding:4px 0">${t('还没有保存的设定。调好人设和形象后，起个名字保存下来吧～')}</div>`;
  for (const p of profiles) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cssText = 'padding:6px 0;border-bottom:1px dashed var(--dp-border)';
    row.innerHTML = `<b>${esc(p.name)}</b>
      <span class="hint">${esc(p.petName ? p.petName + ' · ' : '')}${esc(String(p.createdAt || '').replace('T', ' ').slice(0, 16))}${p.hasImage ? t(' · 含差分图') : ''}</span>
      <span class="grow"></span>
      <button class="btn btn-sm btn-primary" data-a="apply" data-id="${p.id}">${t('应用')}</button>
      <button class="btn btn-sm" data-a="export" data-id="${p.id}">${t('导出')}</button>
      <button class="btn btn-sm btn-icon" data-a="del" data-id="${p.id}" title="${t('删除')}">${icon('trash', 15)}</button>`;
    row.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const { a, id } = btn.dataset;
      try {
        if (a === 'apply') {
          const r = await dp.petsApply(id);
          toast(tf('已应用「{0}」，人设与形象已切换', r.applied), 'ok');
          switchTab('persona'); // 重载表单显示已应用的档案内容
        } else if (a === 'export') {
          const saved = await dp.petsExport(id);
          if (saved) toast(tf('已导出：{0}', saved), 'ok');
        } else if (a === 'del') {
          if (await confirmBox(t('删除这个设定档案？（不影响当前使用中的人设和形象）'), { danger: true, okText: t('删除') })) {
            await dp.petsDelete(id);
            loadProfiles();
          }
        }
      } catch (err) { toast(errText(err), 'error'); }
    });
    host.appendChild(row);
  }
}

// ================= ② 形象 =================
async function renderSprite() {
  const sprites = await dp.spritesGet();
  const settings = await dp.storeGet('settings');
  body.innerHTML = `<div class="set-section">
    <h3 style="margin-top:0">${t('表情差分图（默认为内置角色缇托）')}</h3>
    <div class="sprite-grid">
      ${EMOTION_KEYS.map(k => `
        <div class="slot-card card" data-emo="${k}">
          <div class="preview" id="pv-${k}"></div>
          <div class="name">${EMO_CN[k]}</div>
          <div class="btns">
            <button class="btn btn-sm" data-a="upload">${t('上传图片')}</button>
            <button class="btn btn-sm" data-a="reset" ${(sprites.slots[k] || {}).mode === 'image' ? '' : 'disabled'}>${t('恢复默认')}</button>
          </div>
        </div>`).join('')}
    </div>
    <p class="hint">${t('支持 png / jpg / webp / gif，≤8MB。上传后聊天/陪读中宠物切换到该表情时显示你的图片；「恢复默认」回到内置角色缇托。')}</p>
    <div class="field" style="max-width:340px;margin-top:14px">
      <span class="label">${tf('整体缩放：{0}×', (settings.pet.scale || 1).toFixed(2))}</span>
      <div class="slider-row"><input type="range" id="scale" min="0.6" max="1.4" step="0.05" value="${settings.pet.scale || 1}"><span class="val" id="scaleVal"></span></div>
    </div>
  </div>`;

  for (const k of EMOTION_KEYS) {
    const pv = body.querySelector('#pv-' + k);
    renderPet(pv, k, sprites.slots[k] || { mode: 'svg' });
  }
  body.querySelectorAll('.slot-card').forEach(card => {
    const emo = card.dataset.emo;
    card.addEventListener('click', async (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (!a) return;
      if (a === 'upload') {
        const p = await dp.pickFile({ title: tf('选择「{0}」表情图', EMO_CN[emo]), filters: [{ name: t('图片'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
        if (!p) return;
        try {
          const sprites2 = await dp.spritesUpload(emo, p);
          renderPet(body.querySelector('#pv-' + emo), emo, sprites2.slots[emo]);
          card.querySelector('[data-a=reset]').disabled = false;
          toast(tf('{0} 已更新', EMO_CN[emo]), 'ok');
        } catch (err) { toast(errText(err), 'error'); }
      }
      if (a === 'reset') {
        const sprites2 = await dp.spritesReset(emo);
        renderPet(body.querySelector('#pv-' + emo), emo, { mode: 'svg' });
        card.querySelector('[data-a=reset]').disabled = true;
      }
    });
  });
  const scale = body.querySelector('#scale');
  const scaleVal = body.querySelector('#scaleVal');
  const updScale = debounce(() => saveDebounced('settings', { pet: { scale: +scale.value } }), 300);
  scale.addEventListener('input', () => {
    scaleVal.textContent = (+scale.value).toFixed(2) + '×';
    scale.closest('.field').querySelector('.label').textContent = tf('整体缩放：{0}×', (+scale.value).toFixed(2));
    updScale();
  });
}

// ================= ③ 配色 =================
async function renderTheme() {
  const theme = await dp.themeGet();
  const presets = await dp.themePresets();
  body.innerHTML = `<div class="set-section">
    <h3 style="margin-top:0">${t('按钮与强调色')}</h3>
    <div class="accent-grid">
      ${presets.map(p => `
        <button class="accent-card" data-color="${p.accent}" aria-pressed="${theme.accent.toLowerCase() === p.accent.toLowerCase()}">
          <span class="swatch" style="background:${p.accent}"></span>${p.name}
        </button>`).join('')}
      <button class="accent-card" data-custom="1" aria-pressed="false">
        <span class="swatch" style="background:${theme.accent};color:var(--dp-accent-fg)">${icon('palette', 18)}</span>${t('自定义')}
      </button>
    </div>
    <div class="row" style="margin-top:14px;gap:10px">
      <input type="color" id="accentPick" value="${theme.accent}" style="width:52px;height:36px">
      <span class="hint">${t('点色块自定义任意颜色')}</span>
    </div>
    <h3>${t('明暗模式')}</h3>
    <div class="row">
      ${[['light', t('浅色')], ['dark', t('深色')], ['system', t('跟随系统')]].map(([v, l]) => `
        <label class="chip clickable"><input type="radio" name="mode" value="${v}" ${theme.mode === v ? 'checked' : ''}> ${l}</label>`).join('')}
    </div>
    <h3>语言 / Language</h3>
    <div class="row" style="gap:10px;align-items:center">
      <select id="langSelect" style="min-width:160px">
        <option value="zh" ${i18nLang() === 'zh' ? 'selected' : ''}>中文（简体）</option>
        <option value="en" ${i18nLang() === 'en' ? 'selected' : ''}>English</option>
      </select>
      <span class="hint">${t('切换后所有窗口立即生效（未翻译的会话内容保持原文）')}</span>
    </div>
    <p class="hint">${t('配色对所有窗口即时生效（气泡、按钮、统计图…）。')}</p>
  </div>`;

  body.querySelectorAll('.accent-card[data-color]').forEach(c => c.addEventListener('click', () => {
    dp.themeSet({ accent: c.dataset.color });
    renderTheme();
  }));
  const pick = body.querySelector('#accentPick');
  pick.addEventListener('input', debounce(() => { dp.themeSet({ accent: pick.value }); }, 200));
  body.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', () => {
    dp.themeSet({ mode: r.value });
  }));
  const langSel = body.querySelector('#langSelect');
  if (langSel) langSel.addEventListener('change', () => { dp.i18nSet(langSel.value); });
}

// ================= ④ API =================
async function renderApi() {
  const api = await dp.storeGet('api');
  const settings = await dp.storeGet('settings');
  const searchCfg = await dp.storeGet('search'); // 联网搜索源配置（hasKey 布尔，密文不出主进程）
  const agent = settings.agent || { enabled: true, maxRounds: 8, permissionTimeoutSec: 120, permissionMode: 'read', toolMaxTokens: 8192 };
  const PRESETS = [
    { name: '自定义', endpoint: '', model: '' },
    { name: 'DeepSeek', endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' },
    // 智谱预设指向 Coding 套餐专属端点（套餐 Key 只认 /api/coding/paas/v4，通用 paas/v4 不收）；
    // 按量计费的普通 Key 请选「自定义」填 https://open.bigmodel.cn/api/paas/v4
    { name: '智谱 GLM（Coding 套餐）', endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-4.6' },
    { name: 'Kimi', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
    { name: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
    { name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  ];
  const cur = PRESETS.find(p => p.endpoint === api.endpoint) || PRESETS[0];
  const P = api.params || {};
  const ws = settings.agent && settings.agent.webSearch || { enabled: false, autonomousDailyLimit: 100, cooldownMin: 10, blockedTopics: [] };
  const vc = settings.agent && settings.agent.visionCapture || { screenEnabled: false };
  const wsTopics = (ws.blockedTopics || []).join('\n');

  body.innerHTML = `<div class="set-section">
    <h3 style="margin-top:0">${t('LLM 接口（OpenAI 兼容协议）')}</h3>
    <div class="field"><span class="label">${t('接口预设')}</span>
      <select id="a-preset">${PRESETS.map(p => `<option value="${esc(p.endpoint)}" ${cur.name === p.name ? 'selected' : ''}>${p.name}</option>`).join('')}</select></div>
    <div class="field"><span class="label">${t('接口地址（填 base 地址或完整 chat/completions 地址均可）')}</span><input type="text" id="a-endpoint" value="${esc(api.endpoint)}" style="width:100%"></div>
    <div class="field"><span class="label">${t('模型名（填好地址与 Key 后自动获取；点击输入框看完整列表，输入可筛选）')}</span>
      <div class="row" style="gap:8px">
        <div style="position:relative;flex:1;min-width:0">
          <input type="text" id="a-model" value="${esc(api.model)}" style="width:100%" autocomplete="off">
          <div id="a-model-menu" hidden style="position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:60;max-height:264px;overflow-y:auto;background:var(--dp-panel);border:1px solid var(--dp-border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.16);padding:4px"></div>
        </div>
        <button class="btn btn-sm" id="a-model-fetch" title="${t('从接口拉取可用模型列表')}">${icon('refresh', 14)} ${t('获取模型')}</button>
      </div>
      <div class="hint" id="a-model-status"></div></div>
    <div class="field"><span class="label">${t('图像识别（多模态 Vision）——开启后 Agent 可用 read_image 读图片、look_screen 看桌面、look_camera 开摄像头识别')}</span>
      <select id="a-vision" style="max-width:360px">
        <option value="auto" ${(api.vision === undefined || api.vision === 'auto') ? 'selected' : ''}>${t('自动检测（按模型名识别，推荐）')}</option>
        <option value="on" ${api.vision === true ? 'selected' : ''}>${t('强制开启（模型支持图像输入）')}</option>
        <option value="off" ${api.vision === false ? 'selected' : ''}>${t('关闭（纯文本模型）')}</option>
      </select>
      <div class="hint" id="a-vision-hint"></div></div>
    <div class="field"><span class="label">${tf('API Key（{0}，经系统安全存储加密）', api.hasKey ? t('已配置 ●') : t('未配置'))}</span>
      <input type="password" id="a-key" placeholder="${api.hasKey ? t('留空则不修改') : 'sk-...'}" autocomplete="new-password"></div>
    <details style="margin:8px 0 14px"><summary style="cursor:pointer;font-size:13px;color:var(--dp-text-muted)">${t('高级参数')}</summary>
      <div style="margin-top:10px">
        ${[['temperature', t('温度'), 0, 2, 0.05], ['maxTokens', t('最大 tokens'), 256, 8192, 128], ['topP', 'top_p', 0, 1, 0.05], ['frequencyPenalty', t('频率惩罚'), 0, 2, 0.05], ['presencePenalty', t('存在惩罚'), 0, 2, 0.05]]
          .map(([k, label, min, max, step]) => `
          <div class="field"><span class="label">${label}</span>
            <div class="slider-row"><input type="range" id="a-${k}" min="${min}" max="${max}" step="${step}" value="${P[k] ?? 0}"><span class="val">${P[k] ?? 0}</span></div>
          </div>`).join('')}
      </div></details>
    <div class="row">
      <button class="btn btn-primary" id="a-save">${t('保存配置')}</button>
      <button class="btn" id="a-test">${t('测试连接')}</button>
      <span class="hint" id="a-test-result"></span>
    </div>
    <p class="hint">${t('聊天、陪读剧情生成、日程解析、时间报告都需要它。Key 使用 Windows 凭据保护（safeStorage）加密存储。')}</p>
  </div>
  <div class="set-section">
    <h3 style="margin-top:0">${t('视频解析（陪读视频源：B站 / YouTube / MP4 直链 / 本地视频）')}</h3>
    <p class="hint">${t('流程：优先抓取视频字幕（不花转写费）；无字幕时下载音频做语音转写（需下方 ASR 配置）。解析结果为带时间戳的文稿，可生成「陪读剧情」或进「自由提问」模式。')}</p>
    <div class="field"><span class="label">${t('工具链状态（yt-dlp 抓取字幕/音频，ffmpeg 提取音轨）')}</span>
      <div id="vid-probe" class="hint">${t('检测中…')}</div>
      <div class="row" style="margin-top:6px">
        <button class="btn btn-sm" id="vid-import-ytdlp">${icon('download', 14)} ${t('导入 yt-dlp…')}</button>
        <button class="btn btn-sm" id="vid-import-ffmpeg">${icon('download', 14)} ${t('导入 ffmpeg…')}</button>
        <button class="btn btn-sm" id="vid-reprobe">${icon('refresh', 14)} ${t('重新检测')}</button>
      </div>
      <p class="hint">${t('「导入」从本机选择已有的 exe（例如 Paper2Galgame 安装目录 resources\\app.asar.unpacked\\bin 里的 yt-dlp.exe / ffmpeg.exe），复制进 deskpal 数据目录的 bin 文件夹；也可手动填路径或安装到系统 PATH。')}</p></div>
    <div class="field"><span class="label">${t('yt-dlp 路径（留空 = 自动：数据目录/bin → 系统 PATH）')}</span>
      <input type="text" id="vid-ytdlp-path" value="${esc((settings.video || {}).ytDlpPath || '')}" placeholder="D:\\tools\\yt-dlp.exe" style="max-width:420px"></div>
    <div class="field"><span class="label">${t('ffmpeg 路径（留空 = 自动）')}</span>
      <input type="text" id="vid-ffmpeg-path" value="${esc((settings.video || {}).ffmpegPath || '')}" placeholder="D:\\tools\\ffmpeg.exe" style="max-width:420px"></div>
    <div class="field"><span class="label">${t('语音识别（ASR）接口地址——OpenAI 兼容 /audio/transcriptions；留空 = 跟随上方 LLM 接口地址')}</span>
      <input type="text" id="vid-asr-url" value="${esc((api.asr || {}).baseUrl || '')}" placeholder="${t('如 https://api.siliconflow.cn/v1 或 https://open.bigmodel.cn/api/paas/v4')}" style="max-width:420px"></div>
    <div class="field"><span class="label">${t('ASR 模型名（常见：whisper-1 / FunAudioLLM/SenseVoiceSmall / glm-asr）')}</span>
      <input type="text" id="vid-asr-model" value="${esc((api.asr || {}).model || '')}" placeholder="whisper-1" style="max-width:420px"></div>
    <div class="field"><span class="label">${tf('ASR API Key（{0}；留空 = 跟随主 API Key）', (api.asr || {}).hasKey ? t('已配置 ●') : t('未配置'))}</span>
      <input type="password" id="vid-asr-key" placeholder="${(api.asr || {}).hasKey ? t('留空则不修改') : t('与主 Key 相同则不用填')}" autocomplete="new-password" style="max-width:420px"></div>
    <div class="row">
      <button class="btn btn-primary" id="vid-save">${t('保存视频解析配置')}</button>
      <span class="hint" id="vid-saved"></span>
    </div>
    <p class="hint">${t('没有字幕的视频才需要 ASR（B站/YouTube 大多有自动字幕，可免转写）。智谱 GLM 用户：地址填完整端点 https://open.bigmodel.cn/api/paas/v4/audio/asr、模型填 glm-asr；SiliconFlow 填 https://api.siliconflow.cn/v1（自动补 /audio/transcriptions）+ FunAudioLLM/SenseVoiceSmall。')}</p>
  </div>
  <div class="set-section">
    <h3 style="margin-top:0">${t('Agent 执行（实验功能）')}</h3>
    <p class="hint">${t('在「角色扮演」聊天中执行文件任务：读取 / 列目录 / 写文件。文件权限三档可在聊天窗底部随时切换（此处同步修改）：')}</p>
    <div class="field"><span class="label">${t('文件权限模式（对下一次任务生效）')}</span>
      <select id="ag-mode" style="max-width:360px">
        <option value="read" ${agent.permissionMode === 'read' ? 'selected' : ''}>${t('只读——只能读取和列目录，不写文件')}</option>
        <option value="userData" ${agent.permissionMode === 'userData' ? 'selected' : ''}>${t('可编辑——应用数据目录（deskpal 文件夹）及其子目录内可写')}</option>
        <option value="full" ${agent.permissionMode === 'full' ? 'selected' : ''}>${t('完全编辑——本机大部分目录可读写（核心系统目录除外，每次写入需批准）')}</option>
      </select></div>
    <div class="field"><span class="label">${t('启用 Agent 文件任务执行')}</span>
      <label style="display:flex;gap:6px;align-items:center;font-size:13px">
        <input type="checkbox" id="ag-enabled" ${agent.enabled ? 'checked' : ''}>
        ${t('允许宠物在聊天中调用工具读写文件')}
      </label></div>
    <div class="field"><span class="label">${t('最大执行轮次（4–16，超出后强制收尾作答）')}</span>
      <div class="slider-row"><input type="range" id="ag-rounds" min="4" max="16" step="1" value="${agent.maxRounds}"><span class="val">${agent.maxRounds}</span></div></div>
    <div class="field"><span class="label">${t('权限卡超时（60–300 秒，超时按拒绝处理）')}</span>
      <div class="slider-row"><input type="range" id="ag-timeout" min="60" max="300" step="10" value="${agent.permissionTimeoutSec}"><span class="val">${agent.permissionTimeoutSec}s</span></div></div>
    <div class="field"><span class="label">${t('工具轮输出上限（2048–65536 tokens。写文件时工具参数内嵌全文，需比聊天「最大 tokens」大；接口报 max_tokens 超限时调小此项）')}</span>
      <div class="slider-row"><input type="range" id="ag-tooltokens" min="2048" max="65536" step="1024" value="${agent.toolMaxTokens ?? 8192}"><span class="val">${agent.toolMaxTokens ?? 8192}</span></div></div>
    <div class="row"><span class="hint" id="ag-saved"></span></div>
  </div>
  <div class="set-section">
    <h3 style="margin-top:0">${t('联网搜索（受控出口 + 账本）')}</h3>
    <p class="hint">${t('角色可联网检索公开信息：用户明确要求的直接执行（首次使用会在聊天中弹授权卡开启）；角色自主补充的检索逐次弹卡批准。每次检索（含被拦截/被拒）都记入账本，聊天窗输入 <b>/search ledger</b> 查看。查询词不得包含个人信息（出口硬拦）。')}</p>
    <div class="field"><span class="label">${t('联网搜索总开关')}${ws.enabled ? t('（已开启 ● 通常由聊天内授权卡开启，此处可一键关闭）') : t('（未开启 —— 聊天中要求查资料时会弹授权卡）')}</span>
      <label style="display:flex;gap:6px;align-items:center;font-size:13px">
        <input type="checkbox" id="ws-enabled" ${ws.enabled ? 'checked' : ''}>
        ${t('允许角色执行联网检索')}
      </label></div>
    <div class="field"><span class="label">${t('搜索源供应商（与 LLM API 同款：选源 → 填 Key → 测试连接）')}</span>
      <select id="ws-source" style="max-width:360px">
        <option value="">${t('（未配置）')}</option>
        ${(await dp.searchProviders()).map(p => `<option value="${p.id}" ${searchCfg.source === p.id ? 'selected' : ''}>${esc(p.label)}${p.needsKey ? t('（需 API Key）') : ''}</option>`).join('')}
      </select>
      <div class="hint" id="ws-keyhint"></div></div>
    <div class="field" id="ws-endpoint-field" style="${searchCfg.source === 'searxng' ? '' : 'display:none'}"><span class="label">${t('SearXNG 实例地址（自托管，须开启 JSON format）')}</span>
      <input type="text" id="ws-endpoint" value="${esc(searchCfg.endpoint)}" placeholder="https://searxng.example.com" style="max-width:360px"></div>
    <div class="field"><span class="label">${tf('API Key（{0}，经系统安全存储加密）', searchCfg.hasKey ? t('已配置 ●') : t('未配置'))}</span>
      <input type="password" id="ws-key" placeholder="${searchCfg.hasKey ? t('留空则不修改') : t('在供应商官网申请')}" autocomplete="new-password" style="max-width:360px"></div>
    <div class="row">
      <button class="btn btn-primary" id="ws-save">${t('保存配置')}</button>
      <button class="btn" id="ws-test">${t('测试连接')}</button>
      <span class="hint" id="ws-test-result"></span>
    </div>
    <div class="field" style="margin-top:12px"><span class="label">${t('自主检索日限（0–500 次/自然日；达限后仅可执行用户明确要求的检索，并提示一次）')}</span>
      <div class="slider-row"><input type="range" id="ws-daily" min="0" max="500" step="10" value="${ws.autonomousDailyLimit ?? 100}"><span class="val">${ws.autonomousDailyLimit ?? 100}</span></div></div>
    <div class="field"><span class="label">${t('同查询冷却（0–60 分钟；冷却内重复查询直接复用上次结果，不重复计费）')}</span>
      <div class="slider-row"><input type="range" id="ws-cooldown" min="0" max="60" step="5" value="${ws.cooldownMin ?? 10}"><span class="val">${ws.cooldownMin ?? 10} ${t('分钟')}</span></div></div>
    <div class="field"><span class="label">${t('回避话题表（每行一条；命中即拦截，支持关键词或 /正则/i 写法。用于明确不想让角色碰的话题）')}</span>
      <textarea id="ws-topics" rows="3" style="max-width:480px" placeholder="${t('每行一条，如：&#10;某敏感词&#10;/某正则/i')}">${esc(wsTopics)}</textarea></div>
    <p class="hint">${t('密钥经 safeStorage 加密存储，不会进入角色上下文。检索结果不落盘（仅内存冷却缓存）；用户明确要求保存时才经 write_file 权限流写入。')}</p>
  </div>
  <div class="set-section">
    <h3 style="margin-top:0">${t('视觉感知（桌面查看 / 摄像头）')}</h3>
    <p class="hint">${t('角色具备「眼睛」：可截取桌面画面（look_screen）或开启摄像头拍一帧（look_camera）送入视觉上下文（需上方「图像识别」为可用状态）。画面会发送给你配置的模型服务商做识别；摄像头每次使用都先弹授权卡、拍完即关，无「永久开启」。')}</p>
    <div class="field"><span class="label">${t('桌面查看总开关')}${vc.screenEnabled ? t('（已开启 ● 通常由聊天内授权卡开启，此处可一键关闭）') : t('（未开启 —— 角色被要求看屏幕时会弹授权卡）')}</span>
      <label style="display:flex;gap:6px;align-items:center;font-size:13px">
        <input type="checkbox" id="vc-screen-enabled" ${vc.screenEnabled ? 'checked' : ''}>
        ${t('允许角色截取桌面画面识别')}
      </label></div>
    <p class="hint">${t('摄像头不设开关：每次调用都逐次弹卡批准（拒绝后 1 分钟内不再弹卡）。截图/影像均不落盘，仅注入当轮对话上下文。')}</p>
  </div>`;

  // ---- 模型列表自动获取（类似 CC Switch：填好地址 + Key → 拉取 /models → 下拉选择） ----
  // 自绘下拉而非原生 <datalist>：后者在输入框已有值时只显示「包含当前文本」的候选项
  // （如存量 glm-4 只剩 4 个 glm-4.x 可见），接口返回 11 个也只看得到 4 个，且无法关闭该过滤。
  const endpointInput = body.querySelector('#a-endpoint');
  const modelInput = body.querySelector('#a-model');
  const modelMenu = body.querySelector('#a-model-menu');
  const modelStatus = body.querySelector('#a-model-status');
  let modelOptions = []; // 拉取到的完整模型列表
  let fetchingModels = false;
  function hideModelMenu() { modelMenu.hidden = true; modelMenu.innerHTML = ''; }
  function showModelMenu() {
    if (!modelOptions.length) { hideModelMenu(); return; }
    const f = modelInput.value.trim().toLowerCase();
    const items = f ? modelOptions.filter(m => m.toLowerCase().includes(f)) : modelOptions;
    modelMenu.innerHTML = items.length
      ? items.map(m => `<div class="model-item" data-m="${esc(m)}">${esc(m)}</div>`).join('')
      : `<div class="model-item" style="color:var(--dp-text-muted);cursor:default">${t('无匹配，可手动填写')}</div>`;
    modelMenu.hidden = false;
  }
  modelMenu.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.model-item');
    if (!item || !item.dataset.m) return;
    e.preventDefault(); // 阻止输入框失焦（blur 钩子会收起菜单），选中后再主动收起
    modelInput.value = item.dataset.m;
    hideModelMenu();
    modelInput.dispatchEvent(new Event('change')); // 触发联动（如 vision 实时检测）
  });
  modelInput.addEventListener('focus', showModelMenu);          // 聚焦即摊开全量列表
  modelInput.addEventListener('input', showModelMenu);          // 输入时按「包含」筛选，清空恢复全量
  modelInput.addEventListener('blur', () => setTimeout(hideModelMenu, 120));
  async function fetchModels({ quiet = false } = {}) {
    const endpoint = endpointInput.value.trim();
    if (!endpoint) { modelStatus.textContent = ''; return; }
    if (fetchingModels) return;
    fetchingModels = true;
    modelStatus.textContent = t('⏳ 正在获取模型列表…');
    modelStatus.style.color = '';
    try {
      const key = body.querySelector('#a-key').value.trim(); // 未保存的新 Key 也可直接用
      const r = await dp.llmListModels({ endpoint, key });
      modelOptions = r.models || [];
      modelStatus.textContent = modelOptions.length
        ? tf('已获取 {0} 个模型，点击「模型名」输入框即可从完整列表选择', modelOptions.length)
        : t('接口未返回任何模型，可手动填写模型名');
      modelStatus.style.color = modelOptions.length ? 'var(--dp-ok)' : '';
      if (modelOptions.length) showModelMenu(); // 拉完直接摊开全量列表
    } catch (err) {
      modelOptions = [];
      hideModelMenu();
      modelStatus.textContent = (quiet ? '' : t('失败：')) + tf('获取模型列表失败：{0}（仍可手动填写模型名）', errText(err));
      modelStatus.style.color = '';
    } finally {
      fetchingModels = false;
    }
  }
  endpointInput.addEventListener('change', () => fetchModels({ quiet: true })); // 地址填完失焦自动调取
  body.querySelector('#a-model-fetch').addEventListener('click', () => fetchModels());

  // ---- 图像识别（多模态）实时检测提示：随模型名输入变化，主进程词表判定 ----
  const visionSel = body.querySelector('#a-vision');
  const visionHint = body.querySelector('#a-vision-hint');
  async function updVisionHint() {
    if (!visionHint) return;
    const m = modelInput.value.trim();
    try {
      const r = await dp.llmVisionDetect({ model: m });
      if (!m) { visionHint.textContent = t('填好模型名后自动检测是否支持图像输入'); visionHint.style.color = ''; return; }
      visionHint.textContent = r.detected
        ? tf('「{0}」识别为多模态模型，保持「自动检测」即可', m)
        : tf('「{0}」未识别为多模态——若该模型确实支持图像输入，请选「强制开启」', m);
      visionHint.style.color = r.detected ? 'var(--dp-ok)' : '';
    } catch (_) { visionHint.textContent = ''; }
  }
  modelInput.addEventListener('change', updVisionHint);
  updVisionHint();

  body.querySelector('#a-preset').addEventListener('change', (e) => {
    const p = PRESETS.find(x => x.endpoint === e.target.value);
    if (p) {
      endpointInput.value = p.endpoint;
      if (p.model) modelInput.value = p.model;
      fetchModels({ quiet: true }); // 切预设后自动调取该服务商的模型列表
    }
  });
  body.querySelectorAll('input[type=range]').forEach(r => r.addEventListener('input', () => {
    r.closest('.slider-row').querySelector('.val').textContent = r.value;
  }));

  body.querySelector('#a-save').addEventListener('click', async () => {
    const params = {};
    for (const k of ['temperature', 'maxTokens', 'topP', 'frequencyPenalty', 'presencePenalty']) {
      params[k] = +body.querySelector('#a-' + k).value;
    }
    const visionSel = body.querySelector('#a-vision');
    const patch = {
      endpoint: endpointInput.value.trim(),
      model: modelInput.value.trim(),
      params,
      vision: visionSel.value === 'on' ? true : visionSel.value === 'off' ? false : 'auto',
    };
    const key = body.querySelector('#a-key').value.trim();
    try {
      await dp.storeSet('api', patch);
      if (key) await dp.saveApiKey(key);
      toast(t('已保存'), 'ok');
      renderApi();
    } catch (err) { toast(errText(err), 'error'); }
  });

  body.querySelector('#a-test').addEventListener('click', async () => {
    const out = body.querySelector('#a-test-result');
    out.textContent = t('测试中…');
    out.style.color = '';
    // 先保存当前表单再测试
    body.querySelector('#a-save').click();
    const r = await dp.llmTest();
    // 保存会触发 renderApi() 重建 DOM，写入前重新取节点
    const el = body.querySelector('#a-test-result');
    if (el) {
      el.textContent = r.ok ? tf('连接成功，延迟 {0}ms', r.latencyMs) : tf('失败：{0}', r.error);
      el.style.color = r.ok ? 'var(--dp-ok)' : 'var(--dp-danger)';
    }
  });

  // ---- 视频解析区块：工具检测 / 导入 / ASR 配置 ----
  const probeEl = body.querySelector('#vid-probe');
  async function probeVideoTools() {
    if (!probeEl) return;
    probeEl.textContent = t('检测中…');
    try {
      const rt = await dp.videoProbe();
      const fmt = (b, name) => b.found
        ? tf('可用 {0}：{1}{2}', name, b.path, b.version ? `（${b.version}）` : '')
        : tf('不可用 {0}：未找到（导入、填路径或装到 PATH）', name);
      probeEl.innerHTML = `${fmt(rt.ytDlp, 'yt-dlp')}<br>${fmt(rt.ffmpeg, 'ffmpeg')}`;
    } catch (err) { probeEl.textContent = tf('检测失败：{0}', errText(err)); }
  }
  probeVideoTools();
  body.querySelector('#vid-reprobe').addEventListener('click', probeVideoTools);
  for (const [btnId, kind] of [['#vid-import-ytdlp', 'ytDlp'], ['#vid-import-ffmpeg', 'ffmpeg']]) {
    body.querySelector(btnId).addEventListener('click', async () => {
      const p = await dp.pickFile({ title: kind === 'ytDlp' ? t('选择 yt-dlp 可执行文件') : t('选择 ffmpeg 可执行文件'), filters: [{ name: t('可执行文件'), extensions: ['exe'] }] });
      if (!p) return;
      try {
        await dp.videoImportBinary(kind, p);
        toast(t('已导入到数据目录 bin 文件夹'), 'ok');
        probeVideoTools();
      } catch (err) { toast(errText(err), 'error'); }
    });
  }
  body.querySelector('#vid-save').addEventListener('click', async () => {
    const saved = body.querySelector('#vid-saved');
    try {
      await dp.storeSet('settings', {
        video: {
          ytDlpPath: body.querySelector('#vid-ytdlp-path').value.trim(),
          ffmpegPath: body.querySelector('#vid-ffmpeg-path').value.trim(),
        },
      });
      await dp.storeSet('api', {
        asr: {
          baseUrl: body.querySelector('#vid-asr-url').value.trim(),
          model: body.querySelector('#vid-asr-model').value.trim(),
        },
      });
      const key = body.querySelector('#vid-asr-key').value.trim();
      if (key) await dp.videoSaveAsrKey(key);
      saved.textContent = t('已保存');
      saved.style.color = 'var(--dp-ok)';
      setTimeout(() => { if (saved) saved.textContent = ''; }, 1800);
      probeVideoTools();
    } catch (err) { toast(errText(err), 'error'); }
  });

  // ---- Agent 执行区块（即时保存）----
  const agSaved = body.querySelector('#ag-saved');
  const agFlash = () => {
    agSaved.textContent = t('已保存');
    setTimeout(() => { if (agSaved) agSaved.textContent = ''; }, 1500);
  };
  const agEnabled = body.querySelector('#ag-enabled');
  const agRounds = body.querySelector('#ag-rounds');
  const agTimeout = body.querySelector('#ag-timeout');
  const agToolTokens = body.querySelector('#ag-tooltokens');
  const agMode = body.querySelector('#ag-mode');
  const agentPatch = () => ({
    enabled: agEnabled.checked,
    maxRounds: +agRounds.value,
    permissionTimeoutSec: +agTimeout.value,
    permissionMode: agMode.value,
    toolMaxTokens: +agToolTokens.value,
  });
  const saveAgent = () => dp.storeSet('settings', { agent: agentPatch() }).then(agFlash).catch(err => { agSaved.textContent = tf('失败：{0}', errText(err)); });
  agEnabled.addEventListener('change', saveAgent);
  agMode.addEventListener('change', saveAgent);
  for (const r of [agRounds, agTimeout, agToolTokens]) {
    r.addEventListener('input', () => r.closest('.slider-row').querySelector('.val').textContent = r.value + (r === agTimeout ? 's' : ''));
    r.addEventListener('change', saveAgent);
  }

  // ---- 联网搜索区块 ----
  const wsSource = body.querySelector('#ws-source');
  const wsEndpointField = body.querySelector('#ws-endpoint-field');
  const wsKeyHint = body.querySelector('#ws-keyhint');
  const providers = await dp.searchProviders();
  const updProviderHint = () => {
    const p = providers.find(x => x.id === wsSource.value);
    wsKeyHint.textContent = p ? (p.keyHint || '') : '';
    wsEndpointField.style.display = wsSource.value === 'searxng' ? '' : 'none';
  };
  updProviderHint();
  wsSource.addEventListener('change', updProviderHint);
  const wsFlash = (t, okk) => {
    const el = body.querySelector('#ws-test-result');
    if (el) { el.textContent = t; el.style.color = okk === true ? 'var(--dp-ok)' : okk === false ? 'var(--dp-danger)' : ''; }
  };
  const collectWebSearch = () => ({
    enabled: body.querySelector('#ws-enabled').checked,
    autonomousDailyLimit: +body.querySelector('#ws-daily').value,
    cooldownMin: +body.querySelector('#ws-cooldown').value,
    blockedTopics: body.querySelector('#ws-topics').value.split('\n').map(s => s.trim()).filter(Boolean),
  });
  body.querySelector('#ws-save').addEventListener('click', async () => {
    try {
      await dp.storeSet('search', { source: wsSource.value, endpoint: body.querySelector('#ws-endpoint').value.trim() });
      const key = body.querySelector('#ws-key').value.trim();
      if (key) await dp.searchSaveKey(key);
      await dp.storeSet('settings', { agent: { webSearch: collectWebSearch() } });
      toast(t('联网搜索配置已保存'), 'ok');
      renderApi();
    } catch (err) { toast(errText(err), 'error'); }
  });

  // ---- 视觉感知区块（即时保存开关；摄像头无开关、恒为逐次授权卡） ----
  body.querySelector('#vc-screen-enabled')?.addEventListener('change', async (e) => {
    try {
      await dp.storeSet('settings', { agent: { visionCapture: { screenEnabled: e.target.checked } } });
      toast(e.target.checked ? t('桌面查看已开启') : t('桌面查看已关闭'), 'ok');
      renderApi();
    } catch (err) { toast(errText(err), 'error'); }
  });
  body.querySelector('#ws-test').addEventListener('click', async () => {
    wsFlash(t('测试中…'));
    // 先保存当前表单再测试（未保存的 Key 直接可用）
    const src = wsSource.value;
    if (!src) return wsFlash(t('请先选择供应商'), false);
    const key = body.querySelector('#ws-key').value.trim();
    const endpoint = body.querySelector('#ws-endpoint').value.trim();
    let keyForTest = key;
    if (!keyForTest && searchCfg.hasKey && src === searchCfg.source) keyForTest = undefined; // 用已保存的
    try {
      const r = await dp.searchTest({ source: src, endpoint, ...(keyForTest !== undefined ? { key: keyForTest } : {}) });
      wsFlash(r.ok ? tf('连接成功，延迟 {0}ms，返回 {1} 条', r.latencyMs, r.results) : tf('失败：{0}', r.error), r.ok);
    } catch (err) { wsFlash(tf('失败：{0}', errText(err)), false); }
  });
  const wsDaily = body.querySelector('#ws-daily'), wsCooldown = body.querySelector('#ws-cooldown');
  wsDaily.addEventListener('input', () => wsDaily.closest('.slider-row').querySelector('.val').textContent = wsDaily.value);
  wsCooldown.addEventListener('input', () => wsCooldown.closest('.slider-row').querySelector('.val').textContent = wsCooldown.value + ' ' + t('分钟'));
}

// ================= ⑤ 指令 =================
async function renderCommands() {
  const cmds = await dp.launcherList();
  const rows = cmds.map(c => ({ ...c })); // 本地行数组 = UI 真源；空行允许存在，保存时才过滤

  body.innerHTML = `<div class="set-section" style="max-width:760px">
    <h3 style="margin-top:0">${t('启动指令（聊天里说「打开xx」即本地秒开，无需联网）')}</h3>
    <div id="cmdList"></div>
    <div class="row" style="margin-top:10px">
      <button class="btn" id="cmd-add">＋ ${t('添加指令')}</button>
      <span class="grow"></span>
      <button class="btn btn-primary" id="cmd-save">${t('保存')}</button>
    </div>
    <p class="hint">${t('支持：exe（直接启动）、bat/cmd（经 cmd 运行）、html/网址（默认浏览器打开）、其他文件（系统默认程序打开）。切换标签页前会自动保存已填写的行。')}</p>
  </div>`;

  const listEl = body.querySelector('#cmdList');

  function renderRows() {
    listEl.innerHTML = rows.map((c, i) => `
      <div class="cmd-row" data-i="${i}">
        <input type="text" data-f="phrase" value="${esc(c.phrase || '')}" placeholder="${t('指令词，如：打开微信')}">
        <div class="row"><input type="text" data-f="path" value="${esc(c.path || '')}" placeholder="${t('文件路径或网址')}" style="width:100%">
          <button class="btn btn-sm" data-a="pick" title="${t('浏览')}">${icon('folder', 14)}</button></div>
        <input type="text" data-f="args" value="${esc(c.args || '')}" placeholder="${t('参数（可空）')}">
        <span class="small ${c.missing ? '' : 'muted'}" style="width:90px">${c.missing ? t('路径失效') : extOf(c.path)}</span>
        <div class="row"><button class="btn btn-sm" data-a="run">${icon('play', 12)} ${t('试运行')}</button><button class="btn btn-sm btn-icon" data-a="del" title="${t('删除')}">${icon('trash', 15)}</button></div>
      </div>`).join('') || `<div class="hint" style="padding:4px 0">${t('还没有指令。点「＋ 添加指令」创建第一条吧～')}</div>`;
  }

  function collectRows() {
    body.querySelectorAll('.cmd-row').forEach((el, i) => {
      if (!rows[i]) return;
      rows[i].phrase = el.querySelector('[data-f=phrase]').value;
      rows[i].path = el.querySelector('[data-f=path]').value;
      rows[i].args = el.querySelector('[data-f=args]').value;
    });
  }

  // 持久化：只保存填写完整的行，返回带 id 的已存列表
  async function persist() {
    collectRows();
    return dp.launcherSave(rows.filter(r => r.phrase.trim() && r.path.trim()));
  }

  // 切走标签页时自动保存
  tabLeave = async () => { await persist().catch(() => {}); };

  renderRows();

  body.querySelector('#cmd-add').addEventListener('click', () => {
    collectRows();
    rows.push({ phrase: '', path: '', args: '' });
    renderRows();
    const rowEls = listEl.querySelectorAll('.cmd-row');
    const last = rowEls[rowEls.length - 1];
    if (last) last.querySelector('[data-f=phrase]').focus();
  });

  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const rowEl = btn.closest('.cmd-row');
    if (!rowEl) return;
    const i = +rowEl.dataset.i;
    collectRows();
    const r = rows[i];
    if (!r) return;

    if (btn.dataset.a === 'del') {
      rows.splice(i, 1);
      renderRows();
      await persist().catch(() => {});
    }
    if (btn.dataset.a === 'pick') {
      const p = await dp.pickFile({ title: t('选择要打开的程序/文件'), filters: [{ name: t('全部'), extensions: ['exe', 'bat', 'cmd', 'lnk', 'html', 'url', 'txt', 'md', 'pdf', 'doc', 'docx', 'xlsx'] }] });
      if (p) {
        r.path = p;
        renderRows();
        await persist().catch(() => {});
      }
    }
    if (btn.dataset.a === 'run') {
      if (!r.phrase.trim() || !r.path.trim()) return toast(t('请先填写指令词和路径'), 'warn');
      const saved = await persist();
      const hit = saved.find(x => x.phrase === r.phrase.trim() && x.path === r.path.trim());
      if (hit) {
        try { await dp.launcherRun(hit.id); toast(t('已启动'), 'ok'); } catch (err) { toast(errText(err), 'error'); }
      }
    }
  });

  body.querySelector('#cmd-save').addEventListener('click', async () => {
    try {
      await persist();
      const saved = await dp.launcherList();
      rows.length = 0;
      rows.push(...saved.map(c => ({ ...c })));
      renderRows();
      toast(t('已保存'), 'ok');
    } catch (err) { toast(errText(err), 'error'); }
  });
}

function extOf(p) {
  const m = String(p || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '—';
}

// ================= ⑥ 分类 =================
async function renderCategories() {
  const cfg = await dp.storeGet('categories');
  body.innerHTML = `<div class="set-section" style="max-width:760px">
    <h3 style="margin-top:0">${t('应用分类规则')}</h3>
    <p class="hint">${t('匹配优先级：忽略表 → 你的标注 → 自定义规则（最长正则优先）→ 内置预设（常见办公/开发/娱乐/社交应用）→ 未标注。规则按「exe名 或 窗口标题」正则匹配。')}</p>
    <h4>${t('自定义规则')}</h4>
    <div id="ruleList">
      ${(cfg.rules || []).map((r, i) => `
        <div class="rule-row" data-i="${i}">
          <input type="text" data-f="regex" value="${esc(r.regex)}" placeholder="${t('正则，如 (微信|wechat)')}">
          <select data-f="category">${cfg.categories.map(c => `<option ${r.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <button class="btn btn-sm btn-icon" data-a="del" title="${t('删除')}">${icon('trash', 15)}</button>
        </div>`).join('') || `<div class="hint">${t('暂无自定义规则')}</div>`}
    </div>
    <div class="row" style="margin:8px 0 16px"><button class="btn btn-sm" id="rule-add">＋ ${t('添加规则')}</button><span class="grow"></span><button class="btn btn-sm btn-primary" id="rule-save">${t('保存规则')}</button></div>
    <h4>${t('自定义类别')}</h4>
    <div class="row wrap">${cfg.categories.map(c => `<span class="chip">${esc(c)}</span>`).join('')}
      <input type="text" id="cat-new" placeholder="${t('新类别名')}" style="width:110px"><button class="btn btn-sm" id="cat-add">＋</button></div>
    <h4 style="margin-top:18px">${t('忽略列表（不计入统计的 exe，每行一个）')}</h4>
    <p class="hint">${t('已内置常见系统进程。你标注过的应用见「时间统计 → 标注」。')}</p>
  </div>`;

  const collectRules = () => {
    const out = [];
    body.querySelectorAll('.rule-row').forEach(el => {
      const regex = el.querySelector('[data-f=regex]').value.trim();
      const category = el.querySelector('[data-f=category]').value;
      if (regex) out.push({ regex, category });
    });
    return out;
  };
  body.querySelector('#rule-add').addEventListener('click', async () => {
    const rules = collectRules(); rules.push({ regex: '', category: cfg.categories[0] });
    await dp.storeSet('categories', { rules });
    renderCategories();
  });
  body.querySelector('#ruleList').addEventListener('click', async (e) => {
    if (e.target.dataset.a === 'del') {
      const rules = collectRules();
      rules.splice(+e.target.closest('.rule-row').dataset.i, 1);
      await dp.storeSet('categories', { rules });
      renderCategories();
    }
  });
  body.querySelector('#rule-save').addEventListener('click', async () => {
    await dp.storeSet('categories', { rules: collectRules() });
    toast(t('已保存'), 'ok');
  });
  body.querySelector('#cat-add').addEventListener('click', async () => {
    const name = body.querySelector('#cat-new').value.trim();
    if (!name) return;
    if ((cfg.categories || []).includes(name)) return toast(t('已存在'), 'warn');
    await dp.storeSet('categories', { categories: [...(cfg.categories || []), name] });
    renderCategories();
  });
}

// ================= ⑦ 日程偏好 =================
async function renderSchedulePref() {
  const s = (await dp.storeGet('settings')).schedule;
  const N = (id, label, val, min, max, unit) => `
    <div class="field" style="max-width:320px"><span class="label">${label}</span>
      <div class="row"><input type="number" id="s-${id}" min="${min}" max="${max}" value="${val}" style="width:110px"> <span class="hint">${unit}</span></div></div>`;
  body.innerHTML = `<div class="set-section">
    <h3 style="margin-top:0">${t('提醒提前量（分钟）')}</h3>
    ${N('leadEvent', t('事件（约会/会议）提前'), s.leadEvent, 5, 1440, t('分钟'))}
    ${N('leadStart', t('任务开始提前'), s.leadStart, 1, 1440, t('分钟'))}
    ${N('leadDeadline', t('截止（deadline）提前'), s.leadDeadline, 5, 1440, t('分钟'))}
    <h3>${t('提醒行为')}</h3>
    ${N('snoozeMin', t('「稍后提醒」间隔'), s.snoozeMin, 1, 120, t('分钟'))}
    ${N('catchupHours', t('错过补报窗口'), s.catchupHours, 1, 72, t('小时内错过的提醒，启动时汇总补报'))}
    <label class="row" style="gap:8px;margin:6px 0"><input type="checkbox" id="s-sound" ${s.sound !== false ? 'checked' : ''}> ${t('提醒时播放提示音')}</label>
    <label class="row" style="gap:8px"><input type="checkbox" id="s-sys" ${s.systemNotification !== false ? 'checked' : ''}> ${t('同时发送 Windows 系统通知')}</label>
    <p class="hint" style="margin-top:10px">${t('提醒总是弹出宠物气泡（惊讶表情 + 提醒卡）；系统通知可点击跳转日程页。已保存的日程按保存时的设置生成提醒。')}</p>
  </div>`;

  const save = debounce(async () => {
    const g = id => +body.querySelector('#s-' + id).value;
    await dp.storeSet('settings', {
      schedule: {
        leadEvent: g('leadEvent'), leadStart: g('leadStart'), leadDeadline: g('leadDeadline'),
        snoozeMin: g('snoozeMin'), catchupHours: g('catchupHours'),
        sound: body.querySelector('#s-sound').checked,
        systemNotification: body.querySelector('#s-sys').checked,
      },
    });
  }, 400);
  body.querySelectorAll('input').forEach(el => el.addEventListener('input', save));
  body.querySelectorAll('input[type=checkbox]').forEach(el => el.addEventListener('change', save));
}

// ================= ⑧ 关于 =================
async function renderAbout() {
  const info = await dp.appInfo();
  body.innerHTML = `<div class="set-section">
    <h3 style="margin-top:0">${t('deskpal 桌面宠物')}</h3>
    <div class="card" style="max-width:480px">
      <div class="row" style="justify-content:space-between"><span>${t('版本')}</span><b>v${esc(info.version)}</b></div>
      <div class="row" style="justify-content:space-between;margin-top:6px"><span>${t('数据目录')}</span></div>
      <div class="hint" style="user-select:text">${esc(info.dataDir)}</div>
      <button class="btn btn-sm" id="open-data" style="margin-top:10px">${icon('folder', 14)} ${t('打开数据目录')}</button>
    </div>
    <h4>${t('功能速览')}</h4>
    <ul class="hint" style="line-height:2">
      <li>${icon('message', 14)} <b>${t('角色扮演')}</b>：${t('双击宠物开聊；回复附带的情绪会实时驱动表情')}</li>
      <li>${icon('bolt', 14)} <b>${t('快问速答')}</b>：${t('聊天窗第二标签，直接了当的问答')}</li>
      <li>${icon('book', 14)} <b>${t('书籍陪读')}</b>：${t('上传 txt/pdf/doc/docx，生成剧情陪读，随时举手提问')}</li>
      <li>⏱ <b>${t('时间管理')}</b>：${t('后台记录应用使用；空闲回来会请你标注陌生应用；可生成 AI 报告')}</li>
      <li>${icon('terminal', 14)} <b>${t('启动器')}</b>：${t('「打开xx」本地秒开，在指令页配置')}</li>
      <li>${icon('calendar', 14)} <b>${t('日程提醒')}</b>：${t('一句话或 Excel 项目表 → 自动提醒（气泡 + 系统通知）')}</li>
      <li>${icon('lock', 14)} <b>${t('权限')}</b>：${t('只读非敏感文件；写入仅限本应用数据目录')}</li>
    </ul>
  </div>`;
  body.querySelector('#open-data').addEventListener('click', () => dp.openPath(info.dataDir));
}

// ================= 启动 =================
(async function boot() {
  await initTheme();
  let initialTab = 'persona';
  // 其他窗口可指定打开的标签（settings:changed {tab)
  dp.on('settings:changed', ({ tab }) => {
    const keys = TAB_GROUPS.flatMap(([, items]) => items.map(([k]) => k));
    if (tab && keys.includes(tab)) switchTab(tab);
  });
  // 宪法篡改事故推送（risk note R3）：主进程弹窗之外，设置页常驻刷新告警
  dp.on('canon:incident', (incident) => {
    toast(tf('人格宪法锁层告警：{0}', (incident && incident.note) || t('canon 与封存不一致，已自动恢复')), 'error');
    if (root.querySelector('.nav-item.active')?.dataset.tab === 'persona') renderPersona();
  });
  switchTab(initialTab);
})();
