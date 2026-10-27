// 主进程侧 i18n（v0.7.0）：复用渲染层的同一批词典文件（classic script 挂 globalThis.DP_I18N_EN，
// require 即累积合并）。语言读 settings.language（渲染层切换后同值）。
// 用途边界：只翻译「主进程产出的界面文案」——权限卡 action/detail/reversibility、agent 步骤/通知、
// demo 回执 message、OS 通知、原生对话框标题、会话默认名。模型契约串（system prompt、工具回执、
// 入史内容、错误回执）严禁翻译——那是模型行为契约与对话内容。
const path = require('path');
const store = require('./store');

const DICT_DIR = path.join(__dirname, '..', '..', 'renderer', 'common', 'i18n');
let loaded = false;
function loadDicts() {
  if (loaded) return;
  loaded = true;
  // 全部渲染层词典一起合并：主进程产出的文案可能出现在任何窗口
  for (const name of ['dict-core.js', 'dict-chat.js', 'dict-settings.js', 'dict-reader.js', 'dict-schedule.js', 'dict-time.js', 'dict-pet.js', 'dict-label.js']) {
    try { require(path.join(DICT_DIR, name)); } catch (_) { /* 缺文件不阻塞 */ }
  }
}

function lang() {
  try { return (store.get('settings').language === 'en') ? 'en' : 'zh'; } catch (_) { return 'zh'; }
}

function t(s) {
  if (lang() !== 'en') return s;
  loadDicts();
  const dict = globalThis.DP_I18N_EN || {};
  return Object.prototype.hasOwnProperty.call(dict, s) ? dict[s] : s;
}

function tf(pattern, ...vals) {
  return t(pattern).replace(/\{(\d+)\}/g, (_, i) => {
    const v = vals[+i];
    return v == null ? '' : String(v);
  });
}

module.exports = { t, tf, lang };
