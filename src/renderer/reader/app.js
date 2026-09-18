// 陪读窗：书库 → 生成进度 → galgame 放映（打字机/自动/历史/测验/黑板/举手提问）
import { dp, initTheme, errText, esc } from '../common/ipc.js';
import { renderMD } from '../common/md.js';
import { toast, confirmBox, openModal } from '../common/ui.js';
import { mountTitlebar } from '../common/windows/titlebar.js';
import { renderPet } from '../pet/sprite.js';

const app = document.getElementById('app');
app.appendChild(mountTitlebar('deskpal · 陪读'));

const root = document.createElement('div');
root.className = 'reader-wrap';
app.appendChild(root);

let books = [];
let lib = null;            // 当前书存档
let cursorIdx = 0;         // 当前帧下标
let typing = null;         // 打字机状态
let autoPlay = false;
let lastQuizPick = null;   // {correct}
let qaStreaming = null;
let petDisplayName = '缇托'; // 宠物说话人名（跟随人设）
let masterDisplayName = '主人'; // 对话对象称呼（跟随人设）
let sprites = { slots: {} };  // 差分图映射（跟随设置）
let stageCfg = { background: '', petScale: 1, petX: 50, petY: 40, splitPct: 58, dialog: { bg: '', family: '', size: 0, color: '' } }; // 放映舞台：背景/角色大小位置/左右比例/文字框样式
let sizeSaveTimer = null;

function fileUrl(p) {
  return 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/#/g, '%23');
}

function slotOf(emo) { return (sprites.slots && sprites.slots[emo]) || { mode: 'svg' }; }

// 把舞台配置（背景图/角色位置大小/左右比例/文字框样式）应用到放映场景
function applyStage() {
  const scene = root.querySelector('.gal-scene');
  const pet = root.querySelector('#galPet');
  if (!scene || !pet) return;
  scene.style.backgroundImage = stageCfg.background ? `url("${fileUrl(stageCfg.background)}")` : 'none';
  pet.style.left = (Number.isFinite(+stageCfg.petX) ? +stageCfg.petX : 50) + '%';
  pet.style.top = (Number.isFinite(+stageCfg.petY) ? +stageCfg.petY : 40) + '%';
  const sz = Math.round(120 * Math.min(2.2, Math.max(0.4, +stageCfg.petScale || 1)));
  pet.style.width = sz + 'px';
  pet.style.height = sz + 'px';
  const left = root.querySelector('#stageLeft');
  if (left && Number.isFinite(+stageCfg.splitPct)) left.style.width = Math.min(75, Math.max(30, +stageCfg.splitPct)) + '%';
  applyDialogStyle();
}

// 文字框自定义样式（背景色/字体/字号/字色）：以 CSS 变量注入场景，随帧重建自动生效
function applyDialogStyle() {
  const scene = root.querySelector('.gal-scene');
  if (!scene) return;
  const d = stageCfg.dialog || {};
  const set = (k, v) => { if (v) scene.style.setProperty(k, v); else scene.style.removeProperty(k); };
  set('--dlg-bg', d.bg);
  set('--dlg-font', d.family);
  set('--dlg-size', d.size ? d.size + 'px' : '');
  set('--dlg-color', d.color);
}

function saveStage() {
  dp.storeSet('settings', { reader: stageCfg }).catch(() => {});
}

// 角色拖拽定位（松手保存）
function enablePetDrag(pet) {
  let drag = null;
  pet.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const rect = pet.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    pet.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  pet.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const scene = root.querySelector('.gal-scene');
    if (!scene) return;
    const r = scene.getBoundingClientRect();
    stageCfg.petX = Math.min(100, Math.max(0, ((e.clientX - drag.dx - r.left) / r.width) * 100));
    stageCfg.petY = Math.min(100, Math.max(0, ((e.clientY - drag.dy - r.top) / r.height) * 100));
    pet.style.left = stageCfg.petX + '%';
    pet.style.top = stageCfg.petY + '%';
  });
  const done = () => { if (drag) { drag = null; saveStage(); } };
  pet.addEventListener('pointerup', done);
  pet.addEventListener('pointercancel', done);
}

