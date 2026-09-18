// 从项目根目录 图标.png 生成全套程序图标：
//   resources/icon.png(16, 托盘) / icon-32.png(32) / icon-256.png(256) / icon.ico(16-256 多尺寸)
// 运行：npx electron scripts/gen-icons.js
const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
// 源图：根目录 icon.png（历史名 图标.png 兼容）
const SRC = [path.join(ROOT, 'icon.png'), path.join(ROOT, '图标.png')].find(p => fs.existsSync(p));
const OUT = path.join(ROOT, 'resources');

app.whenReady().then(async () => {
  try {
    if (!SRC) throw new Error('缺少源图标 icon.png');
    const src = nativeImage.createFromPath(SRC);
    if (src.isEmpty()) throw new Error('图标.png 无法读取');
    const size = src.getSize();
    console.log('[gen-icons] 源图:', size.width + 'x' + size.height);

    const pngs = {};
    for (const s of [16, 32, 48, 64, 128, 256]) {
      pngs[s] = src.resize({ width: s, height: s, quality: 'best' }).toPNG();
    }
    fs.writeFileSync(path.join(OUT, 'icon.png'), pngs[16]);
    fs.writeFileSync(path.join(OUT, 'icon-32.png'), pngs[32]);
    fs.writeFileSync(path.join(OUT, 'icon-256.png'), pngs[256]);

    const pngToIco = require('png-to-ico');
    const ico = await pngToIco([16, 32, 48, 64, 128, 256].map(s => pngs[s]));
    fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);

    for (const f of ['icon.png', 'icon-32.png', 'icon-256.png', 'icon.ico']) {
      const st = fs.statSync(path.join(OUT, f));
      console.log('[gen-icons] 写出', f, (st.size / 1024).toFixed(1) + 'KB');
    }
    setTimeout(() => app.exit(0), 200);
  } catch (e) {
    console.error('[gen-icons] FAILED:', e.message);
    setTimeout(() => app.exit(1), 200);
  }
});
