// fs-guard 独立自测：断言读写权限边界，全部通过输出 PASS
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DESKPAL_TEST = '1';
const guard = require('fs').realpathSync(__dirname + '/..').endsWith('deskpal')
  ? require(path.join(__dirname, '..', 'src', 'main', 'services', 'fs-guard.js'))
  : null;
if (!guard) { console.error('FAIL: 无法加载 fs-guard'); process.exit(1); }

// 测试用 userData 目录
const tmpUserData = path.join(os.tmpdir(), 'deskpal-fsguard-test-' + Date.now());
fs.mkdirSync(path.join(tmpUserData, 'temp'), { recursive: true });
guard.setUserDataDir(tmpUserData);
guard.setWriteMode('userData'); // v0.3.1 起 canWrite 按权限模式分档，此脚本测 userData 档基准行为

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name); }
}

console.log('== 读黑名单 ==');
assert('DPAPI Protect 拒读', guard.canRead('C:\\Users\\x\\AppData\\Roaming\\Microsoft\\Protect\\S-1-5-20\\key') === false);
assert('Crypto 目录拒读', guard.canRead('C:\\Users\\x\\AppData\\Roaming\\Microsoft\\Crypto\\RSA\\a') === false);
assert('NTUSER.DAT 拒读', guard.canRead('C:\\Users\\x\\NTUSER.DAT') === false);
assert('Chromium Login Data 拒读', guard.canRead('C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data') === false);
assert('Firefox logins.json 拒读', guard.canRead('C:\\Users\\x\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\a.default\\logins.json') === false);
assert('key4.db 拒读', guard.canRead('C:\\ff\\key4.db') === false);
assert('KeePass kdbx 拒读', guard.canRead('D:\\sec\\pass.kdbx') === false);
assert('SSH 私钥拒读', guard.canRead('C:\\Users\\x\\.ssh\\id_rsa') === false);
assert('钱包文件拒读', guard.canRead('D:\\btc\\wallet.dat') === false);

console.log('== 正常读 ==');
assert('普通 txt 可读', guard.canRead('D:\\docs\\paper.txt') === true);
assert('用户目录普通文件可读', guard.canRead('C:\\Users\\x\\Documents\\a.docx') === true);

console.log('== 写白名单 ==');
assert('userData 可写', guard.canWrite(path.join(tmpUserData, 'config', 'settings.json')) === true);
assert('userData/temp 可写', guard.canWrite(path.join(tmpUserData, 'temp', 'x.bin')) === true);
assert('安装目录外不可写', guard.canWrite('C:\\Windows\\system32\\evil.dll') === false);
assert('用户桌面不可写', guard.canWrite('C:\\Users\\x\\Desktop\\note.txt') === false);
assert('路径穿越不可写', guard.canWrite(path.join(tmpUserData, 'temp', '..', '..', 'escape.txt')) === false);

console.log('== 读文件守卫 ==');
const sample = path.join(tmpUserData, 'temp', 'sample.txt');
fs.writeFileSync(sample, 'hello');
assert('readFileGuard 白名单内文件', guard.readFileGuard(sample).toString() === 'hello');
let threw = false;
try { guard.readFileGuard('C:\\Users\\x\\NTUSER.DAT'); } catch (e) { threw = true; }
assert('readFileGuard 黑名单抛错', threw);

fs.rmSync(tmpUserData, { recursive: true, force: true });
console.log(fail === 0 ? `PASS (${pass} 项)` : `FAIL (${fail} 失败 / ${pass} 通过)`);
process.exit(fail === 0 ? 0 : 1);
