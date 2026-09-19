// 启动表情专项验证：隔离 userData 且预设 pet.sleep=true（复现 0.2.0 bug 前置条件），
// 启动真实应用后检查宠物窗初始渲染表情应为 normal（思考）而非 thinking，且残留标记被清除
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const userData = path.join(os.tmpdir(), 'deskpal-emoboot-' + Date.now());
fs.mkdirSync(path.join(userData, 'config'), { recursive: true });
fs.writeFileSync(path.join(userData, 'config', 'settings.json'), JSON.stringify({ pet: { sleep: true } }));

app.setPath('userData', userData);
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

setTimeout(async () => {
  try {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/pet/'));
    if (!win) throw new Error('宠物窗未找到');
    const emo = await win.webContents.executeJavaScript(
      `document.querySelector('.dp-sprite img')?.alt || (document.querySelector('.dp-sprite svg') ? 'svg:normal' : 'none')`
    );
    const sleepClass = await win.webContents.executeJavaScript(
      `document.querySelector('.dp-sprite').classList.contains('sleeping')`
    );
    const persisted = JSON.parse(fs.readFileSync(path.join(userData, 'config', 'settings.json'), 'utf8'));
    const ok = emo === 'normal' && !sleepClass && persisted.pet.sleep === false;
    console.log(`[emotion-boot] 初始表情=${emo} sleeping=${sleepClass} 持久sleep=${persisted.pet.sleep} → ${ok ? 'PASS' : 'FAIL'}`);
    app.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('[emotion-boot] FAIL: ' + e.message);
    app.exit(1);
  }
}, 5000);
