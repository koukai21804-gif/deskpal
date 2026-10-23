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

const FG_DARK = '#0F1419';
const FG_LIGHT = '#FFFFFF';

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// WCAG 2.1 相对亮度：按人眼敏感度加权，不用 HSL 亮度近似（后者对黄绿橙系统性高估）
function srgbToLinear(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function relLuminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrast(l1, l2) {
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
// 给定背景 hex，返回对比度更高的前景色（正文 AA 4.5:1 判据）
function pickFg(hex) {
  const bg = relLuminance(hexToRgb(hex));
  const dark = relLuminance(hexToRgb(FG_DARK));
  const light = relLuminance(hexToRgb(FG_LIGHT));
  return contrast(bg, dark) >= contrast(bg, light) ? FG_DARK : FG_LIGHT;
}

function normalizeAccent(accent) {
  return /^#[0-9a-f]{6}$/i.test(String(accent || '')) ? accent : PRESETS[0].accent;
}

function buildTheme(patch) {
  const t = { ...store.get('settings').theme, ...patch };
  t.accent = normalizeAccent(t.accent);
  t.accentFg = pickFg(t.accent);
  t.mode = t.mode || 'light';
  return t;
}

function current() { return buildTheme({}); }

function set(patch) {
  if (patch && patch.accent !== undefined) patch = { ...patch, accent: normalizeAccent(patch.accent) };
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

module.exports = { current, set, broadcast, PRESETS, pickFg, contrast, relLuminance, hexToRgb };
