// 文档解析：txt/md 直读（GBK 兜底）、pdf 逐页提取+扫描版检测、docx、doc；清洗 + 30 万字符上限
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const guard = require('./fs-guard');
const logger = require('../logger');

const MAX_CHARS = 300000;

function friendlyError(msg) { const e = new Error(msg); e.userMsg = msg; return e; }

function decodeText(buf) {
  // BOM / UTF-8 优先，失败或出现大量替换符则用 GBK 兜底
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le');
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad > utf8.length * 0.0005) {
    try { return iconv.decode(buf, 'gbk'); } catch (_) { return utf8; }
  }
  return utf8;
}

// 清洗：去 URL/DOI、页眉页脚常见噪点、多余空白
function cleanText(t) {
  return t
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\bdoi\s*[:：]?\s*10\.\d{4,9}\/\S+/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/-\n(?=\w)/g, '')       // 断词连字符
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

async function parsePdf(filePath) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({ data, verbosity: 0, disableFontFace: true, useSystemFonts: false }).promise;
  const pages = doc.numPages;
  const parts = [];
  const lens = [];
  const maxPages = Math.min(pages, 500);
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
    lens.push(text.length);
    parts.push(`<!-- p:${i} -->\n${text}`);
  }
  await doc.destroy();
  const avg = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  const textPages = lens.filter(l => l >= 50).length;
  // 扫描版判定：平均字符少 且 一半以上页面几乎无文字（避免封面/版权页误伤有文字层的书）
  if (avg < 50 && textPages / Math.max(1, lens.length) < 0.5) {
    throw friendlyError('这份 PDF 几乎提取不到文字，疑似扫描版/图片版。请换一份文字版 PDF（暂不支持 OCR）。');
  }
  return { text: parts.join('\n\n'), pages };
}

async function parseDocx(filePath) {
  const mammoth = require('mammoth');
  const { value } = await mammoth.extractRawText({ path: filePath });
  return { text: value || '', pages: null };
}

async function parseDoc(filePath) {
  const WordExtractor = require('word-extractor');
  const ext = new WordExtractor();
  const doc = await ext.extract(filePath);
  return { text: doc.getBody() || '', pages: null };
}

// 入口：返回 { text, meta }
async function parse(filePath) {
  if (!fs.existsSync(filePath)) throw friendlyError('文件不存在：' + filePath);
  const buf = guard.readFileGuard(filePath); // Buffer，敏感路径拒绝
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);
  let text = '', pages = null, format = ext.replace('.', '') || 'txt';

  if (ext === '.pdf') {
    const r = await parsePdf(filePath);
    text = r.text; pages = r.pages;
  } else if (ext === '.docx') {
    const r = await parseDocx(filePath);
    text = r.text;
  } else if (ext === '.doc') {
    const r = await parseDoc(filePath);
    text = r.text;
  } else if (['.txt', '.md', '.markdown'].includes(ext)) {
    text = decodeText(buf);
  } else {
    throw friendlyError('不支持的格式：' + ext + '（支持 txt / pdf / doc / docx）');
  }

  text = cleanText(text);
  if (!text || text.length < 200) throw friendlyError('解析到的文字太少（' + (text ? text.length : 0) + ' 字符），无法陪读');
  const truncated = text.length > MAX_CHARS;
  if (truncated) text = text.slice(0, MAX_CHARS);

  return {
    text,
    meta: {
      fileName, format, pages, chars: text.length, truncated,
      title: fileName.replace(/\.(txt|pdf|docx?|md|markdown)$/i, ''),
    },
  };
}

module.exports = { parse, MAX_CHARS };
