// postinstall：把 marked / katex 拷贝到渲染层 vendor 目录（禁止 CDN，幂等）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'src', 'renderer', 'common', 'vendor');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function copyIf(src, dest) {
  if (!fs.existsSync(src)) { console.warn('[vendor] 缺少源文件，跳过:', src); return; }
  ensureDir(path.dirname(dest));
  if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
}
function copyDirIf(src, dest) {
  if (!fs.existsSync(src)) { console.warn('[vendor] 缺少源目录，跳过:', src); return; }
  ensureDir(dest);
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), d = path.join(dest, f);
    if (fs.statSync(s).isDirectory()) copyDirIf(s, d);
    else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
  }
}

const nm = path.join(root, 'node_modules');
copyIf(path.join(nm, 'marked', 'marked.min.js'), path.join(vendor, 'marked', 'marked.min.js'));
copyIf(path.join(nm, 'katex', 'dist', 'katex.min.js'), path.join(vendor, 'katex', 'katex.min.js'));
copyIf(path.join(nm, 'katex', 'dist', 'katex.min.css'), path.join(vendor, 'katex', 'katex.min.css'));
copyDirIf(path.join(nm, 'katex', 'dist', 'fonts'), path.join(vendor, 'katex', 'fonts'));
console.log('[vendor] 完成');
