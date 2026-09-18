// 日程：自然语言 → 结构化事件（LLM + 本地校验）
const dayjs = require('dayjs');
const llm = require('../llm');
const prompts = require('../prompts');
const { rescueJSON } = require('../json-utils');
const logger = require('../../logger');
const { materializeReminders, newEvent } = require('./scheduler');

// 解析结果：{understood, draft?, question?}
async function parseNL(text) {
  let out = null;
  try {
    const res = await llm.genericCompletion(
      [{ role: 'system', content: prompts.scheduleParsePrompt(text) }],
      { temperature: 0.1, maxTokens: 400 },
    );
    out = rescueJSON(res);
  } catch (e) {
    throw e; // API 错误原样上抛（中文 userMsg 已由 llm.js 包装）
  }
  if (!out || typeof out !== 'object') {
    return { understood: false, question: '没听懂这句话，换种说法试试？例如「明天晚上18点我要跟女朋友约会」' };
  }
  if (!out.understood) {
    return { understood: false, question: out.question || null };
  }
  // 本地校验
  const start = dayjs(out.start, 'YYYY-MM-DD HH:mm', true);
  const deadline = out.deadline ? dayjs(out.deadline, 'YYYY-MM-DD HH:mm', true) : null;
  const errors = [];
  if (!start.isValid() && !deadline) errors.push('开始/截止时间无法解析');
  if (start.isValid() && start.isBefore(dayjs().subtract(1, 'minute'))) errors.push('时间已经过去了');
  if (start.isValid() && start.isAfter(dayjs().add(1, 'year'))) errors.push('时间超过一年后，先不安排啦');
  if (deadline && deadline.isBefore(dayjs().subtract(1, 'minute'))) errors.push('截止时间已经过去');
  if (out.durationMin != null && (!(+out.durationMin > 0) || +out.durationMin > 1440)) out.durationMin = null;
  if (errors.length) {
    return { understood: false, question: errors[0] + '，可以再说一次具体时间吗？' };
  }
  const draft = newEvent({
    kind: out.kind === 'task' ? 'task' : 'event',
    title: String(out.title || text).slice(0, 20) || '未命名日程',
    start: start.isValid() ? start : null,
    deadline: deadline || null,
    durationMin: out.durationMin != null ? +out.durationMin : null,
    remindPreset: ['event', 'start', 'deadline', 'none'].includes(out.remindPreset)
      ? out.remindPreset
      : (out.kind === 'task' ? (deadline ? 'deadline' : start.isValid() ? 'start' : 'none') : 'event'),
    notes: '',
    source: 'nl',
  });
  materializeReminders(draft);
  return { understood: true, draft, question: null };
}

module.exports = { parseNL };
