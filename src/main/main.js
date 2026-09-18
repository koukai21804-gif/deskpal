// 入口：单实例锁 / 托盘 / 窗口 / 生命周期 / 服务启动
const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const logger = require('./logger');
const store = require('./services/store');
const windows = require('./windows');
const registerIpc = require('./ipc');

let tray = null;
let scheduler = null;
let activity = null;

app.setAppUserModelId('com.deskpal.app'); // Windows 通知必需，第一行

// 单实例锁
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    try { windows.openWindow('pet'); windows.openWindow('chat'); } catch (_) {}
  });

  app.whenReady().then(() => {
    const dataDir = app.getPath('userData');
    logger.init(path.join(dataDir, 'logs'));
    logger.info('deskpal 启动 ' + app.getVersion() + ' dataDir=' + dataDir);
    store.init(dataDir);

    registerIpc();
    createTray();
    windows.openWindow('pet');

    // 日程调度器
    try {
      scheduler = require('./services/schedule/scheduler');
      scheduler.start();
    } catch (e) { logger.error(e); }

    // 时间监测
    try {
      activity = require('./services/activity/watchers');
      activity.start();
    } catch (e) { logger.error(e); }

    // 冒烟模式：8 秒后自动退出（供自动化验证）；SMOKE=full 打开全部窗口
    if (process.env.DESKPAL_SMOKE) {
      if (process.env.DESKPAL_SMOKE === 'full') {
        for (const n of ['chat', 'reader', 'time', 'schedule', 'settings', 'label']) windows.openWindow(n);
      }
      setTimeout(() => {
        logger.info('SMOKE OK');
        app.exit(0);
      }, process.env.DESKPAL_SMOKE === 'full' ? 10000 : 8000);
    }
  });
}

function trayIcon() {
  const p = path.join(__dirname, '..', 'resources', 'icon.png');
  try { return nativeImage.createFromPath(p); } catch (_) { return nativeImage.createEmpty(); }
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('deskpal 桌面宠物');
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
  tray.on('double-click', () => windows.openWindow('pet'));
  // 指令变化后刷新托盘菜单
  store.onDataChanged(name => {
    if (name === 'commands' || name === 'settings') {
      try { tray.setContextMenu(Menu.buildFromTemplate(trayTemplate())); } catch (_) {}
    }
  });
}

function trayTemplate() {
  const settings = store.get('settings');
  const commands = store.get('commands').commands || [];
  const items = [
    { label: '💬 聊天', click: () => windows.openWindow('chat') },
    { label: '📖 陪读', click: () => windows.openWindow('reader') },
    { label: '⏱ 时间统计', click: () => windows.openWindow('time') },
    { label: '📅 日程', click: () => windows.openWindow('schedule') },
    { label: '⚙️ 设置', click: () => windows.openWindow('settings') },
    { type: 'separator' },
  ];
  if (commands.length) {
    const { runByCommand } = require('./services/launcher');
    items.push({
      label: '🚀 快捷打开',
      submenu: commands.slice(0, 10).map(c => ({
        label: c.phrase + (c.missing ? '（路径失效）' : ''),
        click: () => runByCommand(c).catch(() => {}),
      })),
    });
  }
  items.push(
    { label: '⏸ 暂停时间监测', type: 'checkbox', checked: !!settings.activity.paused, click: (mi) => {
        const watchers = require('./services/activity/watchers');
        watchers.setPaused(mi.checked);
      } },
    { type: 'separator' },
    { label: '🚪 退出', click: () => app.quit() },
  );
  return items;
}

app.on('window-all-closed', () => { /* 宠物窗常驻 + 托盘，不退出 */ });

app.on('before-quit', () => {
  try {
    windows.markQuitting(); // 放行宠物窗 close，否则 quit 会被取消、托盘一直挂着
    if (tray) { tray.destroy(); tray = null; } // 立即移除托盘图标，避免 Windows 通知区残留
    if (activity) activity.stop();
    if (scheduler) scheduler.stop();
    const tracker = require('./services/activity/tracker');
    tracker.flush();
    store.flushAll();
  } catch (e) { logger.error(e); }
});