// ================= 书库视图 =================
function renderLibrary() {
  lib = null;
  root.innerHTML = `
    <div class="lib-toolbar">
      <button class="btn btn-primary" id="uploadBtn">📄 上传书籍 / 论文</button>
      <span class="hint">支持 txt / md / pdf / doc / docx，解析后 AI 生成陪读剧情（需已配置 API）</span>
    </div>
    <div class="lib-list" id="libList"></div>`;
  const listEl = root.querySelector('#libList');
  if (!books.length) {
    listEl.innerHTML = `<div class="empty">还没有书。<br>上传一本，我来陪你读～</div>`;
  }
  for (const b of books) {
    const card = document.createElement('div');
    card.className = 'book-card card';
    const statusMap = { parsed: ['parsed', '待生成'], generating: ['generating', '生成中'], ready: ['ready', `可续读${b.hasCursor ? '' : ''}`], error: ['error', '失败'] };
    const [cls, txt] = statusMap[b.status] || ['parsed', b.status];
    card.innerHTML = `
      <div class="cover">📖</div>
      <div class="info">
        <div class="title">${esc(b.title)}</div>
        <div class="sub">
          <span class="status-chip ${cls}">${txt}</span>
          ${b.frames ? ` · ${b.frames} 帧` : ''}${b.qa ? ` · 问过 ${b.qa} 次` : ''}${b.meta?.chars ? ` · ${(b.meta.chars / 10000).toFixed(1)} 万字` : ''}
        </div>
      </div>
      <div class="row">
        ${b.status === 'ready' ? `<button class="btn btn-sm btn-primary" data-a="play">▶ ${b.hasCursor ? '继续' : '开始陪读'}</button>` : ''}
        ${b.status === 'parsed' ? `<button class="btn btn-sm btn-primary" data-a="gen">✨ 生成剧情</button>` : ''}
        ${b.status === 'generating' ? `<button class="btn btn-sm" data-a="view">查看进度</button>` : ''}
        ${b.status === 'error' ? `<button class="btn btn-sm" data-a="gen">重试生成</button>` : ''}
        ${b.status === 'ready' ? `<button class="btn btn-sm" data-a="regen" title="用当前人设与称呼重新生成剧情">🔄 重新生成</button>` : ''}
        <button class="btn btn-sm btn-icon" data-a="del" title="删除">🗑</button>
      </div>`;
    card.addEventListener('click', async (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (!a) return;
      if (a === 'play') return openBook(b.id);
      if (a === 'gen' || a === 'regen') {
        if (a === 'regen' && !(await confirmBox(`用当前人设与称呼重新生成《${b.title}》的剧本？\n（已有进度与举手问答会保留，剧情帧会全部重写）`, { okText: '重新生成' }))) return;
        try {
          await dp.readerGenerate(b.id);
          await refreshBooks();
          renderLibrary();
        } catch (err) { toast(errText(err), 'error'); }
      }
      if (a === 'view') return openBook(b.id);
      if (a === 'del') {
        if (!(await confirmBox(`删除《${b.title}》及其陪读进度？`, { danger: true, okText: '删除' }))) return;
        await dp.readerDelete(b.id);
        await refreshBooks();
        renderLibrary();
      }
    });
    listEl.appendChild(card);
  }

  root.querySelector('#uploadBtn').addEventListener('click', async () => {
    const p = await dp.pickFile({
      title: '选择书籍/论文',
      filters: [{ name: '文档', extensions: ['txt', 'md', 'markdown', 'pdf', 'doc', 'docx'] }],
    });
    if (!p) return;
    toast('正在解析文档…');
    try {
      const { bookId, meta } = await dp.readerUpload(p);
      toast(`解析完成：${meta.chars} 字符${meta.truncated ? '（已截断到 30 万）' : ''}`, 'ok');
      await refreshBooks();
      // 直接进入生成
      await dp.readerGenerate(bookId);
      openBook(bookId);
    } catch (err) { toast(errText(err), 'error'); }
  });
}

// ================= 生成进度视图 =================
function renderGenerating() {
  root.innerHTML = `
    <div class="gen-view">
      <div class="stage-text" id="genText">正在准备…</div>
      <div class="progress gen-progress"><div id="genBar" style="width:0%"></div></div>
      <button class="btn btn-sm" id="genCancel">取消生成</button>
    </div>`;
  root.querySelector('#genCancel').addEventListener('click', async () => {
    await dp.readerCancelGenerate(lib.id);
    toast('已请求取消');
  });
}

