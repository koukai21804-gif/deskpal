// fs-guard：全部文件操作的权限仲裁。读=非敏感区（黑名单拒绝）；写=按权限模式分档
// 模式（settings.agent.permissionMode）：
//   read     只读——一切写入拒绝（write_file 不下发给模型，此处兜底）
//   userData 可编辑——仅 userData 子树可写
//   full     完全编辑——本机大部分目录可写，核心系统目录/其他用户目录/敏感文件/盘根文件/UNC 除外
const fs = require('fs');
const path = require('path');
const os = require('os');

// 读黑名单：DPAPI 主密钥 / 证书库 / 浏览器凭据 / 密码库 / SSH 私钥 / 钱包（任何模式下读写都拒）
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

// full 模式写黑名单：核心系统目录（normalize 后为 小写正斜杠 盘符路径）
const WRITE_FULL_BLACKLIST = [
  /^[a-z]:\/windows\b/i,
  /^[a-z]:\/program files\b/i,
  /^[a-z]:\/program files \(x86\)\b/i,
  /^[a-z]:\/programdata\b/i,
  /^[a-z]:\/\$recycle\.bin\b/i,
  /^[a-z]:\/recovery\b/i,
  /^[a-z]:\/config\.msi\b/i,
  /^[a-z]:\/perflogs\b/i,
  /^[a-z]:\/system volume information\b/i,
  /^[a-z]:\/users\/all users\b/i,
  /^[a-z]:\/users\/default\b/i,
  /^[a-z]:\/users\/default user\b/i,
  /^[a-z]:\/users\/public\b/i,
  /^[a-z]:\/documents and settings\b/i,
];

let userDataDir = null;
let writeMode = 'read'; // 'read' | 'userData' | 'full'

// 由 store.init 注入（测试脚本也可手动注入临时目录）
function setUserDataDir(p) { userDataDir = path.resolve(p); }
function getUserDataDir() { return userDataDir; }
function setWriteMode(m) { if (['read', 'userData', 'full'].includes(m)) writeMode = m; }
function getWriteMode() { return writeMode; }

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
  // 敏感文件（密码库/凭据/私钥等）任何模式下都不可写
  if (READ_BLACKLIST.some(re => re.test(n))) return false;
  const u = normalize(userDataDir);
  // userData 子树（含 temp）：userData/full 模式均可写
  const inUserData = n === u || n.startsWith(u + '/');
  if (writeMode === 'read') return false;
  if (inUserData) return true;
  if (writeMode === 'full') {
    if (/^\/\//.test(n)) return false;            // UNC 网络路径
    if (!/^[a-z]:\//.test(n)) return false;       // 非常规盘符路径
    if (/^[a-z]:\/[^/]+$/.test(n)) return false;  // 盘符根直下文件（pagefile/hiberfil/autoexec 等）
    if (WRITE_FULL_BLACKLIST.some(re => re.test(n))) return false;
    // 其他用户的 profile 目录不可写（仅当前用户 home 子树放行）
    const m = n.match(/^([a-z]:)\/users\/([^/]+)/);
    if (m) {
      const home = normalize(os.homedir());
      if (!home.startsWith(m[1] + '/users/' + m[2] + '/') && home !== m[1] + '/users/' + m[2]) return false;
    }
    return true;
  }
  return false; // userData 模式：白名单外一律拒绝
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

module.exports = { setUserDataDir, getUserDataDir, setWriteMode, getWriteMode, canRead, canWrite, readFileGuard, listDirGuard, normalize };
