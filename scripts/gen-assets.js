// 生成内置资源：resources/icon.png（纯 Node zlib PNG 编码，无第三方依赖）+ resources/ding.wav（PCM 提示音）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const outDir = path.join(__dirname, '..', 'resources');
fs.mkdirSync(outDir, { recursive: true });

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// 画一个 Haro 风格绿色圆球图标（径向渐变 + 两只红竖椭圆眼 + 微笑嘴）
function drawBall(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2, r = size * 0.46;
  const eyeY = c + size * 0.02, eyeDX = size * 0.15, eyeRX = size * 0.055, eyeRY = size * 0.09;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c;
      const d = Math.sqrt(dx * dx + dy * dy);
      const i = (y * size + x) * 4;
      if (d > r + 1) continue; // 透明
      const t = Math.min(1, Math.max(0, d / r));
      // 径向渐变：中心亮绿 → 边缘深绿（光源在左上）
      const light = 1 - t * 0.55 - (dx + dy) / (4 * r) * 0.12;
      let rr = Math.round(0x8d * (0.35 + light * 0.65) + 0x5e * (1 - light) * 0.4);
      let gg = Math.round(0xc6 * (0.35 + light * 0.65) + 0x9b * (1 - light) * 0.4);
      let bb = Math.round(0x3f * (0.35 + light * 0.65) + 0x2e * (1 - light) * 0.4);
      // 眼睛（竖椭圆，红）
      for (const s of [-1, 1]) {
        const ex = (x - (c + s * eyeDX)) / eyeRX, ey = (y - eyeY) / eyeRY;
        if (ex * ex + ey * ey <= 1) { rr = 0xb0; gg = 0x3a; bb = 0x3a; }
      }
      // 嘴（下半圆弧线）
      const md = Math.abs(Math.sqrt(dx * dx + (dy - size * 0.04) * (dy - size * 0.04)) - r * 0.62);
      if (dy > size * 0.02 && md < size * 0.035 && Math.abs(dx) < r * 0.5) { rr = 0x33; gg = 0x33; bb = 0x33; }
      // 边缘抗锯齿
      const alpha = d > r - 1 ? Math.round(255 * (r + 1 - d)) : 255;
      px[i] = Math.min(255, rr); px[i + 1] = Math.min(255, gg); px[i + 2] = Math.min(255, bb);
      px[i + 3] = Math.max(0, Math.min(255, alpha));
    }
  }
  return encodePNG(size, size, px);
}

for (const size of [16, 32, 256]) {
  const f = path.join(outDir, `icon${size === 32 ? '-32' : size === 256 ? '-256' : ''}.png`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, drawBall(size));
  console.log('[assets] 写出', f);
}

// ---------- ding.wav（两声清脆提示音，16bit 单声道 22050Hz ≈0.75s） ----------
if (!fs.existsSync(path.join(outDir, 'ding.wav'))) {
  const SR = 22050, dur = 0.75, n = Math.floor(SR * dur);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    if (t < 0.3) v = Math.sin(2 * Math.PI * 1318 * t) * Math.exp(-t * 9);                 // E6
    else if (t >= 0.32) { const u = t - 0.32; v = Math.sin(2 * Math.PI * 1760 * u) * Math.exp(-u * 7); } // A6
    const fade = Math.min(1, (n - i) / (SR * 0.02));
    pcm.writeInt16LE(Math.round(v * 0.55 * 32767 * fade), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(path.join(outDir, 'ding.wav'), Buffer.concat([header, pcm]));
  console.log('[assets] 写出 ding.wav');
}
console.log('[assets] 完成');
