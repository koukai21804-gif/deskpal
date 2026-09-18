// 内置台词兜底池（人设称呼动态注入）；优先使用人设配置的口头禅
export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// 表情标签：台词中可夹带 [开心]/[悲伤] 等（支持中文与英文键），显示台词时同步切换对应差分图
const EMO_KEY_MAP = {
  平常: 'normal', 开心: 'happy', 惊讶: 'surprised', 愤怒: 'angry', 思考: 'thinking', 悲伤: 'sad',
  normal: 'normal', happy: 'happy', surprised: 'surprised', angry: 'angry', thinking: 'thinking', sad: 'sad',
};

// 解析一句台词：取出第一个可识别的表情标签并从文本中剥离，返回 { text, emotion|null }
export function parseLine(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/\[([^\[\]]{1,10})\]/);
  if (m) {
    const key = EMO_KEY_MAP[m[1]];
    if (key) {
      return { text: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(), emotion: key };
    }
  }
  return { text, emotion: null };
}

export function petName(persona) {
  return (persona && persona.pet && persona.pet.name) || '缇托·诺蕾姬';
}

// 对话对象称呼：跟随人设（persona.user.name），默认「主人」
export function masterName(persona) {
  const n = persona && persona.user && String(persona.user.name || '').trim();
  return n || '主人';
}

// 点击台词：人设口头禅优先（按行拆分，可带表情标签），没配则用内置兜底池（称呼动态注入）
export function clickLines(persona) {
  const custom = String((persona && persona.pet && persona.pet.catchphrases) || '')
    .split('\n').map(s => s.trim()).filter(Boolean).map(parseLine).filter(l => l.text);
  if (custom.length) return custom;
  const m = masterName(persona);
  return [
    `检索中……嗯，${m}有什么指令？`,
    '检测到注意力峰值……状态不错，继续！',
    '待机中……点我两下可以开始聊天。',
    '异常值……这个需求不在预设模型里，但我会试试。',
    '桌面扫描完毕，暂无异常项。',
    '今天的学习队列……需要我帮你排个序吗？',
    '读代码还是读书？我可以陪跑。',
    '系统负载正常，随时待命。',
    `${m}，日程表我盯着呢，放心。`,
    '有不懂的概念……我可以拆解成简单版本。',
  ].map(t => ({ text: t, emotion: null }));
}

// 闲置搭话（称呼动态注入）
export function idleLine(persona) {
  const m = masterName(persona);
  return pick([
    `${m}是不是去忙了……进入低功耗待机。`,
    '（安静地整理数据线）……你回来啦。',
    '监控进程运行中，桌面交给我。',
    '久坐提醒：检测到长时间无操作哦。',
    '需要我检索点什么吗？随时待命。',
  ]);
}
