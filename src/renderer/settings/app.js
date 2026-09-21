// 设置页：人设 / 形象 / 配色 / API / 指令 / 分类 / 日程偏好 / 关于 —— 全部即时保存
import { dp, initTheme, esc, errText, debounce } from '../common/ipc.js';
import { toast, confirmBox } from '../common/ui.js';
import { mountTitlebar } from '../common/windows/titlebar.js';
import { renderPet, EMOTION_KEYS } from '../pet/sprite.js';

const EMO_CN = { normal: '平常', happy: '开心', surprised: '惊讶', angry: '愤怒', thinking: '思考', sad: '悲伤' };

const app = document.getElementById('app');
app.appendChild(mountTitlebar('deskpal · 设置'));

const TABS = [
  ['persona', '🐱 人设'], ['sprite', '🎨 形象'], ['theme', '🌈 配色'], ['api', '🔌 API'],
  ['commands', '🚀 指令'], ['categories', '🏷 分类'], ['schedule', '⏰ 日程偏好'], ['about', 'ℹ️ 关于'],
];

const root = document.createElement('div');
root.className = 'set-wrap';
root.innerHTML = `
  <div class="side-nav">${TABS.map(([k, n]) => `<div class="nav-item" data-tab="${k}">${n}</div>`).join('')}</div>
  <div class="set-body" id="body"></div>`;
app.appendChild(root);
const body = root.querySelector('#body');

let tabLeave = null; // 当前标签页的离开钩子（如：指令页自动保存）

function switchTab(tab) {
  if (tabLeave) { const leave = tabLeave; tabLeave = null; leave().catch(() => {}); }
  root.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === tab));
  ({ persona: renderPersona, sprite: renderSprite, theme: renderTheme, api: renderApi,
     commands: renderCommands, categories: renderCategories, schedule: renderSchedulePref, about: renderAbout }[tab] || renderAbout)();
}

root.querySelector('.side-nav').addEventListener('click', (e) => {
  const t = e.target.closest('.nav-item');
  if (t) switchTab(t.dataset.tab);
});

const saveDebounced = debounce((name, patch) => dp.storeSet(name, patch).catch(err => toast(errText(err), 'error')), 300);

