// C2PA 内容凭证清除：PNG 按块级结构摘除 caBX 块（其余块原样保留，CRC 逐块校验），
// JSON 内嵌 data:image/png;base64 的立绘同步处理。像素级无损——只删元数据块，不重编码。
// 用法：node scripts/strip-c2pa.js <文件或目录>...
// 识别码：PNG 块类型 caBX；通用字节特征 c2pa / JUMBF / jumd
const fs = require('fs');
const path = require('path');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 走一遍 PNG 块链，摘除 dropType 块；校验每块 CRC 与 IEND 收尾，返回 null 表示结构非法
function stripPng(buf, dropType) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;
  const drop = Buffer.from(dropType, 'ascii');
  const parts = [SIG];
  let off = 8;
  let removed = 0;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    const crcEnd = dataEnd + 4;
    if (len > 0x7fffffff || crcEnd > buf.length) return null;
    if (!type.equals(drop)) {
      const chunk = buf.subarray(off, crcEnd);
      // CRC 校验：type+data 的 CRC-32 必须等于块尾
      if (crc32(buf.subarray(off + 4, dataEnd)) !== chunk.readUInt32BE(chunk.length - 4)) return null;
      parts.push(chunk);
    } else {
      removed++;
    }
    off = crcEnd;
    if (type.toString('ascii') === 'IEND') {
      if (off !== buf.length) return null; // IEND 后还有尾料=结构异常
      return removed ? { out: Buffer.concat(parts), removed } : { out: buf, removed: 0 };
    }
  }
  return null;
}

// CRC-32（PNG 多项式 0xEDB88320）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function stripDataUri(uri) {
  // 兼容两种内嵌形态：带 data:image/png;base64, 前缀的 data URI，和裸 base64（以 iVBORw0KGgo 即 \x89PNG 开头）
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(uri);
  const b64 = m ? m[1] : (uri.length > 512 && /^[A-Za-z0-9+/=\s]+$/.test(uri) ? uri : null);
  if (!b64) return null;
  const raw = Buffer.from(b64, 'base64');
  if (raw.length < 8 || !raw.subarray(0, 8).equals(SIG)) return null;
  const r = stripPng(raw, 'caBX');
  if (!r || !r.removed) return null;
  const out64 = r.out.toString('base64');
  return m ? 'data:image/png;base64,' + out64 : out64;
}

function walkJson(v, stats) {
  if (typeof v === 'string') {
    const s = stripDataUri(v);
    if (s) { stats.uris++; return s; }
    return v;
  }
  if (Array.isArray(v)) return v.map(x => walkJson(x, stats));
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = walkJson(v[k], stats);
    return v;
  }
  return v;
}

function hasC2pa(buf) {
  return /caBX|c2pa|JUMBF|jumd/.test(buf.toString('latin1'));
}

let files = [];
for (const arg of process.argv.slice(2)) {
  const st = fs.statSync(arg);
  if (st.isDirectory()) {
    files.push(...fs.readdirSync(arg).map(f => path.join(arg, f)).filter(f => /\.(png|json)$/i.test(f)));
  } else files.push(arg);
}

let touched = 0;
for (const f of files) {
  const buf = fs.readFileSync(f);
  if (f.endsWith('.json')) {
    let doc;
    try { doc = JSON.parse(buf.toString('utf8')); } catch { console.error('✗ JSON 解析失败：' + f); process.exitCode = 1; continue; }
    const stats = { uris: 0 };
    const out = JSON.stringify(walkJson(doc, stats));
    if (stats.uris) {
      fs.writeFileSync(f, out);
      touched++;
      console.log(`✓ ${f}：清除内嵌立绘 C2PA ×${stats.uris}`);
    } else console.log(`· ${f}：无 C2PA`);
  } else {
    if (!hasC2pa(buf)) { console.log(`· ${f}：无 C2PA`); continue; }
    const r = stripPng(buf, 'caBX');
    if (!r) { console.error(`✗ ${f}：PNG 结构校验失败（未动原文件）`); process.exitCode = 1; continue; }
    if (hasC2pa(r.out)) { console.error(`✗ ${f}：摘除后仍检出 C2PA 特征（未动原文件）`); process.exitCode = 1; continue; }
    fs.writeFileSync(f, r.out);
    touched++;
    console.log(`✓ ${f}：摘除 caBX ×${r.removed}，${buf.length} → ${r.out.length} 字节（CRC 全通过）`);
  }
}
console.log(`完成：${touched}/${files.length} 个文件被清理`);
