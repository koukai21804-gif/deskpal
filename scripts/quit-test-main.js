// 退出路径专项验证：隔离 userData + 6 秒后 app.quit()，验证宠物窗不再阻断退出
const { app } = require('electron');
const path = require('path');
const os = require('os');
app.setPath('userData', path.join(os.tmpdir(), 'deskpal-quit-' + Date.now()));
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));
setTimeout(() => {
  console.log('[quit-test] calling app.quit()');
  app.quit();
}, 6000);
app.on('will-quit', () => console.log('[quit-test] will-quit reached'));
