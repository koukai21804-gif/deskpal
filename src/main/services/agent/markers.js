// 结构记号（单一来源）：系统向模型陈述「可验证的事实」。
// 借鉴 Cortico markers.ts 的 NOT_EXECUTED_* 家族语义（诚实认知论）：
// 每一次「工具调用没有执行」的时刻，都以显式回执进入上下文——半截调用配对
// 永不悬空，模型与系统对「发生了什么」不再分叉。回执化之后，loop 的
// WRITE/READ/SEARCH_CLAIM 词表守卫职责收窄为纯内容层兜底（拦「对用户的
// 口头谎称」），不再承担传输层事实的推断。
// 文案风格与既有 [system]/（系统核实：…）提示一致；记号只陈述系统可确认
// 的事实（截断/断开/压缩是 loop 可验证的状态），不做启发式推论。

// 未执行回执：作为 role=tool 消息回填，与 assistant tool_calls 一一配对。
// kind：'length'（max_tokens 截断，参数多半只发了一半）/ 'stream_cut'（传输中途断开）
function notExecutedReceipt(kind, detail) {
  const reasons = {
    length: '上一条输出达到 max_tokens 上限被截断',
    stream_cut: '上一条输出在网络传输中途断开',
  };
  const extra = detail ? `（${detail}）` : '';
  return `[未执行] ${reasons[kind] || '上一条输出提前结束'}${extra}：这条工具调用没有被执行，参数不完整、不可信，其预期效果不存在。请重新发起完整的调用，不要假设它已生效。`;
}

// 上下文压缩注记（P0-4 溢出→交接）：进入 system 提示，告知历史已被机械压缩
function compactedHistoryNote({ memoryFlushed } = {}) {
  return '[系统注记：对话历史因超出模型上下文窗口已被压缩，更早内容已略去'
    + (memoryFlushed ? '；其中值得长期保留的信息已尽量固化进长期记忆' : '')
    + '。请基于现有内容继续任务。]';
}

// 断流半截交付注记（P0-3 committed 路径）：正文已外化、不可重试时，随最终回复
// 送达用户的诚实说明。格式与 chat.js HARNESS_NOTE_RE 的（系统核实：…）同族，
// 由渲染侧剥离规则一并挡在角色上下文之外（见 chat.js forContext）。
function streamPartialNote() {
  return '（系统注记：本轮回复在网络传输中途断开，以上内容可能不完整。）';
}

module.exports = { notExecutedReceipt, compactedHistoryNote, streamPartialNote };
