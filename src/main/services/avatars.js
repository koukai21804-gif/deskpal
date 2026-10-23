// 头像服务：用户头像 + 助手头像（均落数据目录 user/，聊天窗直接显示，用户头像还可被视觉工具读取）
// 校验看魔数不看扩展名；主进程有 nativeImage 时统一压到 ≤512px，避免大图白占内存与图像 token。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const logger = require('../logger');
const { sniffMime, probeImage } = require('./agent/image-utils');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SIDE = 512;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/gif': 'gif' };
const REL = 'user';
const KINDS = {
  user: { file: 'avatar', label: '头像' },
  assistant: { file: 'assistant-avatar', label: '助手头像' },
};

function dir() {
  const d = path.join(store.getDataDir() || '', REL);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function absOf(rel) { return rel ? path.join(store.getDataDir(), rel) : null; }

function state() {
  const a = store.get('avatar') || {};
  const norm = (x) => (x && x.file ? { ...x, path: absOf(x.file) } : null);
  return { user: norm(a.user), assistant: norm(a.assistant) };
}

// 有 nativeImage 时按最长边缩放到 512 并统一转 PNG；纯 Node（单测）原样返回
function fit(buf, mime) {
  let ni = null;
  try { ni = require('electron').nativeImage || null; } catch (_) { /* 纯 Node */ }
  if (!ni || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) return { buf, mime };
  try {
    const img = ni.createFromBuffer(buf);
    if (img.isEmpty()) return { buf, mime };
    const { width, height } = img.getSize();
    if (!width || !height || (width <= MAX_SIDE && height <= MAX_SIDE)) return { buf, mime };
    const scale = MAX_SIDE / Math.max(width, height);
    const out = img.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'best',
    });
    return { buf: out.toPNG(), mime: 'image/png' };
  } catch (e) {
    logger.warn('头像缩放失败，按原图保存：' + e.message);
    return { buf, mime };
  }
}

function removeFile(rel) {
  if (!rel) return;
  try { fs.unlinkSync(absOf(rel)); } catch (_) { /* 已不存在 */ }
}

function setFromBuffer(kind, input) {
  const meta = KINDS[kind];
  if (!meta) throw new Error('未知头像类型');
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!buf.length) throw new Error('图片内容为空');
  if (buf.length > MAX_BYTES) {
    throw new Error(`图片超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB（实际 ${(buf.length / 1024 / 1024).toFixed(1)}MB），请先压缩后再试`);
  }
  const mime0 = sniffMime(buf);
  if (!mime0) throw new Error('文件内容不是可识别的图片（支持 png / jpg / jpeg / webp / bmp / gif）');
  const fitted = fit(buf, mime0);
  const mime = fitted.mime;
  const ext = EXT[mime];
  if (!ext) throw new Error('不支持的图片格式');
  const probe = probeImage(fitted.buf, mime);
  const relFile = `${REL}/${meta.file}.${ext}`;
  const old = state()[kind];
  dir();
  fs.writeFileSync(absOf(relFile), fitted.buf);
  if (old && old.file && old.file !== relFile) removeFile(old.file);
  const entry = {
    file: relFile, mime,
    width: probe.width || 0, height: probe.height || 0,
    bytes: fitted.buf.length,
    updatedAt: new Date().toISOString(),
  };
  store.set('avatar', { [kind]: entry });
  return state();
}

function setFromPath(kind, srcPath) {
  if (!KINDS[kind]) throw new Error('未知头像类型');
  const p = String(srcPath || '').trim();
  if (!p) throw new Error('未选择图片');
  let st;
  try { st = fs.statSync(p); } catch (_) { throw new Error('图片不存在或无法访问'); }
  if (!st.isFile()) throw new Error('所选路径不是文件');
  if (st.size > MAX_BYTES) {
    throw new Error(`图片超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB（实际 ${(st.size / 1024 / 1024).toFixed(1)}MB），请先压缩后再试`);
  }
  return setFromBuffer(kind, fs.readFileSync(p));
}

function reset(kind) {
  if (!KINDS[kind]) throw new Error('未知头像类型');
  const cur = state()[kind];
  removeFile(cur && cur.file);
  store.set('avatar', { [kind]: null });
  return state();
}

// 兼容旧调用
function setUserFromBuffer(buf) { return setFromBuffer('user', buf); }
function setUserFromPath(p) { return setFromPath('user', p); }
function setAssistantFromBuffer(buf) { return setFromBuffer('assistant', buf); }
function setAssistantFromPath(p) { return setFromPath('assistant', p); }
function resetUser() { return reset('user'); }
function resetAssistant() { return reset('assistant'); }

// look_user_avatar 读取入口：{ buf, mime, file, path, width, height }；未上传/文件丢失 → null
function readUserImage() {
  const u = state().user;
  if (!u) return null;
  try {
    const buf = fs.readFileSync(u.path);
    const mime = sniffMime(buf);
    if (!mime) return null;
    return { buf, mime, file: u.file, path: u.path, width: u.width || 0, height: u.height || 0 };
  } catch (e) {
    logger.warn('用户头像读取失败：' + e.message);
    return null;
  }
}

module.exports = {
  state,
  setFromBuffer, setFromPath, reset,
  setUserFromBuffer, setUserFromPath, setAssistantFromBuffer, setAssistantFromPath,
  resetUser, resetAssistant,
  readUserImage,
  MAX_BYTES, MAX_SIDE,
};
