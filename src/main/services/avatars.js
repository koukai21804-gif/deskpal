// 用户头像服务：设置页上传 → 数据目录 user/avatar.<ext>
// 聊天窗用于消息头像；look_user_avatar 工具读取同一文件送入视觉上下文。
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

function dir() {
  const d = path.join(store.getDataDir() || '', REL);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function absOf(rel) { return rel ? path.join(store.getDataDir(), rel) : null; }

function state() {
  const a = store.get('avatar') || {};
  const u = a.user && a.user.file ? a.user : null;
  return { user: u ? { ...u, path: absOf(u.file) } : null };
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

function setUserFromBuffer(input) {
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
  const relFile = `${REL}/avatar.${ext}`;
  const old = state().user;
  dir();
  const dest = absOf(relFile);
  fs.writeFileSync(dest, fitted.buf);
  if (old && old.file && old.file !== relFile) removeFile(old.file);
  const user = {
    file: relFile, mime,
    width: probe.width || 0, height: probe.height || 0,
    bytes: fitted.buf.length,
    updatedAt: new Date().toISOString(),
  };
  store.set('avatar', { user });
  return state();
}

function setUserFromPath(srcPath) {
  const p = String(srcPath || '').trim();
  if (!p) throw new Error('未选择图片');
  let st;
  try { st = fs.statSync(p); } catch (_) { throw new Error('图片不存在或无法访问'); }
  if (!st.isFile()) throw new Error('所选路径不是文件');
  if (st.size > MAX_BYTES) {
    throw new Error(`图片超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB（实际 ${(st.size / 1024 / 1024).toFixed(1)}MB），请先压缩后再试`);
  }
  return setUserFromBuffer(fs.readFileSync(p));
}

function resetUser() {
  const cur = state().user;
  removeFile(cur && cur.file);
  store.set('avatar', { user: null });
  return state();
}

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

module.exports = { state, setUserFromBuffer, setUserFromPath, resetUser, readUserImage, MAX_BYTES, MAX_SIDE };
