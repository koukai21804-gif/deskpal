// fs-guard：全部文件操作的权限仲裁。读=非敏感区（黑名单拒绝），写=userData 与 userData/temp 白名单
const fs = require('fs');
const path = require('path');

// 读黑名单：DPAPI 主密钥 / 证书库 / 浏览器凭据 / 密码库 / SSH 私钥 / 钱包
const READ_BLACKLIST = [
  /[\\/]Microsoft[\\/]Protect[\\/]/i,
  /[\\/]Microsoft[\\/]Crypto[\\/]/i,
  /NTUSER\.DAT/i,
  /[\\/]AppData[\\/]Local[\\/]Microsoft[\\/]Vault/i,
  /Login Data(\.json)?$/i,
  /Cookies(\.json)?$/i,
  /Web Data/i,
  /logins\.json$/i,
  /key[34]\.db$/i,
  /\.kdbx$/i,
  /id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.ppk$/i,
  /\.wallet$/i,
  /wallet\.dat$/i,
];

let userDataDir = null;

// 由 store.init 注入（测试脚本也可手动注入临时目录）
function setUserDataDir(p) { userDataDir = path.resolve(p); }
function getUserDataDir() { return userDataDir; }

function normalize(p) {
  // 统一分隔符与大小写；不存在也能比较（realpath 仅对已存在部分生效）
  let abs = path.resolve(p);
  try {
    const rp = fs.realpathSync(abs);
    // Windows 上 realpath 可能返回 \\?\ 前缀（扩展路径），去掉以便正则匹配
    abs = rp.startsWith('\\\\?\\') ? rp.slice(4) : rp;
  } catch (_) { /* 目标尚不存在：用 resolve 结果即可 */ }
  return abs.replace(/\\/g, '/').toLowerCase();
}

function canRead(p) {
  const n = normalize(p);
  return !READ_BLACKLIST.some(re => re.test(n));
}

function canWrite(p) {
  if (!userDataDir) return false;
  const n = normalize(p);
  const u = normalize(userDataDir);
  const t = normalize(path.join(userDataDir, 'temp'));
  return n === u || n.startsWith(u + '/') || n.startsWith(t + '/');
}

function guardError(msg) {
  const e = new Error(msg);
  e.userMsg = msg;
  return e;
}

function readFileGuard(p, encoding) {
  if (!canRead(p)) throw guardError('没有权限读取该文件（敏感路径或不存在）');
  return fs.readFileSync(p, encoding);
}

function listDirGuard(p) {
  if (!canRead(p)) throw guardError('没有权限列出该目录');
  const items = [];
  for (const name of fs.readdirSync(p)) {
    const full = path.join(p, name);
    let stat = null;
    try { stat = fs.statSync(full); } catch (_) {}
    items.push({ name, full, isDir: stat ? stat.isDirectory() : false, size: stat ? stat.size : 0 });
  }
  return items;
}

module.exports = { setUserDataDir, getUserDataDir, canRead, canWrite, readFileGuard, listDirGuard, normalize };
