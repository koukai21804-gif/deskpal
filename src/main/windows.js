// 窗口注册表：创建/复用/位置记忆（bounds 持久化到 settings.windows）
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const store = require('./services/store');
const logger = require('./logger');

const PRELOAD = path.join(__dirname, 'preload.js');

// persist: 'position' 只记 x/y（宠物窗尺寸固定）；'bounds' 记全量
const WIN_DEFS = {
  pet: {
    file: 'src/renderer/pet/index.html', w: 320, h: 420, frame: false, transparent: true,
    alwaysOnTop: true, level: 'screen-saver', resizable: false, skipTaskbar: true,
    hasShadow: false, persist: 'position',
  },
  chat: { file: 'src/renderer/chat/index.html', w: 900, h: 680, minW: 720, minH: 560, frame: false, persist: 'bounds' },
  reader: { file: 'src/renderer/reader/index.html', w: 1120, h: 760, minW: 900, minH: 640, frame: false, persist: 'bounds' },
  time: { file: 'src/renderer/time/index.html', w: 980, h: 720, minW: 800, minH: 600, frame: false, persist: 'bounds' },
  schedule: { file: 'src/renderer/schedule/index.html', w: 880, h: 660, minW: 720, minH: 560, frame: false, persist: 'bounds' },
  settings: { file: 'src/renderer/settings/index.html', w: 920, h: 740, minW: 760, minH: 620, frame: false, persist: 'bounds' },
  label: { file: 'src/renderer/label/index.html', w: 540, h: 580, minW: 460, minH: 460, frame: false, persist: 'position' },
};

const windows = new Map();

// 正在退出应用：宠物窗放行 close，否则它会 preventDefault 阻断 app.quit()
let quitting = false;
function markQuitting() { quitting = true; }

function saveBoundsThrottled(name, win) {
  if (win._dpSaveTimer) clearTimeout(win._dpSaveTimer);
  win._dpSaveTimer = setTimeout(() => {
    try {
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      const cur = store.get('settings').windows[name] || {};
      const def = WIN_DEFS[name];
      const patch = def.persist === 'position'
        ? { ...cur, x: b.x, y: b.y }
        : { x: b.x, y: b.y, width: b.width, height: b.height };
      store.set('settings', { windows: { [name]: patch } });
    } catch (e) { logger.warn('保存窗口位置失败: ' + e.message); }
  }, 500);
}

function ensureOnScreen(bounds) {
  try {
    const display = screen.getDisplayMatching({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
    const wa = display.workArea;
    if (bounds.x < wa.x - 40 || bounds.y < wa.y - 40 ||
        bounds.x + bounds.width > wa.x + wa.width + 40 || bounds.y + bounds.height > wa.y + wa.height + 40) {
      // 越界：居中回落
      bounds.x = wa.x + Math.round((wa.width - bounds.width) / 2);
      bounds.y = wa.y + Math.round((wa.height - bounds.height) / 2);
    }
  } catch (_) {}
  return bounds;
}

function createWindow(name) {
  const def = WIN_DEFS[name];
  const saved = store.get('settings').windows[name] || {};
  const bounds = { x: saved.x, y: saved.y, width: saved.width || def.w, height: saved.height || def.h };
  const hasPos = Number.isFinite(saved.x) && Number.isFinite(saved.y);
  ensureOnScreen(bounds);

  const opts = {
    width: bounds.width, height: bounds.height,
    minWidth: def.minW, minHeight: def.minH,
    frame: def.frame !== false, transparent: !!def.transparent,
    alwaysOnTop: !!def.alwaysOnTop, resizable: def.resizable !== false,
    skipTaskbar: !!def.skipTaskbar, hasShadow: def.hasShadow !== false,
    show: false, backgroundColor: def.transparent ? '#00000000' : '#ffffff',
    icon: path.join(__dirname, '..', '..', 'resources', 'icon.png'), // 任务栏/Alt+Tab 图标（打包后用 exe 图标）
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  };
  if (hasPos) { opts.x = bounds.x; opts.y = bounds.y; }

  const win = new BrowserWindow(opts);
  if (def.level) win.setAlwaysOnTop(true, def.level);

  win.once('ready-to-show', () => {
    if (name === 'pet') win.show(); else win.show();
  });
  win.loadFile(path.join(__dirname, '..', '..', def.file));

  if (def.persist) {
    win.on('resize', () => saveBoundsThrottled(name, win));
    win.on('move', () => saveBoundsThrottled(name, win));
  }

  win.on('close', (e) => {
    if (name === 'pet' && !quitting) { e.preventDefault(); win.hide(); return; } // 宠物窗常驻（退出时放行）
    if (win._dpSaveTimer) clearTimeout(win._dpSaveTimer);
    try {
      const b = win.getBounds();
      const cur = store.get('settings').windows[name] || {};
      const patch = def.persist === 'position'
        ? { ...cur, x: b.x, y: b.y }
        : { x: b.x, y: b.y, width: b.width, height: b.height };
      if (def.persist) store.set('settings', { windows: { [name]: patch } });
      store.flushAll();
    } catch (_) {}
    windows.delete(name);
  });

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
    if (input.type === 'keyDown' && input.key === 'r' && (input.control || input.meta)) e.preventDefault();
  });

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) logger.warn(`[renderer:${name}] ${message} (${sourceId ? String(sourceId).split('/').pop() : ''}:${line})`);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error(new Error(`窗口 ${name} 渲染进程崩溃: ` + details.reason));
    windows.delete(name);
    setTimeout(() => { try { openWindow(name); } catch (_) {} }, 1000);
  });

  windows.set(name, win);
  return win;
}

function openWindow(name) {
  const def = WIN_DEFS[name];
  if (!def) throw new Error('未知窗口: ' + name);
  let win = windows.get(name);
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    return win;
  }
  return createWindow(name);
}

function getWindow(name) {
  const win = windows.get(name);
  return win && !win.isDestroyed() ? win : null;
}

function closeWindow(name) {
  const win = windows.get(name);
  if (win && !win.isDestroyed()) win.close();
}

function broadcastAll(channel, payload) {
  for (const win of windows.values()) {
    try { if (!win.isDestroyed()) win.webContents.send(channel, payload); } catch (_) {}
  }
}

module.exports = { openWindow, getWindow, closeWindow, broadcastAll, markQuitting, WIN_DEFS };
