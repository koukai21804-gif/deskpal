// read_image 的图像处理工具集：格式嗅探 / 像素尺寸解析 / 超大图缩放 / 图像 token 估算。
// 纯 Node 可跑（单测环境无 electron）：nativeImage 经惰性 require 获取，取不到（纯 Node
// 单测）时只解析头部信息、原样透传字节——缩放是锦上添花，尺寸解析与格式校验才是硬功能。
const MAX_FILE_BYTES = 8 * 1024 * 1024;      // 原始文件上限（与聊天窗贴图 8MB 约定一致）
const MAX_SIDE = 2048;                        // 最长边超过即缩放（vision 模型普遍按贴片计费，超大图纯浪费）
const MAX_DATAURL_CHARS = 12 * 1024 * 1024;   // base64 后上限（部分网关对请求体大小敏感）

// ---- 格式嗅探（魔数，不信任扩展名）----
function sniffMime(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (b.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// ---- 像素尺寸解析（头部信息，无需解码）----
function imageDims(buf, mime) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  try {
    if (mime === 'image/png' && b.length >= 24) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (mime === 'image/gif' && b.length >= 10) {
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }
    if (mime === 'image/bmp' && b.length >= 26) {
      return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
    }
    if (mime === 'image/webp' && b.length >= 30) {
      const fourcc = b.toString('ascii', 12, 16);
      if (fourcc === 'VP8X') {
        // chunk data 从 20 起：4 字节标志后是 canvas 宽高各 24bit LE（值-1）
        return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      }
      if (fourcc === 'VP8 ') {
        // 有损帧：data[0..2]=帧标签，data[3..5]=同步码 9D 01 2A，随后 14bit 宽高
        return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      }
      if (fourcc === 'VP8L') {
        // 无损帧：data[0]=0x2f 签名，随后 32bit：14bit 宽-1 | 14bit 高-1
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
    }
    if (mime === 'image/jpeg') {
      // 扫描 SOFn 段取尺寸（SOF0/1/2/…/15，跳过 C4/C8/CC；DHT 等含 0xFF 字节的段靠长度字段跳过）
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = b.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }
  } catch (_) { /* 头部畸形：按尺寸未知处理 */ }
  return null;
}

// electron.nativeImage 惰性获取（纯 Node 单测下为 null）
function getNativeImage() {
  try { return require('electron').nativeImage || null; } catch (_) { return null; }
}

// 探测 + 必要时缩放。返回 {buf, mime, width, height, resized}
// 缩放仅在 nativeImage 可用且能解码（png/jpeg）时发生；gif/webp/bmp 原样透传
// （各家 vision 接口原生支持这几种格式，服务商侧会自行处理尺寸）。
function probeImage(buf, mime) {
  const dims = imageDims(buf, mime) || {};
  const out = { buf, mime, width: dims.width || 0, height: dims.height || 0, resized: false };
  const ni = getNativeImage();
  if (!ni) return out;
  if (mime !== 'image/png' && mime !== 'image/jpeg') return out;
  const maxSide = Math.max(out.width, out.height);
  if (!maxSide || maxSide <= MAX_SIDE) return out;
  try {
    const img = ni.createFromBuffer(buf);
    if (img.isEmpty()) return out;
    const scale = MAX_SIDE / maxSide;
    const nw = Math.max(1, Math.round(out.width * scale));
    const nh = Math.max(1, Math.round(out.height * scale));
    const small = img.resize({ width: nw, height: nh, quality: 'good' });
    let smallBuf, outMime;
    if (mime === 'image/jpeg') { smallBuf = small.toJPEG(88); outMime = 'image/jpeg'; }
    else {
      smallBuf = small.toPNG(); outMime = 'image/png';
      // PNG 截图缩放后仍可能偏大：退化 JPEG（有损但体积可控；桌面截图类内容可读性足够）
      if (smallBuf.length > 4.5 * 1024 * 1024) { smallBuf = small.toJPEG(88); outMime = 'image/jpeg'; }
    }
    out.buf = smallBuf;
    out.mime = outMime;
    out.width = nw; out.height = nh; out.resized = true;
  } catch (_) { /* 解码失败：原样透传，交服务商裁决 */ }
  return out;
}

// 图像部分的 token 估算口径（ctx-compact 预算用）：OpenAI 高细节贴片公式
// ceil(w/512)×ceil(h/512)×170 + 85；缺尺寸（头部解析失败）按中位复杂度 1500。
function imageTokenEstimate(width, height) {
  if (Number.isFinite(+width) && Number.isFinite(+height) && width > 0 && height > 0) {
    const t = Math.ceil(width / 512) * Math.ceil(height / 512) * 170 + 85;
    return Math.min(6000, Math.max(85, Math.round(t)));
  }
  return 1500;
}

function toDataUrl(mime, buf) {
  return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
}

module.exports = {
  MAX_FILE_BYTES, MAX_SIDE, MAX_DATAURL_CHARS,
  sniffMime, imageDims, probeImage, imageTokenEstimate, toDataUrl,
};
