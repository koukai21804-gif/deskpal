// i18n 回归（v0.7.0 双语界面）：词典完整性（跨文件重复 key / 占位符两侧一致 / 空值）/
// 渲染层 t·tf 行为（zh 原样 · en 命中翻译）/ 主进程 i18n 服务同款 / 各窗口接线
// （index.html 词典先于 module、preload 同步语言桥、ipc 处理器、设置页语言选择器）。
// 用法：node scripts/test-i18n.js（纯 Node，无 electron）
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function section(t) { console.log('\n## ' + t); }

const DICT_DIR = path.join(ROOT, 'src', 'renderer', 'common', 'i18n');
const DICT_FILES = fs.readdirSync(DICT_DIR).filter(f => /^dict-.*\.js$/.test(f)).sort();

// ============ ① 词典完整性（vm 沙箱逐文件收集） ============
section('① 词典完整性：可加载 / 跨文件同键同值 / 占位符两侧一致 / 无空值');
{
  const perFile = new Map(); // file -> Map(key -> value)
  for (const f of DICT_FILES) {
    const sandbox = { globalThis: {}, console };
    sandbox.globalThis = sandbox; // classic script 用 globalThis.DP_I18N_EN 挂载
    vm.runInContext(fs.readFileSync(path.join(DICT_DIR, f), 'utf8'), vm.createContext(sandbox), { filename: f });
    const dict = sandbox.globalThis.DP_I18N_EN || {};
    ok(Object.keys(dict).length > 0, `${f} 可加载且有词条（${Object.keys(dict).length} 条）`);
    perFile.set(f, dict);
  }
  // 跨文件同键：词典按「窗口=core+自有词典」各自加载，同一键出现在多个文件属正常共享，
  // 但**值必须一致**（Object.assign 静默覆盖——后加载的会赢，值冲突即界面各窗翻译不一致）
  const keyVals = new Map(); // key -> Map(file -> value)
  for (const [f, dict] of perFile) {
    for (const [k, v] of Object.entries(dict)) {
      if (!keyVals.has(k)) keyVals.set(k, new Map());
      keyVals.get(k).set(f, v);
    }
  }
  const conflicts = [];
  for (const [k, files] of keyVals) {
    const vals = new Set(files.values());
    if (vals.size > 1) conflicts.push(`${k.slice(0, 24)} @ ${[...files.keys()].join('+')}`);
  }
  ok(conflicts.length === 0, `跨文件同键值一致${conflicts.length ? '：' + conflicts.slice(0, 6).join('；') : ''}`);
  // 占位符两侧一致（{0}{1}…数量与集合）
  let phBad = [];
  for (const [f, dict] of perFile) {
    for (const [k, v] of Object.entries(dict)) {
      const kp = (k.match(/\{\d+\}/g) || []).sort().join(',');
      const vp = (String(v).match(/\{\d+\}/g) || []).sort().join(',');
      if (kp !== vp) phBad.push(`${f}::${k.slice(0, 30)}`);
      if (typeof v !== 'string' || !v.trim()) phBad.push(`${f}::${k.slice(0, 30)}(空值)`);
    }
  }
  ok(phBad.length === 0, `占位符两侧一致且无空值${phBad.length ? '：' + phBad.slice(0, 6).join('；') : ''}`);
  // 人名口径抽查
  const all = {};
  for (const d of perFile.values()) Object.assign(all, d);
  ok(all['缇托'] === 'Titor', '缇托 → Titor');
  ok(all['缇托·诺蕾姬'] === 'Titor Knowledge', '缇托·诺蕾姬 → Titor Knowledge');
  ok(!/Noreiji/.test(JSON.stringify(all)), '词典内不出现旧译 Noreiji');
  // 导出给 ⑤ 复用
  globalThis.__PER_FILE = perFile;
}

