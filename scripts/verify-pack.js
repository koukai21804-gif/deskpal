// 打包校验：用 @electron/asar Node API（不要用 CLI extract-file，会覆盖 package.json）
const asar = require('@electron/asar');
const path = require('path');

const p = path.join('dist', 'win-unpacked', 'resources', 'app.asar');
const files = asar.listPackage(p);
const fwd = (s) => s.split(path.sep).join('/');
const find = (re) => files.find(f => re.test(f));

const cases = [
  [/renderer[\\/]common[\\/]icons\.js$/i, 'icons.js', 'export function icon'],
  [/renderer[\\/]common[\\/]theme\.css$/i, 'theme.css', '--dp-surface-3'],
  [/renderer[\\/]chat[\\/]chat\.css$/i, 'chat.css', 'chat-topbar'],
  [/renderer[\\/]chat[\\/]app\.js$/i, 'chat/app.js', 'chat-topbar'],
  [/renderer[\\/]settings[\\/]settings\.css$/i, 'settings.css', '.nav-group-label'],
  [/^\\?icon\.png$/i, 'icon.png（助手头像）', 'PNG'],
  [/services[\\/]avatars\.js$/i, 'avatars.js', 'assistant-avatar'],
  [/renderer[\\/]chat[\\/]app\.js$/i, 'chat/app.js（助手头像）', 'avatarState.assistant'],
  [/renderer[\\/]settings[\\/]app\.js$/i, 'settings/app.js（头像上传）', 'assistantAvatarPick'],
  [/services[\\/]agent[\\/]builtin\.js$/i, 'builtin.js', 'look_user_avatar'],
];

function tryExtract(file) {
  // Windows 上 asar 的目录遍历按 path.sep 切分，必须传反斜杠相对路径
  const rel = fwd(file).replace(/^\//, '');
  const variants = [rel.split('/').join(path.sep), rel];
  for (const v of variants) {
    try { return { text: asar.extractFile(p, v).toString('utf8'), via: v }; } catch (_) {}
  }
  return null;
}

let bad = 0;
for (const [re, label, marker] of cases) {
  const file = find(re);
  if (!file) { console.log('✗ ' + label + ' 未打进 asar'); bad++; continue; }
  const r = tryExtract(file);
  if (!r) { console.log('✗ ' + label + ' 提取失败（' + file + '）'); bad++; continue; }
  const ok = r.text.includes(marker);
  console.log((ok ? '✓ ' : '✗ ') + label + ' 已打包，长度 ' + r.text.length + (ok ? '' : '，标记缺失'));
  if (!ok) bad++;
}

const pkg = JSON.parse(asar.extractFile(p, 'package.json').toString('utf8'));
console.log('package.json：' + pkg.name + ' v' + pkg.version);
console.log(bad ? `校验失败 ${bad} 项` : '打包校验全部通过');
process.exit(bad ? 1 : 0);
