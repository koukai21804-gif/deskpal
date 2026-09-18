// 宠物形象显示诊断：隔离 userData（等价新用户首次启动），
// 检查 sprites:get 返回的槽位、pet 窗 <img> 的加载状态（naturalWidth/error）
const { app } = require('electron');
const path = require('path');
const os = require('os');

app.setPath('userData', path.join(os.tmpdir(), 'deskpal-spritechk-' + Date.now()));
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const store = require(path.join(__dirname, '..', 'src', 'main', 'services', 'store'));
    const windows = require(path.join(__dirname, '..', 'src', 'main', 'windows'));
    await sleep(2500); // 等 pet 窗加载
    const slots = store.get('sprites').slots;
    console.log('[sprite-check] slots.normal =', JSON.stringify(slots.normal));
    for (const k of Object.keys(slots)) {
      const f = slots[k] && slots[k].file;
      if (f) console.log(`[sprite-check] ${k}: file 存在=${require('fs').existsSync(f)} ${f}`);
    }
    const win = windows.getWindow('pet');
    if (!win) { console.log('[sprite-check] FAIL: pet 窗不存在'); setTimeout(() => app.exit(1), 200); return; }
    const state = await win.webContents.executeJavaScript(`(async () => {
      const host = document.querySelector('.dp-sprite');
      const img = host && host.querySelector('img');
      const out = { hostTag: host ? host.tagName : null, hasImg: !!img };
      if (img) {
        out.src = img.src;
        out.complete = img.complete;
        out.naturalWidth = img.naturalWidth;
        out.naturalHeight = img.naturalHeight;
        if (!(img.complete && img.naturalWidth > 0)) {
          const r = await new Promise(resolve => {
            const t = setTimeout(() => resolve('timeout-3s'), 3000);
            img.addEventListener('load', () => { clearTimeout(t); resolve('loaded-late'); }, { once: true });
            img.addEventListener('error', () => { clearTimeout(t); resolve('error-event'); }, { once: true });
          });
          out.waitFor = r;
          out.naturalWidth = img.naturalWidth;
        }
        const rect = img.getBoundingClientRect();
        out.rect = { w: Math.round(rect.width), h: Math.round(rect.height) };
      } else {
        out.hostHTML = host ? host.innerHTML.slice(0, 120) : 'NO .dp-sprite';
      }
      return out;
    })()`);
    console.log('[sprite-check] 渲染状态:', JSON.stringify(state, null, 2));
    setTimeout(() => app.exit(0), 300);
  } catch (e) {
    console.error('[sprite-check] EXCEPTION', e);
    setTimeout(() => app.exit(1), 200);
  }
});