dp.on('reader:progress', ({ bookId, stage, pct, message }) => {
  if (!lib || lib.id !== bookId) {
    // 书库视图中的书也可能在生成：刷新列表徽章
    refreshBooks().then(() => { if (!lib) renderLibrary(); });
    return;
  }
  if (stage === 'done') { openBook(bookId); return; }
  if (stage === 'error') { toast('生成失败：' + message, 'error', 5000); renderLibrary(); return; }
  const bar = root.querySelector('#genBar'), txt = root.querySelector('#genText');
  if (bar) bar.style.width = pct + '%';
  if (txt) txt.textContent = message || '';
  if (stage !== 'flow' && root.querySelector('.gen-view') === null) renderGenerating();
});

// ================= 放映视图 =================
async function openBook(bookId) {
  try { lib = await dp.readerLoad(bookId); } catch (err) { toast(errText(err), 'error'); return; }
  if (lib.status === 'generating') { renderGenerating(); return; }
  if (lib.status === 'error') { toast('上次生成失败：' + (lib.error || ''), 'error', 5000); renderLibrary(); return; }
  if (lib.status === 'parsed') { renderLibrary(); return; }

  cursorIdx = Math.max(0, lib.frames.findIndex(f => f.id === lib.cursor));
  if (cursorIdx < 0) cursorIdx = 0;
  renderPlayView();
  showFrame(cursorIdx, false);
}

