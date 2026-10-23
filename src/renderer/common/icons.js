// 单色线性图标集：24×24 网格，stroke 1.75，继承 currentColor。
// 用途：替代 UI 层的 emoji —— emoji 是彩色位图，不继承 currentColor，
// 三态（hover/active/disabled）全部失效，且不同字形视觉重心不一致。
// 用法：icon('send')            -> 18px（默认）
//      icon('trash', 16)       -> 16px
//      el.innerHTML = icon('x')
const P = {
  close:     '<path d="M6 6 18 18M18 6 6 18"/>',
  minimize:  '<path d="M5 12h14"/>',
  maximize:  '<rect x="5" y="5" width="14" height="14" rx="2.5"/>',
  plus:      '<path d="M12 5v14M5 12h14"/>',
  check:     '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
  chevronD:  '<path d="M6 9.5 12 15.5 18 9.5"/>',
  chevronR:  '<path d="M9.5 5.5 15.5 12 9.5 18.5"/>',
  chevronL:  '<path d="M14.5 5.5 8.5 12 14.5 18.5"/>',
  send:      '<path d="M21 3 10.5 13.5"/><path d="M21 3l-6.8 18-3.7-7.5L3 9.8z"/>',
  stop:      '<rect x="7.5" y="7.5" width="9" height="9" rx="1.5"/>',
  play:      '<path d="M7.5 4.5 19 12 7.5 19.5z"/>',
  trash:     '<path d="M4.5 7h15M10 7V5.5h4V7M7 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h5.2a1.5 1.5 0 0 0 1.5-1.4L17 7"/>',
  copy:      '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9"/>',
  refresh:   '<path d="M20 12a8 8 0 0 1-13.66 5.66M4 12a8 8 0 0 1 13.66-5.66"/><path d="M18 2.5V7h-4.5M6 21.5V17h4.5"/>',
  download:  '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15"/>',
  upload:    '<path d="M12 20V9M7.5 13.5 12 9l4.5 4.5M4.5 4.5h15"/>',
  search:    '<circle cx="11" cy="11" r="6.5"/><path d="M15.8 15.8 20.5 20.5"/>',
  user:      '<circle cx="12" cy="8.5" r="3.75"/><path d="M4.75 20a7.25 7.25 0 0 1 14.5 0"/>',
  message:   '<rect x="3.5" y="4.5" width="17" height="12" rx="3"/><path d="M8.5 16.5v3.8l4.4-3.8"/>',
  bolt:      '<path d="M13.5 2.5 5.5 13.5h5l-.5 8L18.5 10.5h-5.5z"/>',
  sliders:   '<path d="M4 7h10M18.5 7H20M4 17h4.5M13 17h7"/><circle cx="16.25" cy="7" r="2.25"/><circle cx="10.75" cy="17" r="2.25"/>',
  palette:   '<circle cx="12" cy="12" r="8.5"/><circle cx="9" cy="9.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="9.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="16" cy="14.5" r="1.3" fill="currentColor" stroke="none"/>',
  plug:      '<path d="M9 3v5M15 3v5M6.5 8h11v2.5a5.5 5.5 0 0 1-11 0zM12 16.5V21"/>',
  terminal:  '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7.5 9.5 10.5 12l-3 2.5M13 15h4"/>',
  tag:       '<path d="M11.5 3.5H20v8.5l-8.3 8.3a1.5 1.5 0 0 1-2.1 0l-6.4-6.4a1.5 1.5 0 0 1 0-2.1z"/><circle cx="16.1" cy="7.9" r="1.3"/>',
  clock:     '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.3 2"/>',
  calendar:  '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  book:      '<path d="M4.5 5.5A2 2 0 0 1 6.5 3.5H19v15H6.5a2 2 0 0 0-2 2z"/><path d="M4.5 18.5h14.5v2H6.5"/>',
  info:      '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="7.9" r=".95" fill="currentColor" stroke="none"/>',
  shield:    '<path d="M12 3.2 5 6v5.4c0 4.2 2.9 7.6 7 9.4 4.1-1.8 7-5.2 7-9.4V6z"/>',
  mail:      '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m3.8 7.2 7.3 5.3a1.5 1.5 0 0 0 1.8 0l7.3-5.3"/>',
  image:     '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.75"/><path d="m4.5 17.5 4.7-4.3a1.5 1.5 0 0 1 2 0l5 4.6"/>',
  camera:    '<rect x="3" y="7" width="18" height="13" rx="2.5"/><circle cx="12" cy="13.5" r="3.75"/><path d="M8.5 7 9.8 4.7h4.4L15.5 7"/>',
  folder:    '<path d="M3.5 6.5a2 2 0 0 1 2-2h3.3l2 2.5h7.7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  file:      '<path d="M6 3.5h7l5 5v12H6z"/><path d="M13 3.5v5h5"/>',
  layers:    '<path d="m12 3.5 8.5 4.5L12 12.5 3.5 8zM3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5"/>',
  chart:     '<path d="M4.5 20v-8M10 20V5.5M15.5 20v-5M21 20V9M3 20.5h18"/>',
  sparkle:   '<path d="M12 3.5l1.9 4.8 4.8 1.9-4.8 1.9L12 16.9l-1.9-4.8L5.3 10.2l4.8-1.9z"/><path d="M18.6 15.4l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  sweep:     '<path d="M4 20.5h16M9 16.5l-2.5 4M15 16.5l2.5 4M7.5 16.5h9l-1-9h-7z"/>',
  alert:     '<path d="M12 4.5 21 19.5H3zM12 10v4"/><circle cx="12" cy="16.9" r=".95" fill="currentColor" stroke="none"/>',
  xCircle:   '<circle cx="12" cy="12" r="8.5"/><path d="M9.2 9.2 14.8 14.8M14.8 9.2 9.2 14.8"/>',
  checkCircle:'<circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.3 10.9 15 15.9 9.4"/>',
  questionCircle:'<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.6"/><circle cx="12" cy="16.9" r=".95" fill="currentColor" stroke="none"/>',
  lock:      '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  unlock:    '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 7.5-2"/>',
  key:       '<circle cx="8" cy="15.5" r="3.5"/><path d="M10.5 13 19 4.5M16 7.5l2 2M14 9.5l2 2"/>',
  pencil:    '<path d="M4 20h4L19.3 8.7a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16z"/>',
  save:      '<path d="M4.5 6.5A2 2 0 0 1 6.5 4.5h9.3L19.5 8.2v9.3a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"/><path d="M8.5 4.5v5h7v-5M8 19.5v-5h8v5"/>',
  undo:      '<path d="M4 10h9.5a5.5 5.5 0 0 1 0 11H9"/><path d="M7.5 6 3.5 10l4 4"/>',
  arrowR:    '<path d="M4 12h15M13.5 6.5 20 12l-6.5 5.5"/>',
  arrowL:    '<path d="M20 12H5M10.5 6.5 4 12l6.5 5.5"/>',
  eye:       '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3.2"/>',
  monitor:   '<rect x="3" y="4.5" width="18" height="12" rx="2.5"/><path d="M9 20h6M12 16.5V20"/>',
  video:     '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m15.5 10.5 6-3.5v10l-6-3.5z"/>',
  star:      '<path d="m12 3.8 2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 10l5.9-.8z"/>',
  dots:      '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  dot:       '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
};

export function icon(name, size = 18, extraClass = '') {
  const body = P[name];
  if (!body) return '';
  return `<svg class="dp-ic ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" `
       + `fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" `
       + `stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
export const ICON_NAMES = Object.keys(P);
