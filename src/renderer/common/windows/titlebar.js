// 共享自绘标题栏：拖拽区 + 最小化/关闭（无边框窗口）
import { dp } from '../ipc.js';

export function mountTitlebar(title) {
  const bar = document.createElement('div');
  bar.className = 'dp-titlebar';
  bar.innerHTML = `
    <span class="title">${title}</span>
    <button class="win-btn min" title="最小化">─</button>
    <button class="win-btn close" title="关闭">✕</button>`;
  bar.querySelector('.min').addEventListener('click', () => dp.minimizeWindow());
  bar.querySelector('.close').addEventListener('click', () => window.close());
  return bar;
}
