// 通用 UI：toast / confirm / modal
export function toast(msg, type = 'info', ms = 2600) {
  let host = document.getElementById('dp-toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'dp-toasts';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'info' ? '' : type);
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; setTimeout(() => el.remove(), 220); }, ms);
}

// 确认框 → Promise<boolean>
export function confirmBox(msg, { title = '确认', okText = '确定', danger = false } = {}) {
  return new Promise(resolve => {
    const mask = document.createElement('div');
    mask.className = 'dp-modal-mask';
    mask.innerHTML = `
      <div class="dp-modal" style="min-width:320px">
        <div class="modal-head">${esc(title)}</div>
        <div class="modal-body" style="padding-bottom:10px;line-height:1.6">${esc(msg)}</div>
        <div class="modal-foot">
          <button class="btn btn-sm" data-act="no">取消</button>
          <button class="btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}" data-act="yes">${esc(okText)}</button>
        </div>
      </div>`;
    mask.addEventListener('click', e => {
      const act = e.target && e.target.dataset && e.target.dataset.act;
      if (act === 'yes') { mask.remove(); resolve(true); }
      else if (act === 'no' || e.target === mask) { mask.remove(); resolve(false); }
    });
    document.body.appendChild(mask);
  });
}

// 打开一个通用 modal 容器 → 返回 { el, body, close }
export function openModal({ title = '', width } = {}) {
  const mask = document.createElement('div');
  mask.className = 'dp-modal-mask';
  const el = document.createElement('div');
  el.className = 'dp-modal';
  if (width) el.style.width = width;
  el.innerHTML = `<div class="modal-head">${esc(title)}</div><div class="modal-body"></div>`;
  mask.appendChild(el);
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('mousedown', e => { if (e.target === mask) close(); });
  return { el, body: el.querySelector('.modal-body'), close };
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
