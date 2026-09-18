// 分类器：正则规则（最长匹配优先）+ 用户标注 + 内置应用预设 + 系统应用忽略表
const store = require('../store');

// 内置：按 exe 名精确匹配（小写）
const BUILTIN_EXE = {
  // 工作（开发/办公）
  'code.exe': '工作', 'cursor.exe': '工作', 'windsurf.exe': '工作', 'idea64.exe': '工作', 'webstorm64.exe': '工作',
  'pycharm64.exe': '工作', 'goland64.exe': '工作', 'clion64.exe': '工作', 'devenv.exe': '工作',
  'sublime_text.exe': '工作', 'notepad++.exe': '工作', 'notepad.exe': '工作', 'gvim.exe': '工作',
  'windowsterminal.exe': '工作', 'powershell.exe': '工作', 'pwsh.exe': '工作', 'cmd.exe': '工作',
  'git-bash.exe': '工作', 'mintty.exe': '工作', 'filezilla.exe': '工作', 'winscp.exe': '工作',
  'winword.exe': '工作', 'excel.exe': '工作', 'powerpnt.exe': '工作', 'onenote.exe': '工作',
  'outlook.exe': '工作', 'teams.exe': '工作', 'typora.exe': '工作', 'obsidian.exe': '工作',
  'notion.exe': '工作', 'dingtalk.exe': '工作', 'wemeetapp.exe': '工作', 'feishu.exe': '工作',
  'electron.exe': '工作', 'node.exe': '工作', 'postman.exe': '工作',
  // 学习
  'zotero.exe': '学习', 'cajviewer.exe': '学习', 'matlab.exe': '学习', 'xmind.exe': '学习', 'anki.exe': '学习',
  // 娱乐
  'steam.exe': '娱乐', 'steamwebhelper.exe': '娱乐', 'epicgameslauncher.exe': '娱乐', 'wegame.exe': '娱乐',
  'spotify.exe': '娱乐', 'cloudmusic.exe': '娱乐', 'qqmusic.exe': '娱乐', 'kugou.exe': '娱乐',
  'potplayermini64.exe': '娱乐', 'vlc.exe': '娱乐', 'mpv.exe': '娱乐',
  // 社交
  'wechat.exe': '社交', 'weixin.exe': '社交', 'qq.exe': '社交', 'telegram.exe': '社交', 'discord.exe': '社交',
  'soul.exe': '社交', 'whatsapp.exe': '社交',
};

// 内置：标题正则（最长正则优先），主要用于浏览器内细分
const BUILTIN_TITLE_RULES = [
  { re: /bilibili|哔哩哔哩|youtube|爱奇艺|优酷|腾讯视频|芒果tv|netflix|disney\+|动漫|番剧/i, cat: '娱乐' },
  { re: /github|stackoverflow|csdn|掘金|知乎|segmentfault|leetcode|牛客|documentation|docs\.|wikipedia|wiki|arxiv|知网|scholar|菜鸟教程|runoob/i, cat: '学习' },
  { re: /淘宝|京东|天猫|拼多多|闲鱼|购物|美团|饿了么/i, cat: '其他' },
  { re: /mail|邮箱|gmail|outlook\.com|qq\.com.*邮/i, cat: '工作' },
  { re: /微博|twitter|x\.com|instagram|facebook|小红书|bbs|论坛|贴吧/i, cat: '社交' },
  { re: /game|游戏|steam|epic/i, cat: '娱乐' },
];

// 浏览器 exe：需要靠标题分类，标题匹配不上则未知（等待标注）
const BROWSERS = new Set(['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'arc.exe']);

// 返回 {category} | {unknown:true} | {ignore:true}
function classify(exeName, title) {
  const exe = String(exeName || '').toLowerCase();
  const t = String(title || '');
  const cfg = store.get('categories');

  // 1. 忽略表（内置 + 用户）
  if ((cfg.ignore || []).some(x => String(x).toLowerCase() === exe)) return { ignore: true };

  // 2. 用户标注（标注窗保存的精确 exe 映射）
  const labels = cfg.appLabels || {};
  if (labels[exe]) return { category: labels[exe] };

  // 3. 用户自定义规则（regex，最长匹配优先）
  const userRules = (cfg.rules || [])
    .filter(r => r && r.regex)
    .map(r => { try { return { re: new RegExp(r.regex, 'i'), cat: r.category, len: r.regex.length }; } catch (_) { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.len - a.len);
  for (const r of userRules) {
    if (r.re.test(exe) || r.re.test(t)) return { category: r.cat };
  }

  // 4. 内置 exe 预设
  if (BUILTIN_EXE[exe]) return { category: BUILTIN_EXE[exe] };

  // 5. 内置标题规则（浏览器或其他应用的细分）
  if (BROWSERS.has(exe)) {
    const hit = [...BUILTIN_TITLE_RULES].sort((a, b) => b.re.source.length - a.re.source.length).find(r => r.re.test(t));
    if (hit) return { category: hit.cat };
    return { unknown: true };
  }
  for (const r of BUILTIN_TITLE_RULES) {
    if (r.re.test(t)) return { category: r.cat };
  }
  return { unknown: true };
}

function categoryList() {
  return store.get('categories').categories || [];
}

module.exports = { classify, categoryList, BUILTIN_EXE, BROWSERS };
