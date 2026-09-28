// 用户身份档案预填脚本（分层档案全量字段 → user/profile.json）
// 用法：node scripts/seed-profile.js <seed.json> [userDataDir]
//   seed.json    种子文件（含高敏感信息，只放本机 gitignore 目录，严禁入库/上传）
//   userDataDir  默认 %APPDATA%/deskpal（真实 profile）
// fill-empty 语义：已有值（含漂移更新过的）一律保留，只补空缺；重复运行安全。
// 注意：deskpal 运行中时其内存缓存会在下次写盘时覆盖外部修改——脚本检测到进程会拒绝执行。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const seedPath = process.argv[2];
if (!seedPath) {
  console.error('用法：node scripts/seed-profile.js <seed.json> [userDataDir]');
  process.exit(2);
}
const targetDir = process.argv[3] || path.join(process.env.APPDATA || '.', 'deskpal');

// deskpal 是否在运行（运行中写入会被内存缓存覆盖）
const tasklist = spawnSync('tasklist', ['/FI', 'IMAGENAME eq deskpal.exe', '/FO', 'CSV'], { encoding: 'utf8' }).stdout || '';
if (/deskpal\.exe/i.test(tasklist)) {
  console.error('✗ 检测到 deskpal.exe 正在运行——请先退出（托盘右键→退出）再运行本脚本，否则外部写入会被应用内存缓存覆盖。');
  process.exit(3);
}

const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
const store = require(path.join(__dirname, '..', 'src', 'main', 'services', 'store'));
store.init(targetDir);
const userProfile = require(path.join(__dirname, '..', 'src', 'main', 'services', 'user-profile'));

const before = userProfile.get();
const r = userProfile.applySeed(seed);
store.flushAll();
console.log(`预填完成 → ${path.join(targetDir, 'user', 'profile.json')}`);
console.log(`  新增：P0 ${r.added.P0} 条 / P1 ${r.added.P1} / P2 ${r.added.P2} / P3 ${r.added.P3} 字段`);
console.log(`  现有：P1 ${r.total.P1} / P2 ${r.total.P2} / P3 ${r.total.P3} 字段（已有值一律保留：此前 P1 ${Object.keys(before.P1 || {}).length} / P2 ${Object.keys(before.P2 || {}).length} / P3 ${Object.keys(before.P3 || {}).length}）`);
