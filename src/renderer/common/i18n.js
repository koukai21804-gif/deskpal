// i18n 核心（v0.7.0 双语界面）：中文源串即 key，en 词典命中才翻译、未命中原样返回。
// - 语言来自 preload 同步注入的 window.DP_I18N_LANG（sendSync，先于一切 ES module 执行）；
// - 词典来自 classic script 预挂到 globalThis.DP_I18N_EN 的各界面词典文件（common/i18n/dict-*.js），
//   classic script 天然先于 <script type="module"> 执行，保证模块顶层 t() 可用；
// - 切换语言：设置页 dp.i18nSet(lang) → 主进程广播 i18n:changed → 本模块监听后整窗重载
//   （UI 文案全部在渲染层静态拼装，重载即完成切换；设置页全部即时保存，重载无丢失面）。
// 主进程侧同源词典见 src/main/services/i18n.js（OS 通知/对话框/权限卡等主进程产出的界面文案）。
const LANG = (typeof window !== 'undefined' && window.DP_I18N_LANG) === 'en' ? 'en' : 'zh';
const EN = (typeof globalThis !== 'undefined' && globalThis.DP_I18N_EN) || {};

export function lang() { return LANG; }

// 静态串：t('已复制')
export function t(s) {
  return LANG === 'en' && Object.prototype.hasOwnProperty.call(EN, s) ? EN[s] : s;
}

// 动态串：模板先改写成带 {0}{1}… 占位符的模式，翻译后回填。
// zh 模式下回填结果与原模板拼接完全一致（等价替换，不改中文文案）。
export function tf(pattern, ...vals) {
  return t(pattern).replace(/\{(\d+)\}/g, (_, i) => {
    const v = vals[+i];
    return v == null ? '' : String(v);
  });
}

// 语言切换广播 → 整窗重载（相机采集页无 deskpal 桥，天然跳过）
if (typeof window !== 'undefined' && window.deskpal) {
  try {
    window.deskpal.on('i18n:changed', () => { try { window.location.reload(); } catch (_) {} });
  } catch (_) { /* 通道未登记等异常不阻塞界面 */ }
}

// 窗口标题（任务栏/Alt-Tab 面随语言；各 index.html 的 <title> 是静态中文）
if (typeof document !== 'undefined' && document.title) {
  const tTitle = t(document.title);
  if (tTitle !== document.title) document.title = tTitle;
}
