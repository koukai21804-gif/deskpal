// 渲染层公共：主题应用 / IPC 薄封装 / 工具函数
export const dp = window.deskpal; // preload 注入

// ---------- 主题 ----------
let themeState = null;
const themeListeners = [];

export function applyTheme(theme) {
  if (!theme) return;
  themeState = theme;
  const root = document.documentElement;
  root.style.setProperty('--dp-accent', theme.accent);
  root.style.setProperty('--dp-accent-fg', theme.accentFg || '#fff');
  let mode = theme.mode || 'light';
  if (mode === 'system') {
    mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.dataset.mode = mode === 'dark' ? 'dark' : 'light';
  for (const fn of themeListeners) { try { fn(theme); } catch (_) {} }
}

export async function initTheme() {
  applyTheme(await dp.themeGet());
  dp.on('theme:changed', applyTheme);
}

export function onTheme(fn) { themeListeners.push(fn); if (themeState) fn(themeState); }

// ---------- 错误处理 ----------
export function errText(e) {
  return (e && (e.message || e.error)) || String(e);
}

// ---------- 杂项 ----------
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtMin(min) {
  const m = Math.max(0, Math.round(min || 0));
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}

export function debounce(fn, ms = 300) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function uid(prefix = 'x') { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
