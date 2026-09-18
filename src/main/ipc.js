// 全部 IPC 路由。统一封装：成功返回数据；失败抛中文 userMsg（preload 捕获包装）
const { ipcMain, dialog, shell, Menu, app, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const store = require('./services/store');
const themeSvc = require('./theme');
const windows = require('./windows');
const llm = require('./services/llm');
const chat = require('./services/chat');
const launcher = require('./services/launcher');
const emotion = require('./services/emotion');
const reading = require('./services/reading');
const watchers = require('./services/activity/watchers');
const statsSvc = require('./services/activity/stats');
const reportSvc = require('./services/activity/report');
const scheduler = require('./services/schedule/scheduler');
const scheduleParser = require('./services/schedule/parser');
const scheduleExcel = require('./services/schedule/excel');

function handle(channel, handler) {
  ipcMain.handle(channel, async (e, arg = {}) => {
    try {
      return await handler(arg, e);
    } catch (err) {
      logger.error(`[${channel}] ` + (err.userMsg || err.message));
      throw new Error(err.userMsg || '操作失败：' + err.message);
    }
  });
}

function registerIpc() {
  // ---------- 窗口 ----------
  handle('window:open', ({ name }) => { windows.openWindow(name); return { ok: true }; });
  handle('window:close', ({ name }) => { windows.closeWindow(name); return { ok: true }; });
  handle('window:minimize', (_arg, e) => {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) win.minimize();
    return { ok: true };
  });
  // 宠物窗拖拽：渲染层只报告 start/end，窗口移动由主进程定时器跟随系统光标。
  // 不走「渲染层 client 坐标测位移 → IPC → setPosition」：窗口一动 client 坐标即被平移，
  // 测量值与窗口位置互相干扰（反馈回路），叠加 IPC 往返延迟就表现为卡顿抖动。
  // 光标位置优先用 koffi GetCursorPos（物理坐标，与窗口位置无关）+ screenToDipPoint 换算；
  // getCursorScreenPoint 在混合 DPI 多显示器下读数会随窗口所在显示器变化，绝对定位会漂移。
  let getCursorPhys = null;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const GetCursorPos = user32.func('bool __stdcall GetCursorPos(void *pt)');
    getCursorPhys = () => {
      const b = Buffer.alloc(8);
      if (!GetCursorPos(b)) return null;
      return { x: b.readInt32LE(0), y: b.readInt32LE(4) };
    };
  } catch (_) { getCursorPhys = null; }
  const cursorDip = () => {
    const p = getCursorPhys && getCursorPhys();
    if (p) { try { return screen.screenToDipPoint(p); } catch (_) {} }
    return screen.getCursorScreenPoint();
  };
  const dragState = { active: false, timer: null, grab: null, width: 0 };
  const stopDrag = () => {
    dragState.active = false;
    if (dragState.timer) { clearInterval(dragState.timer); dragState.timer = null; }
  };
  const followCursor = () => {
    if (!dragState.active) return;
    try {
      const win = windows.getWindow('pet');
      if (!win || win.isDestroyed()) { stopDrag(); return; }
      const cursor = cursorDip();
      let tx = cursor.x - dragState.grab.x;
      let ty = cursor.y - dragState.grab.y;
      try {
        const display = screen.getDisplayNearestPoint({ x: Math.round(tx), y: Math.round(ty) }).workArea;
        const w = dragState.width;
        // 贴边微吸附：距边缘 <4px 吸到工作区边缘
        if (Math.abs(tx - display.x) < 4) tx = display.x;
        if (Math.abs(tx + w - (display.x + display.width)) < 4) tx = display.x + display.width - w;
        if (Math.abs(ty - display.y) < 4) ty = display.y;
      } catch (_) {}
      // 限速追赶：慢速拖动 1:1 贴手；拖起/快速甩动时光标已跑远，
      // 若一步到位会产生可见跳变，改为每帧最多挪 MAX_STEP px 平滑追上
      const MAX_STEP = 28; // 16ms 一帧 ≈ 1750px/s，超过人手甩动速度
      const [cx, cy] = win.getPosition();
      let dx = Math.round(tx) - cx, dy = Math.round(ty) - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) return; // 已贴住光标
      if (dist > MAX_STEP) { dx = dx / dist * MAX_STEP; dy = dy / dist * MAX_STEP; }
      win.setPosition(Math.round(cx + dx), Math.round(cy + dy));
    } catch (e) {
      logger.error(e);
      stopDrag();
    }
  };
  handle('pet:drag', ({ phase, gx, gy }) => {
    const win = windows.getWindow('pet');
    if (!win) { stopDrag(); return { ok: false }; }
    if (phase === 'start') {
      if (dragState.active) return { ok: true };
      const [wx, wy] = win.getPosition();
      // 抓取点优先取渲染层 pointerdown 的 client 坐标（client == DIP），
      // 消除 start 消息传输延迟期间光标移动造成的偏差
      if (Number.isFinite(gx) && Number.isFinite(gy)) {
        dragState.grab = { x: gx, y: gy };
      } else {
        const cursor = cursorDip();
        dragState.grab = { x: cursor.x - wx, y: cursor.y - wy };
      }
      dragState.width = win.getBounds().width;
      dragState.active = true;
      dragState.timer = setInterval(followCursor, 16);
    } else if (phase === 'end') {
      stopDrag();
    }
    return { ok: true };
  });
  handle('window:pet-menu', () => {
    const { screen } = require('electron');
    const cursor = screen.getCursorScreenPoint();
    buildPetMenu().popup({ window: windows.getWindow('pet') || undefined, x: cursor.x, y: cursor.y });
    return { ok: true };
  });
  handle('window:settings-tab', ({ tab }) => {
    windows.openWindow('settings');
    const win = windows.getWindow('settings');
    if (win) win.webContents.send('settings:changed', { tab });
    return { ok: true };
  });

  // 渲染层驱动宠物表情（陪读放映等）
  handle('pet:emote', ({ emotion: emo, source, revertMs }) => {
    emotion.broadcastEmotion(emo, { source: source || 'reader', revertMs: revertMs || 0 });
    return { ok: true };
  });

  // ---------- 配置 ----------
  handle('store:get', ({ name }) => {
    if (name === 'api') {
      const api = store.get('api');
      return { ...api, apiKeyEnc: undefined, hasKey: !!api.apiKeyEnc };
    }
    return store.get(name);
  });
  handle('store:set', ({ name, patch }) => {
    const merged = store.set(name, patch);
    windows.broadcastAll('settings:changed', { name });
    return merged;
  });
  handle('theme:get', () => themeSvc.current());
  handle('theme:set', (patch) => { themeSvc.set(patch); return themeSvc.current(); });
  handle('theme:presets', () => themeSvc.PRESETS);
  // 角色扮演 system prompt 预览（设置页人设 tab）
  handle('prompt:preview', () => require('./services/prompts').roleplaySystem());
  // API Key 单独保存（safeStorage 加密）
  handle('api:save-key', ({ key }) => { llm.saveKey(String(key || '')); return { ok: true }; });

  // ---------- 对话框 / shell / app ----------
  handle('dialog:pick-file', async ({ title, filters = [], multi = false }) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title, filters, properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    });
    return canceled ? null : (multi ? filePaths : filePaths[0]);
  });
  handle('dialog:save-text', async ({ defaultName, content }) => {
    const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: defaultName });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, String(content ?? ''), 'utf8');
    return filePath;
  });
  handle('shell:open-external', async ({ url }) => {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) throw new Error('只允许打开 http/https 链接'); // 阻断 file:/shell: 等协议
    await shell.openExternal(u);
    return { ok: true };
  });
  handle('shell:open-path', async ({ path: p }) => {
    if (!fs.existsSync(p)) throw new Error('路径不存在');
    await shell.openPath(p);
    return { ok: true };
  });
  handle('shell:show-in-folder', ({ path: p }) => { shell.showItemInFolder(p); return { ok: true }; });
  handle('app:info', () => ({ version: app.getVersion(), dataDir: store.getDataDir() }));
  handle('app:ding', () => {
    try {
      const wav = fs.readFileSync(path.join(__dirname, '..', 'resources', 'ding.wav'));
      return 'data:audio/wav;base64,' + wav.toString('base64');
    } catch (_) { return null; }
  });

  // ---------- LLM / 聊天 ----------
  handle('llm:test', () => llm.testConnection());
  // 模型列表（设置页：填好地址+Key 后自动调取，供下拉选择）
  handle('llm:list-models', (opts) => llm.listModels(opts || {}));
  handle('chat:send', async ({ tab, text }) => {
    if (!['roleplay', 'quick'].includes(tab)) throw new Error('未知聊天标签');
    if (!String(text || '').trim()) throw new Error('消息不能为空');
    chat.bumpUserCount(tab);
    return chat.send(tab, String(text).trim());
  });
  handle('chat:stop', ({ reqId }) => { llm.stop(reqId); return { ok: true }; });
  handle('chat:history', ({ tab }) => chat.getHistory(tab));
  handle('chat:save-history', ({ tab, messages }) => { chat.saveHistory(tab, messages || []); return { ok: true }; });
  handle('chat:export', ({ tab }) => chat.exportChat(tab));

  // ---------- 启动器 ----------
  handle('launcher:match', ({ text }) => launcher.match(text));
  handle('launcher:run', async ({ id }) => launcher.runById(id));
  handle('launcher:list', () => launcher.list());
  handle('launcher:save', ({ commands }) => launcher.save(commands));

  // ---------- 形象 ----------
  handle('sprites:get', () => store.get('sprites'));  handle('sprites:upload', ({ emotion: emo, path: src }) => {
    const EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
    const ext = path.extname(src).toLowerCase();
    if (!EXT.includes(ext)) throw new Error('只支持 png / jpg / webp / gif');
    if (!require('./services/fs-guard').canRead(src)) throw new Error('没有权限读取该文件（敏感路径）');
    const stat = fs.statSync(src);
    if (stat.size > 8 * 1024 * 1024) throw new Error('图片超过 8MB，换一张小一点的吧');
    if (!['normal', 'happy', 'surprised', 'angry', 'thinking', 'sad'].includes(emo)) throw new Error('未知表情槽位');
    const hash = require('crypto').createHash('md5').update(fs.readFileSync(src)).digest('hex').slice(0, 8);
    const dest = path.join(store.getDataDir(), 'sprites', `${emo}_${hash}${ext}`);
    fs.copyFileSync(src, dest);
    store.set('sprites', { slots: { [emo]: { mode: 'image', file: dest } } });
    windows.broadcastAll('sprites:changed', {});
    return store.get('sprites');
  });
  handle('sprites:reset', ({ emotion: emo }) => {
    // 恢复默认 = 内置形象（缇托），而非旧 SVG 圆球
    const defSlot = (store.DEFAULTS.sprites.slots || {})[emo];
    store.set('sprites', { slots: { [emo]: defSlot ? JSON.parse(JSON.stringify(defSlot)) : { mode: 'svg' } } });
    windows.broadcastAll('sprites:changed', {});
    return store.get('sprites');
  });

  // ---------- 陪读 ----------
  handle('reader:upload', ({ path: p }) => reading.upload(p));
  handle('reader:list', () => reading.list());
  handle('reader:load', ({ bookId }) => reading.load(bookId));
  handle('reader:generate', ({ bookId }) => reading.generate(bookId));
  handle('reader:cancel-generate', ({ bookId }) => { reading.cancelGenerate(bookId); return { ok: true }; });
  handle('reader:save', ({ bookId, patch }) => reading.save(bookId, patch));
  handle('reader:delete', ({ bookId }) => { reading.del(bookId); return { ok: true }; });
  handle('reader:ask', ({ bookId, question }) => reading.ask(bookId, String(question).trim()));
  handle('reader:qa-stop', ({ reqId }) => { llm.stop(reqId); return { ok: true }; });

  // ---------- 宠物设定档案（人设+形象绑定） ----------
  handle('pets:list', () => require('./services/pets').list());
  handle('pets:save', ({ name }) => require('./services/pets').save(name));
  handle('pets:apply', ({ id }) => require('./services/pets').apply(id));
  handle('pets:delete', ({ id }) => require('./services/pets').del(id));
  handle('pets:export', ({ id }) => require('./services/pets').exportProfile(id));
  handle('pets:import', ({ path: p }) => require('./services/pets').importProfile(p));

  // ---------- 时间管理 ----------
  handle('time:stats', ({ range }) => statsSvc.stats(range === 'week' ? 'week' : 'today'));
  handle('time:unknown-apps', () => statsSvc.unknownApps('today'));
  handle('time:label-save', ({ labels }) => statsSvc.saveLabels(labels || []));
  handle('time:report', ({ range }) => reportSvc.generate(range === 'week' ? 'week' : 'today'));
  handle('time:report-stop', ({ reqId }) => { llm.stop(reqId); return { ok: true }; });
  handle('time:paused', () => ({ paused: !!store.get('settings').activity.paused }));
  handle('time:set-paused', ({ paused }) => { watchers.setPaused(!!paused); return { ok: true }; });
  handle('time:open-label', () => { windows.openWindow('label'); return { ok: true }; });

  // ---------- 日程 ----------
  handle('schedule:parse', ({ text }) => scheduleParser.parseNL(String(text || '').trim()));
  handle('schedule:add', ({ event }) => scheduler.addEvent(scheduler.newEvent(event)));
  handle('schedule:list', () => scheduler.listEvents());
  handle('schedule:update', ({ event }) => scheduler.updateEvent(event));
  handle('schedule:delete', ({ id }) => { scheduler.deleteEvent(id); return { ok: true }; });
  handle('schedule:done', ({ id }) => { scheduler.doneEvent(id); return { ok: true }; });
  handle('schedule:snooze', ({ eventId, reminderId }) => { scheduler.snoozeReminder(eventId, reminderId); return { ok: true }; });
  handle('schedule:dismiss', ({ eventId, reminderId }) => { scheduler.dismissReminder(eventId, reminderId); return { ok: true }; });
  handle('schedule:excel-parse', async ({ path: p }) => {
    const sheet = await scheduleExcel.parseExcel(p);
    return sheet;
  });
  handle('schedule:excel-decompose', async (sheet) => scheduleExcel.decompose(sheet || {}));
  handle('schedule:excel-import', async ({ tasks }) => {
    const groupId = 'grp_' + Date.now().toString(36);
    const drafts = scheduleExcel.buildImportDraft(tasks || [], groupId);
    for (const d of drafts) scheduler.addEvent(d);
    return { imported: drafts.length, groupId };
  });
  // 日程速添预填（聊天/宠物菜单触发：打开日程窗并执行解析）
  handle('schedule:prefill', ({ text }) => {
    windows.openWindow('schedule');
    const win = windows.getWindow('schedule');
    if (win) win.webContents.send('schedule:prefill', { text: String(text || '') });
    return { ok: true };
  });

  // ---------- Agent（预留，未接入聊天） ----------
  handle('agent:tools', () => require('./services/agent/builtin').list());

  logger.info('IPC 路由注册完成');
}

