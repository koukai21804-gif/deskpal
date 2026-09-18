// contextBridge 白名单式 IPC API → window.deskpal
const { contextBridge, ipcRenderer } = require('electron');

// 主→渲染推送通道白名单
const PUSH_CHANNELS = [
  'theme:changed', 'settings:changed', 'sprites:changed',
  'pet:emotion', 'pet:bubble', 'pet:sleep', 'pet:ding', 'pet:say',
  'llm:chunk', 'llm:done', 'llm:error',
  'reader:progress', 'reader:qa-chunk', 'reader:qa-done',
  'report:chunk', 'report:done',
  'schedule:remind', 'schedule:catchup', 'schedule:changed', 'schedule:prefill',
  'activity:idle-back', 'time:changed',
];

const invoke = (channel, arg) => ipcRenderer.invoke(channel, arg);

// 订阅推送：返回取消函数
function on(channel, cb) {
  if (!PUSH_CHANNELS.includes(channel)) throw new Error('未登记的推送通道: ' + channel);
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

contextBridge.exposeInMainWorld('deskpal', {
  // 订阅（白名单通道）
  on,
  once(channel, cb) {
    if (!PUSH_CHANNELS.includes(channel)) throw new Error('未登记的推送通道: ' + channel);
    ipcRenderer.once(channel, (_e, data) => cb(data));
  },

  // 窗口
  openWindow: (name) => invoke('window:open', { name }),
  closeWindow: (name) => invoke('window:close', { name }),
  minimizeWindow: () => invoke('window:minimize', {}),
  petMenu: () => invoke('window:pet-menu', {}),
  petEmote: (emotion, source = 'reader', revertMs = 0) => invoke('pet:emote', { emotion, source, revertMs }),
  invokePetDrag: (phase, data = {}) => invoke('pet:drag', { phase, ...data }),
  getDingUrl: () => invoke('app:ding', {}),
  openSettingsTab: (tab) => invoke('window:settings-tab', { tab }),

  // 配置
  storeGet: (name) => invoke('store:get', { name }),
  storeSet: (name, patch) => invoke('store:set', { name, patch }),
  themeGet: () => invoke('theme:get', {}),
  themeSet: (patch) => invoke('theme:set', patch),
  themePresets: () => invoke('theme:presets', {}),
  buildSystemPreview: () => invoke('prompt:preview', {}),
  saveApiKey: (key) => invoke('api:save-key', { key }),

  // 对话框 / shell
  pickFile: (opts) => invoke('dialog:pick-file', opts),
  saveText: (opts) => invoke('dialog:save-text', opts),
  openExternal: (url) => invoke('shell:open-external', { url }),
  openPath: (p) => invoke('shell:open-path', { path: p }),
  showInFolder: (p) => invoke('shell:show-in-folder', { path: p }),
  appInfo: () => invoke('app:info', {}),

  // LLM / 聊天
  llmTest: () => invoke('llm:test', {}),
  llmListModels: (opts) => invoke('llm:list-models', opts),
  chatSend: (tab, text) => invoke('chat:send', { tab, text }),
  chatStop: (reqId) => invoke('chat:stop', { reqId }),
  chatHistory: (tab) => invoke('chat:history', { tab }),
  chatSaveHistory: (tab, messages) => invoke('chat:save-history', { tab, messages }),
  chatExport: (tab) => invoke('chat:export', { tab }),

  // 启动器
  launcherMatch: (text) => invoke('launcher:match', { text }),
  launcherRun: (id) => invoke('launcher:run', { id }),
  launcherList: () => invoke('launcher:list', {}),
  launcherSave: (commands) => invoke('launcher:save', { commands }),

  // 形象
  spritesGet: () => invoke('sprites:get', {}),
  spritesUpload: (emotion, path) => invoke('sprites:upload', { emotion, path }),
  spritesReset: (emotion) => invoke('sprites:reset', { emotion }),

  // 宠物设定档案（人设+形象绑定）
  petsList: () => invoke('pets:list', {}),
  petsSave: (name) => invoke('pets:save', { name }),
  petsApply: (id) => invoke('pets:apply', { id }),
  petsDelete: (id) => invoke('pets:delete', { id }),
  petsExport: (id) => invoke('pets:export', { id }),
  petsImport: (path) => invoke('pets:import', { path }),

  // 陪读
  readerUpload: (path) => invoke('reader:upload', { path }),
  readerList: () => invoke('reader:list', {}),
  readerLoad: (bookId) => invoke('reader:load', { bookId }),
  readerGenerate: (bookId) => invoke('reader:generate', { bookId }),
  readerCancelGenerate: (bookId) => invoke('reader:cancel-generate', { bookId }),
  readerSave: (bookId, patch) => invoke('reader:save', { bookId, patch }),
  readerDelete: (bookId) => invoke('reader:delete', { bookId }),
  readerAsk: (bookId, question) => invoke('reader:ask', { bookId, question }),
  readerQaStop: (reqId) => invoke('reader:qa-stop', { reqId }),

  // 时间管理
  timeStats: (range) => invoke('time:stats', { range }),
  timeUnknownApps: () => invoke('time:unknown-apps', {}),
  timeLabelSave: (labels) => invoke('time:label-save', { labels }),
  timeReport: (range) => invoke('time:report', { range }),
  timeReportStop: (reqId) => invoke('time:report-stop', { reqId }),
  timePaused: () => invoke('time:paused', {}),
  timeSetPaused: (paused) => invoke('time:set-paused', { paused }),
  timeOpenLabel: () => invoke('time:open-label', {}),

  // 日程
  scheduleParse: (text) => invoke('schedule:parse', { text }),
  scheduleAdd: (event) => invoke('schedule:add', { event }),
  scheduleList: () => invoke('schedule:list', {}),
  scheduleUpdate: (event) => invoke('schedule:update', { event }),
  scheduleDelete: (id) => invoke('schedule:delete', { id }),
  scheduleDone: (id) => invoke('schedule:done', { id }),
  scheduleSnooze: (eventId, reminderId) => invoke('schedule:snooze', { eventId, reminderId }),
  scheduleDismiss: (eventId, reminderId) => invoke('schedule:dismiss', { eventId, reminderId }),
  scheduleExcelParse: (path) => invoke('schedule:excel-parse', { path }),
  scheduleExcelDecompose: (sheet) => invoke('schedule:excel-decompose', sheet),
  scheduleExcelImport: (tasks) => invoke('schedule:excel-import', { tasks }),
  schedulePrefill: (text) => invoke('schedule:prefill', { text }),

  // Agent（预留）
  agentTools: () => invoke('agent:tools', {}),
});
