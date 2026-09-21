// GUI 测试种子：在指定隔离 profile 里注入真实 API 配置（用该 profile 自己的 safeStorage 加密，自洽可解）
// 用法：npx electron scripts/seed-gui.js <profileDir>
// 之后：DESKPAL_USERDATA=<profileDir> npm start 启动的实例即可直接使用已配置的 API。
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function decryptRealKey(realDir, encB64) {
  const ls = JSON.parse(fs.readFileSync(path.join(realDir, 'Local State'), 'utf8'));
  const wrapped = Buffer.from(ls.os_crypt.encrypted_key, 'base64');
  const ps = "Add-Type -AssemblyName System.Security; "
    + `$k=[Convert]::FromBase64String('${wrapped.subarray(5).toString('base64')}'); `
    + "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($k,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); "
    + "[Console]::Out.Write([Convert]::ToBase64String($p))";
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error('DPAPI 解包失败');
  const aesKey = Buffer.from(r.stdout.trim(), 'base64');
  const ct = Buffer.from(encB64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey, ct.subarray(3, 15));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(15, ct.length - 16)), d.final()]).toString('utf8');
}

const seedDir = process.argv[2];
if (!seedDir) { console.error('用法：npx electron scripts/seed-gui.js <profileDir>'); process.exit(2); }

app.setPath('userData', seedDir); // 本进程即用目标 profile：加密与将来解密同一把 os_crypt key
app.whenReady().then(() => {
  try {
    const realDir = path.join(process.env.APPDATA, 'deskpal');
    const realApi = JSON.parse(fs.readFileSync(path.join(realDir, 'config', 'api.json'), 'utf8'));
    const key = decryptRealKey(realDir, realApi.apiKeyEnc);
    const store = require('../src/main/services/store');
    store.init(seedDir);
    const llm = require('../src/main/services/llm');
    llm.saveKey(key); // 用当前 profile 的 safeStorage 加密落盘（自洽）
    store.set('api', { endpoint: realApi.endpoint, model: realApi.model, params: realApi.params || {} });
    store.flushAll();
    console.log('种子完成：' + seedDir);
    app.exit(0);
  } catch (e) { console.error('种子失败：' + (e.stack || e.message)); app.exit(1); }
});
