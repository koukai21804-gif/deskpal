// UI token 体系回归：静态校验 + 对比度断言（纯 Node，无需启动 Electron）
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..', 'src', 'renderer');
let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log('  ✓ ' + n); };
const no  = (n, d) => { fail++; console.log('  ✗ ' + n + (d ? ' — ' + d : '')); };

const theme = fs.readFileSync(path.join(R, 'common', 'theme.css'), 'utf8');

// T1 必备 token 全部声明
const NEEDED = ['--dp-bg','--dp-surface','--dp-surface-2','--dp-surface-3','--dp-border',
  '--dp-border-strong','--dp-text','--dp-text-2','--dp-text-3','--dp-accent-soft',
  '--dp-accent-line','--dp-accent-text','--dp-accent-ring','--dp-e1','--dp-e2','--dp-e3',
  '--dp-fs-11','--dp-fs-12','--dp-fs-13','--dp-fs-14','--dp-fs-16','--dp-fs-20','--dp-fs-28',
  '--dp-r-sm','--dp-r-md','--dp-r-lg','--dp-r-xl','--dp-dur-1','--dp-dur-2','--dp-ease-out',
  '--dp-font','--dp-font-display','--dp-font-small','--dp-font-mono'];
NEEDED.forEach(t => theme.includes(t + ':') ? ok('token ' + t) : no('缺 token ' + t));

// T2 深色模式必须覆盖表面与文字
const darkBlock = (theme.match(/html\[data-mode="dark"\][\s\S]*?\}/) || [''])[0];
['--dp-bg','--dp-surface','--dp-surface-2','--dp-text','--dp-text-2','--dp-text-3','--dp-e1','--dp-e3']
  .forEach(t => darkBlock.includes(t + ':') ? ok('dark 覆盖 ' + t) : no('dark 未覆盖 ' + t));

// T3 半像素字号归零
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) {
  const p = path.join(d, f);
  if (fs.statSync(p).isDirectory()) { if (f !== 'vendor') walk(p); }
  else if (/\.(css|js)$/.test(f)) files.push(p);
} })(R);
const half = files.filter(p => /font-size:\s*\d+\.5px/.test(fs.readFileSync(p, 'utf8')));
half.length === 0 ? ok('无半像素字号') : no('半像素字号残留', half.map(p => path.relative(R, p)).join(', '));

// T4 outline:none 必须伴随 focus-visible 替代
const bad = files.filter(p => {
  const s = fs.readFileSync(p, 'utf8');
  return /outline:\s*none/.test(s) && !/focus-visible/.test(s);
});
bad.length === 0 ? ok('outline:none 均有 focus-visible 替代') : no('裸 outline:none', bad.map(p => path.relative(R, p)).join(', '));

// T5 brightness hover 清除
files.some(p => /filter:\s*brightness/.test(fs.readFileSync(p, 'utf8')))
  ? no('仍有 filter:brightness hover') : ok('无 filter:brightness hover');

// T6 emoji 不再用作 UI 图标（仅检查 UI 层，内容字符串豁免需显式登记）
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
const ALLOW = new Set(['pet/lines.js']); // 台词内容豁免
const dirty = files.filter(p => /\.js$/.test(p) && !ALLOW.has(path.relative(R, p).replace(/\\/g, '/')))
  .filter(p => EMOJI.test(fs.readFileSync(p, 'utf8')));
dirty.length === 0 ? ok('UI 层无 emoji 图标') : no('emoji 残留', dirty.map(p => path.relative(R, p)).join(', '));

// T7 accentFg 对比度（与 main/theme.js 同源实现）
const themeJs = require(path.join(__dirname, '..', 'src', 'main', 'theme.js'));
const PRESET_HEX = ['#7DBE3C','#4A90D9','#E583B0','#8E7CC3','#E8A33D','#000000','#FFFFFF'];
function lin(c){const s=c/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4);}
function lum(h){const x=h.replace('#','');return 0.2126*lin(parseInt(x.slice(0,2),16))
  +0.7152*lin(parseInt(x.slice(2,4),16))+0.0722*lin(parseInt(x.slice(4,6),16));}
function cr(a,b){const l1=lum(a),l2=lum(b);const hi=Math.max(l1,l2),lo=Math.min(l1,l2);return (hi+0.05)/(lo+0.05);}
for (const hex of PRESET_HEX) {
  const fg = themeJs.pickFg ? themeJs.pickFg(hex) : null;
  if (!fg) { no('theme.js 未导出 pickFg'); break; }
  const r = cr(hex, fg);
  r >= 4.5 ? ok(`accentFg ${hex} → ${fg} (${r.toFixed(2)}:1)`)
           : no(`accentFg ${hex} → ${fg} 仅 ${r.toFixed(2)}:1`);
}

// T8 图标集完整
const icons = fs.readFileSync(path.join(R, 'common', 'icons.js'), 'utf8');
['close','minimize','plus','check','send','stop','trash','copy','refresh','user','message',
 'bolt','sliders','palette','plug','terminal','tag','clock','info','shield','mail','image','alert']
  .forEach(n => new RegExp('\\b' + n + ':').test(icons) ? ok('icon ' + n) : no('缺 icon ' + n));

console.log(`\nUI token 回归：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
