// 打包期：用 png-to-ico 把 256px PNG 转成 Windows .ico
const path = require('path');
module.exports.run = async () => {
  const pngToIco = require('png-to-ico');
  const fs = require('fs');
  const src = path.join(__dirname, '..', 'resources', 'icon-256.png');
  const dest = path.join(__dirname, '..', 'resources', 'icon.ico');
  if (!fs.existsSync(src)) throw new Error('缺少 icon-256.png，请先运行 npm run postinstall');
  const buf = await pngToIco(src);
  fs.writeFileSync(dest, buf);
  console.log('[make-icon] 写出', dest);
};
if (require.main === module) module.exports.run().catch(e => { console.error(e); process.exit(1); });
