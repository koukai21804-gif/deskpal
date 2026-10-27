// 共享自绘标题栏：拖拽区 + 最小化/关闭（无边框窗口）
import { dp } from '../ipc.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

export function mountTitlebar(title) {
  const bar = document.createElement('div');
  bar.className = 'dp-titlebar';
  bar.innerHTML = `
    <span class="title">${title}</span>
    <button class="win-btn min" title="${t('最小化')}">${icon('minimize', 16)}</button>
    <button class="win-btn close" title="${t('关闭')}">${icon('close', 16)}</button>`;
  bar.querySelector('.min').addEventListener('click', () => dp.minimizeWindow());
  bar.querySelector('.close').addEventListener('click', () => window.close());
  return bar;
}
