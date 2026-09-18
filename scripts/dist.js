// 打包脚本：内置国内镜像回退（GitHub 直连不通时 electron / nsis 二进制自动走 npmmirror），
// 并优先复用 node_modules/electron/dist 本地构建（electron-builder.yml 的 electronDist），避免重复下载
const { spawnSync } = require('child_process');

process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/';

const args = process.argv.slice(2);
const cli = require.resolve('electron-builder/cli.js');
console.log('[dist] ELECTRON_MIRROR=' + process.env.ELECTRON_MIRROR);
console.log('[dist] electron-builder ' + args.join(' '));

const r = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