// ================= ① 人设 =================
async function renderPersona() {
  const p = await dp.storeGet('persona');
  const pet = p.pet, user = p.user;
  const F = (id, label, val, ph = '') =>
    `<div class="field"><span class="label">${label}</span><textarea id="${id}" rows="${id.includes('catchphrases') ? 2 : 3}" placeholder="${ph}">${esc(val || '')}</textarea></div>`;
  body.innerHTML = `<div class="set-section">
    <div class="card" id="profileCard" style="margin-bottom:18px">
      <div class="row"><b>📦 宠物设定档案</b><span class="hint grow" style="margin-left:8px">人设 + 形象差分图 + 缩放绑定为完整设定；可保存多套、一键切换、导出 .pet.json 分享</span></div>
      <div class="row" style="margin:10px 0 4px">
        <input type="text" id="profName" placeholder="设定名称，如：缇托·日常版" style="width:210px">
        <button class="btn btn-sm btn-primary" id="profSave">💾 保存当前设定</button>
        <button class="btn btn-sm" id="profImport">📥 导入设定文件</button>
      </div>
      <div id="profList"></div>
    </div>
    <div id="personaForm">
    <h3 style="margin-top:0">宠物人设</h3>
    <div class="row" style="gap:12px">
      <div class="field grow"><span class="label">名字</span><input type="text" id="p-name" value="${esc(pet.name)}" maxlength="12"></div>
      <div class="field grow"><span class="label">语言</span>
        <select id="p-language">${['中文', 'English', '日本語', '中英混合'].map(l => `<option ${pet.language === l ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="field"><span class="label">一句话简介</span><input type="text" id="p-tagline" value="${esc(pet.tagline)}" style="width:100%"></div>
    ${F('p-appearance', '外貌', pet.appearance)}
    ${F('p-personality', '性格', pet.personality)}
    ${F('p-speechStyle', '说话风格', pet.speechStyle)}
    ${F('p-catchphrases', '口头禅（每行一句；句中可用 [开心] [惊讶] [悲伤] 等标签，点到这句时宠物会同步切换成对应表情）', pet.catchphrases)}
    ${F('p-background', '背景故事', pet.background)}
    ${F('p-emotionalPatterns', '情绪模式', pet.emotionalPatterns)}
    ${F('p-taboos', '禁忌（绝对不做）', pet.taboos)}
    ${F('p-thinkingLogic', '思维逻辑', pet.thinkingLogic)}
    ${F('p-customPrompt', '自定义指令（附加到 system prompt 末尾）', pet.customPrompt)}
    <h3>对话对象（主人）</h3>
    <div class="row" style="gap:12px">
      <div class="field grow"><span class="label">称呼</span><input type="text" id="u-name" value="${esc(user.name)}" maxlength="12"></div>
    </div>
    <div class="field"><span class="label">介绍（宠物眼中的你，帮助对话更贴心）</span><textarea id="u-description" rows="2">${esc(user.description || '')}</textarea></div>
    <details><summary style="cursor:pointer;font-size:13px;color:var(--dp-text-muted)">👁 实时预览：角色扮演 system prompt</summary>
      <div class="prompt-preview" id="promptPreview" style="margin-top:8px"></div></details>
    </div>
  </div>`;

  const collect = () => ({
    pet: {
      name: v('p-name'), tagline: v('p-tagline'), appearance: v('p-appearance'), personality: v('p-personality'),
      speechStyle: v('p-speechStyle'), catchphrases: v('p-catchphrases'), background: v('p-background'),
      emotionalPatterns: v('p-emotionalPatterns'), taboos: v('p-taboos'), thinkingLogic: v('p-thinkingLogic'),
      customPrompt: v('p-customPrompt'), language: sel('p-language'),
    },
    user: { name: v('u-name'), description: v('u-description') },
  });
  const v = id => body.querySelector('#' + id).value;
  const sel = id => body.querySelector('#' + id).value;

  const onChange = debounce(async () => {
    await dp.storeSet('persona', collect());
    const sys = await dp.buildSystemPreview();
    body.querySelector('#promptPreview').textContent = sys;
  }, 400);

  const formEl = body.querySelector('#personaForm');
  formEl.querySelectorAll('input,textarea,select').forEach(el => el.addEventListener('input', onChange));
  // 初始预览
  dp.buildSystemPreview().then(s => { const el = body.querySelector('#promptPreview'); if (el) el.textContent = s; });

  // ---- 宠物设定档案 ----
  body.querySelector('#profSave').addEventListener('click', async () => {
    const name = body.querySelector('#profName').value;
    try {
      await dp.petsSave(name);
      toast(`已保存设定「${name || '未命名'}」`, 'ok');
      loadProfiles();
    } catch (err) { toast(errText(err), 'error'); }
  });
  body.querySelector('#profImport').addEventListener('click', async () => {
    try {
      const r = await dp.petsImport();
      if (!r) return;
      toast(`已导入「${r.importedName}」，点击列表中的「应用」即可切换`, 'ok');
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
  host.innerHTML = profiles.length ? '' : '<div class="hint" style="padding:4px 0">还没有保存的设定。调好人设和形象后，起个名字保存下来吧～</div>';
  for (const p of profiles) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cssText = 'padding:6px 0;border-bottom:1px dashed var(--dp-border)';
    row.innerHTML = `<b>${esc(p.name)}</b>
      <span class="hint">${esc(p.petName ? p.petName + ' · ' : '')}${esc(String(p.createdAt || '').replace('T', ' ').slice(0, 16))}${p.hasImage ? ' · 含差分图' : ''}</span>
      <span class="grow"></span>
      <button class="btn btn-sm btn-primary" data-a="apply" data-id="${p.id}">应用</button>
      <button class="btn btn-sm" data-a="export" data-id="${p.id}">导出</button>
      <button class="btn btn-sm btn-icon" data-a="del" data-id="${p.id}" title="删除">🗑</button>`;
    row.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const { a, id } = btn.dataset;
      try {
        if (a === 'apply') {
          const r = await dp.petsApply(id);
          toast(`已应用「${r.applied}」，人设与形象已切换`, 'ok');
          switchTab('persona'); // 重载表单显示已应用的档案内容
        } else if (a === 'export') {
          const saved = await dp.petsExport(id);
          if (saved) toast('已导出：' + saved, 'ok');
        } else if (a === 'del') {
          if (await confirmBox('删除这个设定档案？（不影响当前使用中的人设和形象）', { danger: true, okText: '删除' })) {
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
    <h3 style="margin-top:0">表情差分图（默认为内置角色缇托）</h3>
    <div class="sprite-grid">
      ${EMOTION_KEYS.map(k => `
        <div class="slot-card card" data-emo="${k}">
          <div class="preview" id="pv-${k}"></div>
          <div class="name">${EMO_CN[k]}</div>
          <div class="btns">
            <button class="btn btn-sm" data-a="upload">上传图片</button>
            <button class="btn btn-sm" data-a="reset" ${(sprites.slots[k] || {}).mode === 'image' ? '' : 'disabled'}>恢复默认</button>
          </div>
        </div>`).join('')}
    </div>
    <p class="hint">支持 png / jpg / webp / gif，≤8MB。上传后聊天/陪读中宠物切换到该表情时显示你的图片；「恢复默认」回到内置角色缇托。</p>
    <div class="field" style="max-width:340px;margin-top:14px">
      <span class="label">整体缩放：${(settings.pet.scale || 1).toFixed(2)}×</span>
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
        const p = await dp.pickFile({ title: `选择「${EMO_CN[emo]}」表情图`, filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
        if (!p) return;
        try {
          const sprites2 = await dp.spritesUpload(emo, p);
          renderPet(body.querySelector('#pv-' + emo), emo, sprites2.slots[emo]);
          card.querySelector('[data-a=reset]').disabled = false;
          toast(`${EMO_CN[emo]} 已更新`, 'ok');
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
    scale.closest('.field').querySelector('.label').textContent = `整体缩放：${(+scale.value).toFixed(2)}×`;
    updScale();
  });
}

// ================= ③ 配色 =================
async function renderTheme() {
  const theme = await dp.themeGet();
  const presets = await dp.themePresets();
  body.innerHTML = `<div class="set-section">
    <h3 style="margin-top:0">按钮与强调色</h3>
    <div class="accent-grid">
      ${presets.map(p => `
        <div class="accent-card ${theme.accent.toLowerCase() === p.accent.toLowerCase() ? 'active' : ''}" data-color="${p.accent}">
          <div class="swatch" style="background:${p.accent}"></div>${p.name}
        </div>`).join('')}
      <div class="accent-card" data-custom="1">
        <div class="swatch" style="background:${theme.accent};display:flex;align-items:center;justify-content:center;color:#fff">🎨</div>自定义
      </div>
    </div>
    <div class="row" style="margin-top:14px;gap:10px">
      <input type="color" id="accentPick" value="${theme.accent}" style="width:52px;height:36px">
      <span class="hint">点色块自定义任意颜色</span>
    </div>
    <h3>明暗模式</h3>
    <div class="row">
      ${[['light', '☀️ 浅色'], ['dark', '🌙 深色'], ['system', '🖥 跟随系统']].map(([v, l]) => `
        <label class="chip clickable"><input type="radio" name="mode" value="${v}" ${theme.mode === v ? 'checked' : ''}> ${l}</label>`).join('')}
    </div>
    <p class="hint">配色对所有窗口即时生效（气泡、按钮、统计图…）。</p>
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
}

// ================= ④ API =================
async function renderApi() {
  const api = await dp.storeGet('api');
  const settings = await dp.storeGet('settings');
  const agent = settings.agent || { enabled: true, maxRounds: 8, permissionTimeoutSec: 120, permissionMode: 'read' };
  const PRESETS = [
    { name: '自定义', endpoint: '', model: '' },
    { name: 'DeepSeek', endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' },
    { name: '智谱 GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4' },
    { name: 'Kimi', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
    { name: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
    { name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  ];
  const cur = PRESETS.find(p => p.endpoint === api.endpoint) || PRESETS[0];
  const P = api.params || {};

  body.innerHTML = `<div class="set-section">
    <h3 style="margin-top:0">LLM 接口（OpenAI 兼容协议）</h3>
    <div class="field"><span class="label">接口预设</span>
      <select id="a-preset">${PRESETS.map(p => `<option value="${esc(p.endpoint)}" ${cur.name === p.name ? 'selected' : ''}>${p.name}</option>`).join('')}</select></div>
    <div class="field"><span class="label">接口地址（填 base 地址或完整 chat/completions 地址均可）</span><input type="text" id="a-endpoint" value="${esc(api.endpoint)}" style="width:100%"></div>
    <div class="field"><span class="label">模型名（填好地址与 Key 后自动获取，点击输入框从列表选择）</span>
      <div class="row" style="gap:8px">
        <input type="text" id="a-model" value="${esc(api.model)}" list="a-model-list" style="flex:1" autocomplete="off">
        <button class="btn btn-sm" id="a-model-fetch" title="从接口拉取可用模型列表">🔄 获取模型</button>
      </div>
      <datalist id="a-model-list"></datalist>
      <div class="hint" id="a-model-status"></div></div>
    <div class="field"><span class="label">API Key（${api.hasKey ? '已配置 ●' : '未配置'}，经系统安全存储加密）</span>
      <input type="password" id="a-key" placeholder="${api.hasKey ? '留空则不修改' : 'sk-...'}" autocomplete="new-password"></div>
    <details style="margin:8px 0 14px"><summary style="cursor:pointer;font-size:13px;color:var(--dp-text-muted)">⚙️ 高级参数</summary>
      <div style="margin-top:10px">
        ${[['temperature', '温度', 0, 2, 0.05], ['maxTokens', '最大 tokens', 256, 8192, 128], ['topP', 'top_p', 0, 1, 0.05], ['frequencyPenalty', '频率惩罚', 0, 2, 0.05], ['presencePenalty', '存在惩罚', 0, 2, 0.05]]
          .map(([k, label, min, max, step]) => `
          <div class="field"><span class="label">${label}</span>
            <div class="slider-row"><input type="range" id="a-${k}" min="${min}" max="${max}" step="${step}" value="${P[k] ?? 0}"><span class="val">${P[k] ?? 0}</span></div>
          </div>`).join('')}
      </div></details>
    <div class="row">
      <button class="btn btn-primary" id="a-save">保存配置</button>
      <button class="btn" id="a-test">测试连接</button>
      <span class="hint" id="a-test-result"></span>
    </div>
    <p class="hint">聊天、陪读剧情生成、日程解析、时间报告都需要它。Key 使用 Windows 凭据保护（safeStorage）加密存储。</p>
  </div>
  <div class="set-section">
    <h3 style="margin-top:0">🤖 Agent 执行（实验功能）</h3>
    <p class="hint">在「角色扮演」聊天中执行文件任务：读取 / 列目录 / 写文件。文件权限三档可在聊天窗底部随时切换（此处同步修改）：</p>
    <div class="field"><span class="label">文件权限模式（对下一次任务生效）</span>
      <select id="ag-mode" style="max-width:360px">
        <option value="read" ${agent.permissionMode === 'read' ? 'selected' : ''}>🔒 只读——只能读取和列目录，不写文件</option>
        <option value="userData" ${agent.permissionMode === 'userData' ? 'selected' : ''}>📝 可编辑——应用数据目录（deskpal 文件夹）及其子目录内可写</option>
        <option value="full" ${agent.permissionMode === 'full' ? 'selected' : ''}>⚠️ 完全编辑——本机大部分目录可读写（核心系统目录除外，每次写入需批准）</option>
      </select></div>
    <div class="field"><span class="label">启用 Agent 文件任务执行</span>
      <label style="display:flex;gap:6px;align-items:center;font-size:13px">
        <input type="checkbox" id="ag-enabled" ${agent.enabled ? 'checked' : ''}>
        允许宠物在聊天中调用工具读写文件
      </label></div>
    <div class="field"><span class="label">最大执行轮次（4–16，超出后强制收尾作答）</span>
      <div class="slider-row"><input type="range" id="ag-rounds" min="4" max="16" step="1" value="${agent.maxRounds}"><span class="val">${agent.maxRounds}</span></div></div>
    <div class="field"><span class="label">权限卡超时（60–300 秒，超时按拒绝处理）</span>
      <div class="slider-row"><input type="range" id="ag-timeout" min="60" max="300" step="10" value="${agent.permissionTimeoutSec}"><span class="val">${agent.permissionTimeoutSec}s</span></div></div>
    <div class="row"><span class="hint" id="ag-saved"></span></div>
  </div>`;

  // ---- 模型列表自动获取（类似 CC Switch：填好地址 + Key → 拉取 /models → 下拉选择） ----
  const endpointInput = body.querySelector('#a-endpoint');
  const modelInput = body.querySelector('#a-model');
  const modelList = body.querySelector('#a-model-list');
  const modelStatus = body.querySelector('#a-model-status');
  let fetchingModels = false;
  async function fetchModels({ quiet = false } = {}) {
    const endpoint = endpointInput.value.trim();
    if (!endpoint) { modelStatus.textContent = ''; return; }
    if (fetchingModels) return;
    fetchingModels = true;
    modelStatus.textContent = '⏳ 正在获取模型列表…';
    modelStatus.style.color = '';
    try {
      const key = body.querySelector('#a-key').value.trim(); // 未保存的新 Key 也可直接用
      const r = await dp.llmListModels({ endpoint, key });
      modelList.innerHTML = (r.models || []).map(m => `<option value="${esc(m)}"></option>`).join('');
      modelStatus.textContent = r.models.length
        ? `✓ 已获取 ${r.models.length} 个模型，点击「模型名」输入框即可选择`
        : '接口未返回任何模型，可手动填写模型名';
      modelStatus.style.color = r.models.length ? 'var(--dp-ok)' : '';
    } catch (err) {
      modelList.innerHTML = '';
      modelStatus.textContent = (quiet ? '' : '✗ ') + `获取模型列表失败：${errText(err)}（仍可手动填写模型名）`;
      modelStatus.style.color = '';
    } finally {
      fetchingModels = false;
    }
  }
  endpointInput.addEventListener('change', () => fetchModels({ quiet: true })); // 地址填完失焦自动调取
  body.querySelector('#a-model-fetch').addEventListener('click', () => fetchModels());

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
    const patch = {
      endpoint: endpointInput.value.trim(),
      model: modelInput.value.trim(),
      params,
    };
    const key = body.querySelector('#a-key').value.trim();
    try {
      await dp.storeSet('api', patch);
      if (key) await dp.saveApiKey(key);
      toast('已保存', 'ok');
      renderApi();
    } catch (err) { toast(errText(err), 'error'); }
  });

  body.querySelector('#a-test').addEventListener('click', async () => {
    const out = body.querySelector('#a-test-result');
    out.textContent = '测试中…';
    out.style.color = '';
    // 先保存当前表单再测试
    body.querySelector('#a-save').click();
    const r = await dp.llmTest();
    // 保存会触发 renderApi() 重建 DOM，写入前重新取节点
    const el = body.querySelector('#a-test-result');
    if (el) {
      el.textContent = r.ok ? `✓ 连接成功，延迟 ${r.latencyMs}ms` : `✗ ${r.error}`;
      el.style.color = r.ok ? 'var(--dp-ok)' : 'var(--dp-danger)';
    }
  });

  // ---- Agent 执行区块（即时保存）----
  const agSaved = body.querySelector('#ag-saved');
  const agFlash = () => {
    agSaved.textContent = '✓ 已保存';
    setTimeout(() => { if (agSaved) agSaved.textContent = ''; }, 1500);
  };
  const agEnabled = body.querySelector('#ag-enabled');
  const agRounds = body.querySelector('#ag-rounds');
  const agTimeout = body.querySelector('#ag-timeout');
  const agMode = body.querySelector('#ag-mode');
  const agentPatch = () => ({
    enabled: agEnabled.checked,
    maxRounds: +agRounds.value,
    permissionTimeoutSec: +agTimeout.value,
    permissionMode: agMode.value,
  });
  const saveAgent = () => dp.storeSet('settings', { agent: agentPatch() }).then(agFlash).catch(err => { agSaved.textContent = '✗ ' + errText(err); });
  agEnabled.addEventListener('change', saveAgent);
  agMode.addEventListener('change', saveAgent);
  for (const r of [agRounds, agTimeout]) {
    r.addEventListener('input', () => r.closest('.slider-row').querySelector('.val').textContent = r.value + (r === agTimeout ? 's' : ''));
    r.addEventListener('change', saveAgent);
  }
}

// ================= ⑤ 指令 =================
async function renderCommands() {
  const cmds = await dp.launcherList();
  const rows = cmds.map(c => ({ ...c })); // 本地行数组 = UI 真源；空行允许存在，保存时才过滤

  body.innerHTML = `<div class="set-section" style="max-width:760px">
    <h3 style="margin-top:0">启动指令（聊天里说「打开xx」即本地秒开，无需联网）</h3>
    <div id="cmdList"></div>
    <div class="row" style="margin-top:10px">
      <button class="btn" id="cmd-add">＋ 添加指令</button>
      <span class="grow"></span>
      <button class="btn btn-primary" id="cmd-save">保存</button>
    </div>
    <p class="hint">支持：exe（直接启动）、bat/cmd（经 cmd 运行）、html/网址（默认浏览器打开）、其他文件（系统默认程序打开）。切换标签页前会自动保存已填写的行。</p>
  </div>`;

  const listEl = body.querySelector('#cmdList');

  function renderRows() {
    listEl.innerHTML = rows.map((c, i) => `
      <div class="cmd-row" data-i="${i}">
        <input type="text" data-f="phrase" value="${esc(c.phrase || '')}" placeholder="指令词，如：打开微信">
        <div class="row"><input type="text" data-f="path" value="${esc(c.path || '')}" placeholder="文件路径或网址" style="width:100%">
          <button class="btn btn-sm" data-a="pick" title="浏览">📁</button></div>
        <input type="text" data-f="args" value="${esc(c.args || '')}" placeholder="参数（可空）">
        <span class="small ${c.missing ? '' : 'muted'}" style="width:90px">${c.missing ? '⚠️ 路径失效' : extOf(c.path)}</span>
        <div class="row"><button class="btn btn-sm" data-a="run">▶ 试运行</button><button class="btn btn-sm btn-icon" data-a="del" title="删除">🗑</button></div>
      </div>`).join('') || '<div class="hint" style="padding:4px 0">还没有指令。点「＋ 添加指令」创建第一条吧～</div>';
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
      const p = await dp.pickFile({ title: '选择要打开的程序/文件', filters: [{ name: '全部', extensions: ['exe', 'bat', 'cmd', 'lnk', 'html', 'url', 'txt', 'md', 'pdf', 'doc', 'docx', 'xlsx'] }] });
      if (p) {
        r.path = p;
        renderRows();
        await persist().catch(() => {});
      }
    }
    if (btn.dataset.a === 'run') {
      if (!r.phrase.trim() || !r.path.trim()) return toast('请先填写指令词和路径', 'warn');
      const saved = await persist();
      const hit = saved.find(x => x.phrase === r.phrase.trim() && x.path === r.path.trim());
      if (hit) {
        try { await dp.launcherRun(hit.id); toast('已启动', 'ok'); } catch (err) { toast(errText(err), 'error'); }
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
      toast('已保存', 'ok');
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
    <h3 style="margin-top:0">应用分类规则</h3>
    <p class="hint">匹配优先级：忽略表 → 你的标注 → 自定义规则（最长正则优先）→ 内置预设（常见办公/开发/娱乐/社交应用）→ 未标注。规则按「exe名 或 窗口标题」正则匹配。</p>
    <h4>自定义规则</h4>
    <div id="ruleList">
      ${(cfg.rules || []).map((r, i) => `
        <div class="rule-row" data-i="${i}">
          <input type="text" data-f="regex" value="${esc(r.regex)}" placeholder="正则，如 (微信|wechat)">
          <select data-f="category">${cfg.categories.map(c => `<option ${r.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <button class="btn btn-sm btn-icon" data-a="del">🗑</button>
        </div>`).join('') || '<div class="hint">暂无自定义规则</div>'}
    </div>
    <div class="row" style="margin:8px 0 16px"><button class="btn btn-sm" id="rule-add">＋ 添加规则</button><span class="grow"></span><button class="btn btn-sm btn-primary" id="rule-save">保存规则</button></div>
    <h4>自定义类别</h4>
    <div class="row wrap">${cfg.categories.map(c => `<span class="chip">${esc(c)}</span>`).join('')}
      <input type="text" id="cat-new" placeholder="新类别名" style="width:110px"><button class="btn btn-sm" id="cat-add">＋</button></div>
    <h4 style="margin-top:18px">忽略列表（不计入统计的 exe，每行一个）</h4>
    <p class="hint">已内置常见系统进程。你标注过的应用见「时间统计 → 标注」。</p>
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
    toast('已保存', 'ok');
  });
  body.querySelector('#cat-add').addEventListener('click', async () => {
    const name = body.querySelector('#cat-new').value.trim();
    if (!name) return;
    if ((cfg.categories || []).includes(name)) return toast('已存在', 'warn');
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
    <h3 style="margin-top:0">提醒提前量（分钟）</h3>
    ${N('leadEvent', '事件（约会/会议）提前', s.leadEvent, 5, 1440, '分钟')}
    ${N('leadStart', '任务开始提前', s.leadStart, 1, 1440, '分钟')}
    ${N('leadDeadline', '截止（deadline）提前', s.leadDeadline, 5, 1440, '分钟')}
    <h3>提醒行为</h3>
    ${N('snoozeMin', '「稍后提醒」间隔', s.snoozeMin, 1, 120, '分钟')}
    ${N('catchupHours', '错过补报窗口', s.catchupHours, 1, 72, '小时内错过的提醒，启动时汇总补报')}
    <label class="row" style="gap:8px;margin:6px 0"><input type="checkbox" id="s-sound" ${s.sound !== false ? 'checked' : ''}> 提醒时播放提示音</label>
    <label class="row" style="gap:8px"><input type="checkbox" id="s-sys" ${s.systemNotification !== false ? 'checked' : ''}> 同时发送 Windows 系统通知</label>
    <p class="hint" style="margin-top:10px">提醒总是弹出宠物气泡（惊讶表情 + 提醒卡）；系统通知可点击跳转日程页。已保存的日程按保存时的设置生成提醒。</p>
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
    <h3 style="margin-top:0">deskpal 桌面宠物</h3>
    <div class="card" style="max-width:480px">
      <div class="row" style="justify-content:space-between"><span>版本</span><b>v${esc(info.version)}</b></div>
      <div class="row" style="justify-content:space-between;margin-top:6px"><span>数据目录</span></div>
      <div class="hint" style="user-select:text">${esc(info.dataDir)}</div>
      <button class="btn btn-sm" id="open-data" style="margin-top:10px">📂 打开数据目录</button>
    </div>
    <h4>功能速览</h4>
    <ul class="hint" style="line-height:2">
      <li>💬 <b>角色扮演</b>：双击宠物开聊；回复附带的情绪会实时驱动表情</li>
      <li>⚡ <b>快问速答</b>：聊天窗第二标签，直接了当的问答</li>
      <li>📖 <b>书籍陪读</b>：上传 txt/pdf/doc/docx，生成剧情陪读，随时举手提问</li>
      <li>⏱ <b>时间管理</b>：后台记录应用使用；空闲回来会请你标注陌生应用；可生成 AI 报告</li>
      <li>🚀 <b>启动器</b>：「打开xx」本地秒开，在指令页配置</li>
      <li>📅 <b>日程提醒</b>：一句话或 Excel 项目表 → 自动提醒（气泡 + 系统通知）</li>
      <li>🔒 <b>权限</b>：只读非敏感文件；写入仅限本应用数据目录</li>
    </ul>
  </div>`;
  body.querySelector('#open-data').addEventListener('click', () => dp.openPath(info.dataDir));
}

// ================= 启动 =================
(async function boot() {
  await initTheme();
  let initialTab = 'persona';
  // 其他窗口可指定打开的标签（settings:changed {tab})
  dp.on('settings:changed', ({ tab }) => { if (tab && TABS.some(([k]) => k === tab)) switchTab(tab); });
  switchTab(initialTab);
})();