// 宠物右键菜单（主进程 Menu.popup 保证层级）
function buildPetMenu() {
  const commands = launcher.list();
  const tpl = [
    { label: '💬 聊天', click: () => windows.openWindow('chat') },
    { label: '📖 陪读', click: () => windows.openWindow('reader') },
    { label: '⏱ 时间统计', click: () => windows.openWindow('time') },
    { label: '📅 日程', click: () => windows.openWindow('schedule') },
    { label: '🎨 换装/形象', click: () => windows.openWindow('settings') },
    { label: '⚙️ 设置', click: () => windows.openWindow('settings') },
    { type: 'separator' },
  ];
  if (commands.length) {
    tpl.push({
      label: '🚀 快捷打开',
      submenu: commands.slice(0, 10).map(c => ({
        label: c.phrase + (c.missing ? '（路径失效）' : ''),
        click: () => launcher.runById(c.id).catch(() => {}),
      })),
    });
  }
  tpl.push(
    { label: '😴 休息一下', click: () => toggleSleep() },
    { type: 'separator' },
    { label: '🚪 退出', click: () => require('electron').app.quit() },
  );
  return Menu.buildFromTemplate(tpl);
}

function toggleSleep() {
  const s = store.get('settings');
  const on = !s.pet.sleep;
  store.set('settings', { pet: { sleep: on } });
  windows.broadcastAll('pet:sleep', { on });
}

module.exports = registerIpc;
