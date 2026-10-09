// 打包脚本：内置国内镜像回退（GitHub 直连不通时 electron / nsis 二进制自动走 npmmirror），
// 并优先复用 node_modules/electron/dist 本地构建（electron-builder.yml 的 electronDist），避免重复下载
// R7（risk note）：构建器会改写自己触手可及的文件——历史事故：asar extract-file 用打包裁剪版
// 覆盖了源仓库 package.json。这里构建前后各留一份 package.json 快照，被写回就还原并报错退出。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PKG = path.join(__dirname, '..', 'package.json');
const pkgBefore = fs.readFileSync(PKG);
const pkgHash = b => crypto.createHash('sha256').update(b).digest('hex');

process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/';

const args = process.argv.slice(2);
const cli = require.resolve('electron-builder/cli.js');
console.log('[dist] ELECTRON_MIRROR=' + process.env.ELECTRON_MIRROR);
console.log('[dist] electron-builder ' + args.join(' '));

const r = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });

const pkgAfter = fs.readFileSync(PKG);
if (pkgHash(pkgAfter) !== pkgHash(pkgBefore)) {
  fs.writeFileSync(PKG, pkgBefore); // 还原，保证「构建后 git diff package.json 只含人工改动」
  console.error('[dist] ⚠ 检测到构建过程写回了源仓库 package.json！已自动还原为构建前内容，请排查构建链路');
  process.exit(2);
}
process.exit(r.status == null ? 1 : r.status);
