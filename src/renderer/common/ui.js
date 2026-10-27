// 通用 UI：toast / confirm / modal / 骨架屏
import { icon } from './icons.js';
import { t } from './i18n.js';

const TOAST_ICON = { ok: 'checkCircle', error: 'xCircle', warn: 'alert', info: 'info' };

export function toast(msg, type = 'info', ms = 2600) {
  let host = document.getElementById('dp-toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'dp-toasts';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'info' ? 'info' : type);
  el.innerHTML = `${icon(TOAST_ICON[type] || 'info', 16)}<span>${esc(msg)}</span>`;
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; setTimeout(() => el.remove(), 220); }, ms);
}

// 确认框 → Promise<boolean>
export function confirmBox(msg, { title = '', okText = '', danger = false } = {}) {
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'dp-modal-mask';
    mask.innerHTML = `
      <div class="dp-modal" style="min-width:320px">
        <div class="modal-head"><span>${esc(title || t('确认'))}</span></div>
        <div class="modal-body" style="padding-bottom:10px;line-height:1.6">${esc(msg)}</div>
        <div class="modal-foot">
          <button class="btn btn-sm" data-act="no">${t('取消')}</button>
          <button class="btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}" data-act="yes">${esc(okText || t('确定'))}</button>
        </div>
      </div>`;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } };
    const done = (v) => { mask.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    mask.addEventListener('click', e => {
      const act = e.target && e.target.dataset && e.target.dataset.act;
      if (act === 'yes') done(true);
      else if (act === 'no' || e.target === mask) done(false);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(mask);
    const yes = mask.querySelector('[data-act=yes]');
    if (yes) setTimeout(() => yes.focus(), 30);
  });
}

// 打开一个通用 modal 容器 → 返回 { el, body, close }
export function openModal({ title = '', width } = {}) {
  const mask = document.createElement('div');
  mask.className = 'dp-modal-mask';
  const el = document.createElement('div');
  el.className = 'dp-modal';
  if (width) el.style.width = width;
  el.innerHTML = `<div class="modal-head"><span>${esc(title)}</span>`
    + `<button class="btn btn-icon sm modal-close" title="${t('关闭（Esc）')}">${icon('close', 16)}</button></div>`
    + `<div class="modal-body"></div>`;
  mask.appendChild(el);
  document.body.appendChild(mask);
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => { mask.remove(); document.removeEventListener('keydown', onKey); };
  mask.addEventListener('mousedown', e => { if (e.target === mask) close(); });
  el.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  return { el, body: el.querySelector('.modal-body'), close };
}

// 骨架屏：替换「加载中…」文字，避免布局跳动
export function skeletonBlock(lines = 3) {
  const widths = ['', 'w80', 'w60'];
  return '<div class="skeleton-wrap" aria-busy="true">' +
    Array.from({ length: lines }, (_, i) => `<div class="skeleton line ${widths[i % widths.length]}"></div>`).join('') +
    '</div>';
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