function renderPlayView() {
  root.innerHTML = `
    <div class="play-view">
      <div class="stage-left" id="stageLeft">
        <div class="gal-title">
          <button class="btn btn-sm" id="backLib">📚 书库</button>
          <strong>${esc(lib.title)}</strong>
          <span class="grow"></span>
          <span class="small muted">${cursorIdx + 1} / ${lib.frames.length} 帧</span>
        </div>
        <div class="gal-scene">
          <div class="gal-pet" id="galPet"></div>
          <div class="gal-dialog" id="dialog"></div>
        </div>
        <div class="gal-controls">
          <button class="btn btn-sm" id="prevBtn" title="上一帧">◀ 回看</button>
          <button class="btn btn-sm btn-primary" id="nextBtn">继续 ▶</button>
          <label class="row small" style="gap:4px;cursor:pointer"><input type="checkbox" id="autoChk"> 自动播放</label>
          <span class="grow"></span>
          <label class="row small" style="gap:5px" title="拖动角色调整位置；滑杆调整角色大小">
            🖼<button class="btn btn-sm" id="bgBtn" title="设置背景图片">背景</button>
            <button class="btn btn-sm" id="bgClear" title="清除背景图片">🧹</button>
            <button class="btn btn-sm" id="dlgBtn" title="文字框样式（背景色/字体/字号/字色）">Aa</button>
            <input type="range" id="sizeRange" min="0.4" max="2.2" step="0.05" style="width:100px" value="${stageCfg.petScale || 1}">
          </label>
          <span class="small muted" id="sectionTag" style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
        </div>
      </div>
      <div class="splitter" id="splitter" title="左右拖动调整背景与黑板的宽度；双击恢复默认"></div>
      <div class="stage-right" id="stageRight">
        <div class="board" id="board"><div class="board-title">黑板</div><div class="board-empty">讲解要点会写在这里</div></div>
        <div class="qa-panel">
          <div class="qa-list" id="qaList"></div>
          <div class="qa-input">
            <input type="text" id="qaInput" placeholder="举手提问：关于原文的任何问题…">
            <button class="btn btn-sm btn-primary" id="qaBtn">提问</button>
          </div>
        </div>
      </div>
    </div>`;

  root.querySelector('#backLib').addEventListener('click', async () => {
    await refreshBooks(); renderLibrary();
  });
  root.querySelector('#nextBtn').addEventListener('click', () => nextFrame());
  root.querySelector('#prevBtn').addEventListener('click', () => { if (cursorIdx > 0) showFrame(cursorIdx - 1, false); });
  root.querySelector('#autoChk').addEventListener('change', (e) => { autoPlay = e.target.checked; if (autoPlay) maybeAutoAdvance(); });
  root.querySelector('#qaBtn').addEventListener('click', () => ask());
  root.querySelector('#qaInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });

  // 舞台：背景图 / 角色大小 / 拖拽定位
  applyStage();
  enablePetDrag(root.querySelector('#galPet'));
  root.querySelector('#bgBtn').addEventListener('click', async () => {
    const p = await dp.pickFile({ title: '选择陪读背景图片', filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
    if (!p) return;
    stageCfg.background = p;
    await dp.storeSet('settings', { reader: stageCfg }).catch(() => {});
    applyStage();
    toast('背景已更新', 'ok');
  });
  root.querySelector('#bgClear').addEventListener('click', async () => {
    stageCfg.background = '';
    await dp.storeSet('settings', { reader: stageCfg }).catch(() => {});
    applyStage();
  });
  const sizeRange = root.querySelector('#sizeRange');
  sizeRange.addEventListener('input', () => {
    stageCfg.petScale = +sizeRange.value;
    applyStage();
    clearTimeout(sizeSaveTimer);
    sizeSaveTimer = setTimeout(saveStage, 400);
  });

  // 分隔条：左右拖动调整背景区与黑板区宽度；双击恢复默认
  const leftEl = root.querySelector('#stageLeft');
  const splitter = root.querySelector('#splitter');
  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    splitter.setPointerCapture(e.pointerId);
    const view = root.querySelector('.play-view');
    const onMove = (ev) => {
      const r = view.getBoundingClientRect();
      if (!r.width) return;
      stageCfg.splitPct = Math.min(75, Math.max(30, ((ev.clientX - r.left) / r.width) * 100));
      leftEl.style.width = stageCfg.splitPct + '%';
    };
    const onUp = () => {
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      saveStage();
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
  });
  splitter.addEventListener('dblclick', () => {
    stageCfg.splitPct = 58;
    leftEl.style.width = '58%';
    saveStage();
  });

  // 文字框样式弹窗
  root.querySelector('#dlgBtn').addEventListener('click', () => openDialogStyleModal());

  renderQAList();
}

// 文字框样式设置（背景色/字体/字号/字色，改动即时预览）
function openDialogStyleModal() {
  const d = stageCfg.dialog = stageCfg.dialog || { bg: '', family: '', size: 0, color: '' };
  const m = openModal({ title: '文字框样式', width: '400px' });
  const famOpts = [
    ['', '默认'], ["'Microsoft YaHei', sans-serif", '微软雅黑'], ['SimSun, serif', '宋体'],
    ['SimHei, sans-serif', '黑体'], ['KaiTi, serif', '楷体'], ['FangSong, serif', '仿宋'],
    ['Consolas, monospace', 'Consolas'], ['Arial, sans-serif', 'Arial'],
  ];
  m.body.innerHTML = `
    <div class="field"><span class="label">文字框背景颜色</span>
      <div class="row"><input type="color" id="f-bg" value="${d.bg || '#ffffff'}">
        <button class="btn btn-sm" id="f-bg-reset">恢复默认</button></div></div>
    <div class="field"><span class="label">字体</span>
      <select id="f-font" style="width:100%">${famOpts.map(([v, n]) => `<option value="${esc(v)}" ${d.family === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    <div class="field"><span class="label">字体大小：<b id="f-size-v">${d.size || 15}</b> px</span>
      <input type="range" id="f-size" min="12" max="26" step="1" value="${d.size || 15}"></div>
    <div class="field"><span class="label">字体颜色</span>
      <div class="row"><input type="color" id="f-color" value="${d.color || '#2b3328'}">
        <button class="btn btn-sm" id="f-color-reset">恢复默认</button></div></div>
    <div class="hint">改动即时预览到下方文字框；「恢复默认」表示跟随主题配色。</div>`;
  const foot = document.createElement('div');
  foot.className = 'modal-foot';
  foot.innerHTML = `<button class="btn btn-primary" id="f-done">完成</button>`;
  m.el.appendChild(foot);

  const upd = () => applyDialogStyle();
  m.body.querySelector('#f-bg').addEventListener('input', (e) => { d.bg = e.target.value; upd(); });
  m.body.querySelector('#f-bg-reset').addEventListener('click', () => { d.bg = ''; m.body.querySelector('#f-bg').value = '#ffffff'; upd(); });
  m.body.querySelector('#f-font').addEventListener('change', (e) => { d.family = e.target.value; upd(); });
  m.body.querySelector('#f-size').addEventListener('input', (e) => { d.size = +e.target.value; m.body.querySelector('#f-size-v').textContent = d.size; upd(); });
  m.body.querySelector('#f-color').addEventListener('input', (e) => { d.color = e.target.value; upd(); });
  m.body.querySelector('#f-color-reset').addEventListener('click', () => { d.color = ''; m.body.querySelector('#f-color').value = '#2b3328'; upd(); });
  foot.querySelector('#f-done').addEventListener('click', () => { saveStage(); m.close(); });
}

function curFrame() { return lib.frames[cursorIdx]; }

function sectionOf(frame) {
  return (lib.outline || []).find(s => s.id === frame.sectionId);
}

function showFrame(idx, advanceCursor = true) {
  cursorIdx = Math.max(0, Math.min(idx, lib.frames.length - 1));
  const f = curFrame();
  const dialog = root.querySelector('#dialog');
  if (!dialog) return;

  // 进度保存
  if (advanceCursor && lib.cursor !== f.id) {
    lib.cursor = f.id;
    dp.readerSave(lib.id, { cursor: f.id }).catch(() => {});
  }
  root.querySelector('.gal-title .small.muted').textContent = `${cursorIdx + 1} / ${lib.frames.length} 帧`;
  const sec = sectionOf(f);
  root.querySelector('#sectionTag').textContent = sec ? sec.title : '';

  // 宠物表情同步
  dp.petEmote(f.mood || 'normal', 'reader', 0);
  renderPet(document.getElementById('galPet'), f.mood || 'normal', slotOf(f.mood || 'normal'));

  // 黑板
  const board = root.querySelector('#board');
  if (f.bb && f.bb.trim()) {
    board.innerHTML = `<div class="board-title">黑板 · ${esc(sec ? sec.title : '')}</div><div class="md">${renderMD(f.bb)}</div>`;
  }

  lastQuizPick = null;
  if (f.type === 'quiz') {
    dialog.className = 'gal-dialog';
    dialog.innerHTML = `
      <div class="speaker">🎯 随堂小测</div>
      <div class="text">${esc(f.q)}</div>
      <div class="quiz-opts">
        ${f.options.map((o, i) => `<button data-i="${i}">${String.fromCharCode(65 + i)}. ${esc(o)}</button>`).join('')}
      </div>
      <div class="feedback" style="display:none"></div>`;
    dialog.querySelectorAll('.quiz-opts button').forEach(btn => btn.addEventListener('click', () => pickQuiz(+btn.dataset.i)));
  } else {
    dialog.className = 'gal-dialog' + (f.type === 'narration' ? ' narration' : '');
    const speaker = f.type === 'narration' ? '旁白' : petDisplayName;
    dialog.innerHTML = `<div class="speaker">${esc(speaker)}</div><div class="text"></div>`;
    typewrite(dialog.querySelector('.text'), f.text || '');
  }
}

function typewrite(el, text) {
  if (typing) { clearTimeout(typing.timer); typing = null; }
  let i = 0;
  const speed = Math.max(18, 55 - Math.floor(text.length / 30));
  el.textContent = '';
  const state = { done: false, timer: null, finish() { i = text.length; el.textContent = text; state.done = true; } };
  typing = state;
  (function step() {
    if (typing !== state) return;
    i += 1;
    el.textContent = text.slice(0, i);
    if (i < text.length) state.timer = setTimeout(step, speed);
    else { state.done = true; maybeAutoAdvance(); }
  })();
}

function pickQuiz(i) {
  const f = curFrame();
  if (lastQuizPick !== null) return;
  lastQuizPick = i;
  const dialog = root.querySelector('#dialog');
  dialog.querySelectorAll('.quiz-opts button').forEach((b, j) => {
    b.disabled = true;
    if (j === f.correct) b.classList.add('correct');
    else if (j === i) b.classList.add('wrong');
  });
  const fb = dialog.querySelector('.feedback');
  fb.style.display = '';
  fb.innerHTML = (i === f.correct ? '✅ ' : '❌ ') + esc(f.feedback[i]);
  dp.petEmote(i === f.correct ? 'happy' : 'surprised', 'reader', 3000);
  if (autoPlay) setTimeout(() => nextFrame(), 2600);
}

function nextFrame() {
  if (cursorIdx >= lib.frames.length - 1) {
    dp.petEmote('happy', 'reader', 8000);
    const dialog = root.querySelector('#dialog');
    dialog.className = 'gal-dialog';
    dialog.innerHTML = `<div class="speaker">📖</div><div class="text">这本书读完了！恭喜${esc(masterDisplayName)}～有感悟可以举手问我，或者回书库换下一本。</div>`;
    return;
  }
  showFrame(cursorIdx + 1);
}

function maybeAutoAdvance() {
  if (!autoPlay || !lib) return;
  const f = curFrame();
  if (f.type === 'quiz' && lastQuizPick === null) return; // 等答题
  setTimeout(() => { if (autoPlay && typing && typing.done) nextFrame(); }, 2200);
}

// 点击对话框 → 立刻完成打字 / 再点继续
document.addEventListener('click', (e) => {
  if (e.target.closest('.gal-dialog') && typing && !typing.done) typing.finish();
});

// ================= 举手提问 =================
function renderQAList() {
  const el = root.querySelector('#qaList');
  if (!el) return;
  el.innerHTML = lib.qa && lib.qa.length ? '' : '<div class="small muted" style="padding:4px 2px">读书时随时提问，我会基于原文回答，不影响剧情进度</div>';
  for (const qa of lib.qa || []) {
    const item = document.createElement('div');
    item.className = 'qa-item';
    item.innerHTML = `<div class="q">🙋 ${esc(qa.q)}</div><div class="a md">${renderMD(qa.a)}</div>`;
    el.appendChild(item);
  }
  el.scrollTop = el.scrollHeight;
}

function ask() {
  const inputEl = root.querySelector('#qaInput');
  const q = inputEl.value.trim();
  if (!q || qaStreaming) return;
  inputEl.value = '';
  const el = root.querySelector('#qaList');
  const item = document.createElement('div');
  item.className = 'qa-item';
  item.innerHTML = `<div class="q">🙋 ${esc(q)}</div><div class="a"><span class="streaming-cursor"></span></div>`;
  el.appendChild(item);
  el.scrollTop = el.scrollHeight;
  qaStreaming = { item, raw: '', q };

  dp.readerAsk(lib.id, q).catch(err => {
    item.querySelector('.a').textContent = errText(err);
    qaStreaming = null;
  });
}

dp.on('reader:qa-chunk', ({ delta }) => {
  if (!qaStreaming) return;
  qaStreaming.raw += delta;
  qaStreaming.item.querySelector('.a').innerHTML = renderMD(qaStreaming.raw) + '<span class="streaming-cursor"></span>';
  const el = root.querySelector('#qaList');
  if (el) el.scrollTop = el.scrollHeight;
});
dp.on('reader:qa-done', ({ clean, error }) => {
  if (!qaStreaming) return;
  if (error) qaStreaming.item.querySelector('.a').textContent = error;
  else {
    qaStreaming.item.querySelector('.a').innerHTML = renderMD(clean);
    lib.qa = [...(lib.qa || []), { q: qaStreaming.q || '', a: clean, at: new Date().toISOString() }];
  }
  qaStreaming = null;
});

// ================= 启动 =================
async function refreshBooks() {
  try { books = await dp.readerList(); } catch (err) { toast(errText(err), 'error'); }
}

function applyPersona(p) {
  if (!p) return;
  if (p.pet && p.pet.name) petDisplayName = p.pet.name;
  const mn = p.user && String(p.user.name || '').trim();
  if (mn) masterDisplayName = mn;
}

(async function boot() {
  await initTheme();
  try { applyPersona(await dp.storeGet('persona')); } catch (_) {}
  try {
    sprites = await dp.spritesGet();
    stageCfg = { petScale: 1, petX: 50, petY: 40, ...((await dp.storeGet('settings')).reader || {}) };
  } catch (_) {}
  dp.on('sprites:changed', async () => {
    try { sprites = await dp.spritesGet(); } catch (_) {}
    const pet = root.querySelector('#galPet');
    if (pet && lib && lib.frames && lib.frames[cursorIdx]) {
      const f = lib.frames[cursorIdx];
      renderPet(pet, f.mood || 'normal', slotOf(f.mood || 'normal'));
    }
  });
  dp.on('settings:changed', async ({ name } = {}) => {
    if (name !== 'persona') return;
    try { applyPersona(await dp.storeGet('persona')); } catch (_) {}
  });
  await refreshBooks();
  renderLibrary();
})();
