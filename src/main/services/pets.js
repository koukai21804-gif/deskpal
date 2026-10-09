// 宠物设定档案：人设 + 形象差分图 + 缩放绑定为一个完整设定。
// 支持保存多套 / 应用切换 / 删除 / 导出 .pet.json（图片 base64 内嵌）/ 从文件导入。
// v0.4.0-dev.5 起档案内 persona 为 canon/ops/user 三层结构（canon.js 归一化）：
//   保存=快照当前分层；应用=归一化后整体切换 + canon 重新封存（留痕）；导入=兼容 v1 单层与 v2 分层。
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const { dialog } = require('electron');
const store = require('./store');
const canon = require('./canon');
const windows = require('../windows');

const EMOTION_KEYS = ['normal', 'happy', 'surprised', 'angry', 'thinking', 'sad'];
const EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

function friendlyError(msg) { const e = new Error(msg); e.userMsg = msg; return e; }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function newId() { return 'pet_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

function list() {
  const d = store.get('pets');
  return (d.profiles || []).map(p => ({
    id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
    hasImage: Object.values((p.sprites && p.sprites.slots) || {}).some(s => s.mode === 'image'),
    petName: p.persona && (canon.view(p.persona).pet.name || ''),
    layered: !!(p.persona && p.persona.canon),
  }));
}

function findProfile(id) {
  const p = (store.get('pets').profiles || []).find(x => x.id === id);
  if (!p) throw friendlyError('档案不存在或已被删除');
  return p;
}

// 保存当前设定（同名覆盖更新）。persona 快照取分层归一化结果，档案自带完整宪法。
function save(name) {
  name = String(name || '').trim().slice(0, 20) || ('设定 ' + dayjs().format('MM-DD HH:mm'));
  const snapshot = {
    persona: canon.normalizePersona(store.get('persona')),
    sprites: clone(store.get('sprites')),
    petScale: store.get('settings').pet.scale || 1,
  };
  const d = store.get('pets');
  let p = (d.profiles || []).find(x => x.name === name);
  if (!p) { p = { id: newId(), createdAt: dayjs().format() }; d.profiles.push(p); }
  Object.assign(p, snapshot, { name, updatedAt: dayjs().format() });
  store.replace('pets', d);
  return list();
}

// 应用档案：切换人设 + 形象 + 缩放（深拷贝，与档案解耦）。
// persona 先归一化（老档案是 v1 单层结构）→ 整体替换 → canon 按新宪法重新封存留痕。
function apply(id) {
  const p = findProfile(id);
  const layered = canon.normalizePersona(p.persona);
  store.replace('persona', layered);
  canon.reseal({ source: 'profile-apply', note: `应用角色档案「${p.name}」，canon 随档案切换并重新封存` });
  store.replace('sprites', clone(p.sprites));
  if (p.petScale) store.set('settings', { pet: { scale: p.petScale } });
  store.flushAll(); // 立即落盘
  windows.broadcastAll('sprites:changed', {});
  windows.broadcastAll('settings:changed', { name: 'persona' });
  return { applied: p.name };
}

function del(id) {
  findProfile(id);
  const d = store.get('pets');
  d.profiles = d.profiles.filter(x => x.id !== id);
  store.replace('pets', d);
  return list();
}

// 导出为 .pet.json（图片转 base64 内嵌，可分享）。v2：persona 为分层结构（v1 单层文件仍可导入）。
async function exportProfile(id) {
  const p = findProfile(id);
  const payload = {
    app: 'deskpal', type: 'pet-profile', version: 2,
    name: p.name, exportedAt: dayjs().format(),
    persona: canon.normalizePersona(p.persona), petScale: p.petScale || 1,
    sprites: { slots: {} },
  };
  for (const k of EMOTION_KEYS) {
    const s = p.sprites && p.sprites.slots && p.sprites.slots[k];
    if (s && s.mode === 'image' && s.file && fs.existsSync(s.file)) {
      const mime = EXT_MIME[path.extname(s.file).toLowerCase()] || 'application/octet-stream';
      payload.sprites.slots[k] = { mode: 'image', mime, data: fs.readFileSync(s.file).toString('base64') };
    } else {
      payload.sprites.slots[k] = { mode: 'svg' };
    }
  }
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出宠物设定',
    defaultPath: `${p.name.replace(/[\\/:*?"<>|]/g, '_')}.pet.json`,
    filters: [{ name: 'deskpal 宠物设定', extensions: ['json'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

// 从 .pet.json 导入（不传 path 时弹文件选择框）；仅入库，不自动应用
async function importProfile(filePath) {
  let src = filePath;
  if (!src) {
    const r = await dialog.showOpenDialog({
      title: '导入宠物设定',
      filters: [{ name: 'deskpal 宠物设定', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    src = r.filePaths[0];
  }
  let j;
  try { j = JSON.parse(fs.readFileSync(src, 'utf8')); }
  catch (_) { throw friendlyError('文件不是合法的 JSON'); }
  const hasPersona = j && j.type === 'pet-profile' && j.persona && (j.persona.canon || j.persona.pet);
  if (!hasPersona) {
    throw friendlyError('不是有效的 deskpal 宠物设定文件（需要 .pet.json，v1/v2 均可）');
  }
  const layeredPersona = canon.normalizePersona(j.persona); // v1 单层 → 分层；v2 原样归一化
  // R6（risk note）：v1 单层文件没有宪法概念，canon 由 TITOR-CANON 默认内容兜底——
  // 这是「该锁的进了哪层」的自动判据，导入前必须让前辈肉眼确认判得对不对。
  // （纯 Node 测试进程无 electron dialog，跳过确认直接入库，由测试断言判据正确性。）
  if (!j.persona.canon && dialog && typeof dialog.showMessageBox === 'function') {
    const { canceled: no } = await dialog.showMessageBox({
      type: 'question',
      title: '导入 v1 单层设定',
      message: `「${String(j.name || '未命名').slice(0, 20)}」是 v1 单层结构文件`,
      detail: '分层结果预览：\n· canon 宪法（L1–L4）将以 TITOR-CANON v1.0 默认内容兜底，名字沿用旧档\n· ops 表现层（外貌/口头禅/表层性格等）原样保留旧档内容\n· 导入后可在人设页查看，宪法修改走批准通道\n\n确认导入？',
      buttons: ['确认导入', '取消'],
      defaultId: 0,
      cancelId: 1,
    });
    if (no) return null;
  }

  // 图片数据落盘到 sprites/
  const sprites = { slots: {} };
  for (const k of EMOTION_KEYS) {
    const s = j.sprites && j.sprites.slots && j.sprites.slots[k];
    if (s && s.mode === 'image' && s.data) {
      const ext = MIME_EXT[s.mime] || '.png';
      const dest = path.join(store.getDataDir(), 'sprites', `${k}_${Date.now().toString(36)}${ext}`);
      fs.writeFileSync(dest, Buffer.from(String(s.data), 'base64'));
      sprites.slots[k] = { mode: 'image', file: dest };
    } else {
      sprites.slots[k] = { mode: 'svg' };
    }
  }

  const d = store.get('pets');
  let name = String(j.name || '导入的设定').slice(0, 20);
  if ((d.profiles || []).some(x => x.name === name)) name = name + ' (导入)';
  d.profiles.push({
    id: newId(), name, persona: layeredPersona,
    sprites,
    petScale: j.petScale || 1,
    createdAt: dayjs().format(), updatedAt: dayjs().format(),
  });
  store.replace('pets', d);
  return { profiles: list(), importedName: name };
}

module.exports = { list, save, apply, del, exportProfile, importProfile };