// ============ ② 渲染层 i18n 核心：zh 原样 / en 命中翻译 / tf 回填 ============
section('② 渲染层 i18n 核心行为（zh/en）');
async function importWithLang(lang) {
  const mod = path.join(ROOT, 'src', 'renderer', 'common', 'i18n.js').replace(/\\/g, '/');
  const url = 'file:///' + mod;
  if (lang === 'en') {
    globalThis.window = { DP_I18N_LANG: 'en' }; // 模块顶层读取一次，须在 import 前就位
  }
  return import(url + '?lang=' + lang); // query 区分模块实例
}
{
  // zh（无 window）：t/tf 原样返回
  (async () => {
    const zh = await importWithLang('zh');
    ok(zh.lang() === 'zh', '默认语言 zh（无 preload 注入时兜底）');
    ok(zh.t('删除') === '删除', 'zh：t 原样返回源串');
    ok(zh.tf('{0} 条', 3) === '3 条', 'zh：tf 回填后与原拼接一致');
    ok(zh.t('不存在的键xyz') === '不存在的键xyz', 'zh：未命中原样');

    // en：词典命中翻译 + tf 先翻再回填（dict 是 classic script，require 即挂 globalThis）
    for (const f of DICT_FILES) require(path.join(DICT_DIR, f));
    const en = await importWithLang('en');
    ok(en.lang() === 'en', 'en：读取 window.DP_I18N_LANG');
    ok(en.t('删除') === 'Delete', 'en：t 命中翻译');
    ok(en.t('不存在的键xyz') === '不存在的键xyz', 'en：未命中原样回退');
    ok(en.tf('已切换到「{0}」（切换前已固化未提取的记忆）', '测试会话') === 'Switched to "测试会话" (memories not yet extracted were saved before switching)', 'en：tf 先翻模式再回填');
    ok(en.tf('{0} 条', 3) === '3 msgs', 'en：tf 占位回填');
  })().then(() => {
    section('③ 主进程 i18n 服务');
    try {
      const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-i18n-'));
      const store = require(path.join(ROOT, 'src', 'main', 'services', 'store'));
      store.init(TMP);
      const i18n = require(path.join(ROOT, 'src', 'main', 'services', 'i18n'));
      ok(i18n.lang() === 'zh', '主进程：默认 zh');
      ok(i18n.t('删除') === '删除', '主进程 zh：原样');
      store.set('settings', { language: 'en' });
      ok(i18n.lang() === 'en', '主进程：settings.language=en 生效');
      ok(i18n.t('删除') === 'Delete', '主进程 en：命中渲染层共享词典');
      ok(i18n.tf('专项会话 {0}', 3) === 'Task session 3', '主进程 en：tf 回填');
      ok(i18n.t('这是模型契约串') === '这是模型契约串', '主进程 en：未命中原样（模型契约不受影响）');
    } catch (e) {
      ok(false, '主进程 i18n 服务异常：' + e.message);
    }
    section('④ 各窗口接线');
    {
      const windows = ['chat', 'settings', 'reader', 'schedule', 'time', 'pet', 'label'];
      for (const w of windows) {
        const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', w, 'index.html'), 'utf8');
        ok(html.includes('common/i18n/dict-core.js'), `${w}/index.html 加载 dict-core`);
        ok(html.indexOf('dict-core.js') < html.indexOf('type="module"'), `${w}/index.html 词典先于 module 执行`);
      }
      const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
      ok(preload.includes("sendSync('i18n:lang')"), 'preload：同步语言桥（ES module 顶层拼文案等不了异步 IPC）');
      ok(preload.includes("exposeInMainWorld('DP_I18N_LANG'"), 'preload：注入 DP_I18N_LANG');
      ok(preload.includes("'i18n:changed'"), 'preload：推送通道白名单含 i18n:changed');
      ok(preload.includes('i18nSet'), 'preload：暴露 i18nSet');
      const ipc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
      ok(ipc.includes("ipcMain.on('i18n:lang'"), 'ipc：同步语言应答');
      ok(ipc.includes("handle('i18n:set'") && ipc.includes("broadcastAll('i18n:changed'"), 'ipc：切换语言 + 全窗广播');
      ok(ipc.includes('i18n.t('), 'ipc：宠物右键菜单走主进程 i18n');
      const settings = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings', 'app.js'), 'utf8');
      ok(settings.includes('id="langSelect"') && settings.includes('dp.i18nSet('), '设置页：语言选择器 + 切换调用');
      // 核心模块的标题映射与重载监听
      const core = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'common', 'i18n.js'), 'utf8');
      ok(core.includes('document.title') && core.includes("on('i18n:changed'"), 'i18n.js：窗口标题随语言 + 切换重载');
    }
    section('⑤ 逐窗口键覆盖：t/tf 用键 ⊆ core ∪ 本窗词典（词典按窗各自加载，不是全局合并）');
    {
      // 源码静态抽取 t('..')/tf('..') 首参，还原 \n \' \\ 转义后与运行时键对齐
      const WINDOWS = {
        chat: ['src/renderer/chat/app.js'],
        settings: ['src/renderer/settings/app.js'],
        reader: ['src/renderer/reader/app.js'],
        schedule: ['src/renderer/schedule/app.js'],
        time: ['src/renderer/time/app.js'],
        pet: ['src/renderer/pet/pet.js', 'src/renderer/pet/bubble.js'],
        label: ['src/renderer/label/app.js'],
      };
      const ownOf = (w) => (globalThis.__PER_FILE.get(`dict-${w}.js`) || new Map());
      const coreDict = globalThis.__PER_FILE.get('dict-core.js') || new Map();
      for (const [win, srcs] of Object.entries(WINDOWS)) {
        const avail = new Set([...Object.keys(coreDict), ...Object.keys(ownOf(win))]);
        const used = new Set();
        for (const f of srcs) {
          const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
          for (const re of [/\bt\('((?:[^'\\]|\\.)+)'\)/g, /\btf\('((?:[^'\\]|\\.)+)'/g]) {
            let m;
            while ((m = re.exec(src))) used.add(m[1].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c)));
          }
        }
        const missing = [...used].filter(k => !avail.has(k));
        ok(missing.length === 0, `${win}：${used.size} 键全覆盖${missing.length ? '，缺 ' + JSON.stringify(missing.slice(0, 3)) : ''}`);
      }
    }
    console.log(`\n========== i18n 回归：${passed} 通过，${failed} 失败 ==========`);
    if (failed) process.exit(1);
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}
