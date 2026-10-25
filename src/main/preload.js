// contextBridge 白名单式 IPC API → window.deskpal
const { contextBridge, ipcRenderer } = require('electron');

// 主→渲染推送通道白名单
const PUSH_CHANNELS = [
  'theme:changed', 'settings:changed', 'sprites:changed', 'avatar:changed',
  'pet:emotion', 'pet:bubble', 'pet:sleep', 'pet:ding', 'pet:say',
  'llm:chunk', 'llm:done', 'llm:error',
  'agent:step', 'agent:permission', 'agent:artifact', 'agent:done',
  'search:ledger-changed',
  'canon:incident',
  'noreki:mail',
  'reader:progress', 'reader:qa-chunk', 'reader:qa-done', 'reader:video-progress',
  'report:chunk', 'report:done',
  'schedule:remind', 'schedule:catchup', 'schedule:changed', 'schedule:prefill',
  'ui:open-panel',
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
  canonGet: () => invoke('canon:get', {}),
  canonUpdate: (changes, reason) => invoke('canon:update', { changes, reason }),
  canonApprove: () => invoke('canon:approve', {}),
  canonReprovision: (reason, ack = false) => invoke('canon:reprovision', { reason, ack }),
  canonOpsHistory: () => invoke('canon:ops-history', {}),
  canonOpsRestore: (index) => invoke('canon:ops-restore', { index }),
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
  llmVisionDetect: (opts) => invoke('llm:vision-detect', opts || {}),
  chatSend: (tab, text) => invoke('chat:send', { tab, text }),
  chatStop: (reqId) => invoke('chat:stop', { reqId }),
  chatHistory: (tab) => invoke('chat:history', { tab }),
  chatSaveHistory: (tab, messages) => invoke('chat:save-history', { tab, messages }),
  chatExport: (tab) => invoke('chat:export', { tab }),

  // 多会话（v0.5）：主对话 + 专项会话
  chatSessions: () => invoke('chat:sessions', {}),
  chatSessionNew: (opts) => invoke('chat:session-new', opts || {}),
  chatSessionSwitch: (id) => invoke('chat:session-switch', { id }),
  chatSessionRename: (opts) => invoke('chat:session-rename', opts),
  chatSessionDelete: (id) => invoke('chat:session-delete', { id }),

  // NOREKI-Mail（v0.5.1：跨实体信件，与 Hermes 侧 clio 通信）
  norekiSend: (kind, body, ref = '') => invoke('noreki:send', { kind, body, ref }),
  norekiFetch: () => invoke('noreki:fetch', {}),
  norekiStatus: () => invoke('noreki:status', {}),
  // v1.5：查看信件（信入聊天史）+ 信箱状态（未读徽标）
  norekiRead: () => invoke('noreki:read', {}),
  norekiMailbox: () => invoke('noreki:mailbox', {}),

  // 长期记忆管理（/deep memory forcing 面板；不入聊天历史）
  memoryList: () => invoke('memory:list', {}),
  memoryAdd: (item) => invoke('memory:add', item),
  memoryDelete: (id) => invoke('memory:delete', { id }),
  memorySetScope: (id, scope) => invoke('memory:set-scope', { id, scope }),
  memoryCoreUsage: () => invoke('memory:core-usage', {}),
  memoryArchiveList: () => invoke('memory:archive-list', {}),
  memoryArchiveRestore: (id) => invoke('memory:archive-restore', { id }),

  // 用户身份档案（开发版 /user profile 面板）
  profileGet: () => invoke('profile:get', {}),
  profileSave: (doc) => invoke('profile:save', { doc }),
  profileRevert: (id) => invoke('profile:revert', { id }),
  profileSeed: (path) => invoke('profile:seed-file', { path }),
  profileArchiveList: () => invoke('profile:archive-list', {}),
  profileArchiveRestore: (index) => invoke('profile:archive-restore', { index }),

  // 记忆整理纪律（/discipline 查看面板；只读）
  disciplineView: () => invoke('discipline:view', {}),

  // 演示模式（/demo 族命令；状态权威在主进程，会话级）
  demoCommand: (text) => invoke('demo:command', { text }),
  demoState: () => invoke('demo:state', {}),

  // 联网搜索（开发版：账本面板 + 设置页供应商配置）
  searchLedger: (range, track) => invoke('search:ledger', { range, track }),
  searchVerdict: (id, verdict) => invoke('search:verdict', { id, verdict }),
  searchSaveKey: (key) => invoke('search:save-key', { key }),
  searchTest: (opts) => invoke('search:test', opts || {}),
  searchProviders: () => invoke('search:providers', {}),

  // Token 看板（开发版 /tokens 面板）
  tokenBoardQuery: () => invoke('tokenboard:query', {}),
  tokenBoardConfig: () => invoke('tokenboard:config-get', {}),
  tokenBoardConfigSave: (doc) => invoke('tokenboard:config-save', { doc }),

  // 面板直达（宠物菜单 → 本窗口面板；boot 时取一次 pending 防推送丢失）
  takePendingPanel: () => invoke('ui:take-pending-panel', {}),

  // 启动器
  launcherMatch: (text) => invoke('launcher:match', { text }),
  launcherRun: (id) => invoke('launcher:run', { id }),
  launcherList: () => invoke('launcher:list', {}),
  launcherSave: (commands) => invoke('launcher:save', { commands }),

  // 对话对象头像（设置→人设→对话对象）
  avatarGet: () => invoke('avatar:get', {}),
  avatarPickUser: () => invoke('avatar:pick-user', {}),
  avatarResetUser: () => invoke('avatar:reset-user', {}),
  avatarPickAssistant: () => invoke('avatar:pick-assistant', {}),
  avatarResetAssistant: () => invoke('avatar:reset-assistant', {}),

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
  readerUploadVideo: (opts) => invoke('reader:upload-video', opts || {}),
  readerVideoCancel: () => invoke('reader:video-cancel', {}),
  readerList: () => invoke('reader:list', {}),
  readerLoad: (bookId) => invoke('reader:load', { bookId }),
  readerGenerate: (bookId, mode) => invoke('reader:generate', { bookId, mode }),
  readerCancelGenerate: (bookId) => invoke('reader:cancel-generate', { bookId }),
  readerSave: (bookId, patch) => invoke('reader:save', { bookId, patch }),
  readerDelete: (bookId) => invoke('reader:delete', { bookId }),
  readerAsk: (bookId, question) => invoke('reader:ask', { bookId, question }),
  readerQaStop: (reqId) => invoke('reader:qa-stop', { reqId }),

  // 视频解析工具链（设置页）
  videoProbe: () => invoke('video:probe', {}),
  videoImportBinary: (kind, path) => invoke('video:import-binary', { kind, path }),
  videoSaveAsrKey: (key) => invoke('video:save-asr-key', { key }),

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

  // Agent（★H 执行管线）
  agentTools: () => invoke('agent:tools', {}),
  agentPermissionResolve: (requestId, decision) => invoke('agent:permission-resolve', { requestId, decision }),
  agentRuns: (limit) => invoke('agent:runs', { limit }),
});
