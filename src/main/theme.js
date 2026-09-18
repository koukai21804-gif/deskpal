// 主题服务：读取 settings.theme，计算前景色，变更时全窗口广播
const { BrowserWindow } = require('electron');
const store = require('./services/store');

const PRESETS = [
  { name: '草地绿', accent: '#7DBE3C' },
  { name: '海空蓝', accent: '#4A90D9' },
  { name: '樱花粉', accent: '#E583B0' },
  { name: '葡萄紫', accent: '#8E7CC3' },
  { name: '落日橙', accent: '#E8A33D' },
];

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}

function buildTheme(patch) {
  const t = { ...store.get('settings').theme, ...patch };
  const [r, g, b] = hexToRgb(t.accent);
  const [, , l] = rgbToHsl(r, g, b);
  t.accentFg = l > 0.62 ? '#222233' : '#ffffff';
  t.mode = t.mode || 'light';
  return t;
}

function current() { return buildTheme({}); }

function set(patch) {
  store.set('settings', { theme: patch });
  broadcast();
  return current();
}

function broadcast() {
  const theme = current();
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('theme:changed', theme); } catch (_) {}
  }
}

module.exports = { current, set, broadcast, PRESETS };
