// 工具轮滚动压缩（v0.5「平方税」消除）：agent 循环里 toolTurns 全量累积、每轮整包重发，
// 单次 read_file 回填可达 32K 字符、write_file 参数内嵌整个文件内容——同一份工具输出被
// 重复计费最多 N 次（实测单 run input 冲到 99.5 万 token），且陈旧工具输出长期霸占上下文
// 挤压推理质量。本模块按 est-token 预算滚动压缩「最老」的工具轮：
//   · role=tool 消息正文 → 一行机械回执（工具名/路径/原字符数；声明该调用已真实执行）；
//   · 旧 assistant 的 tool_calls.arguments（内嵌文件内容）→ 截断保留前 400 字符；
//   · 旧 assistant 的 reasoning_content → '-' 占位（DeepSeek 思考模式只校验存在性，
//     与 loop.reasoningPassback 的 SYNTHETIC_REASONING_TEXT 同一安全模式）。
// 三条硬约束：
//   1. 压缩由计数器触发、由代码执行——禁止把工具结果送进 LLM 求摘要（摘要有损，
//      回执是机械事实；「我的生成物获得与原始证据同等地位」是已知漂移源，不写进管线）；
//   2. 最新一轮的 assistant+tool 消息不压缩（watermark 保护——模型正基于它们工作）；
//   3. 回执必须声明「已执行成功」——被压缩的是正文，不是执行事实。
const { tokenEstimate } = require('../token-est');

const ARGS_KEEP_CHARS = 400;

function estTurns(turns) {
  let total = 0;
  for (const m of turns) {
    total += tokenEstimate(m.content || '');
    if (m.reasoning_content) total += tokenEstimate(m.reasoning_content);
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) total += tokenEstimate(tc.function && tc.function.arguments);
    }
  }
  return total;
}

// turns：loop 的 toolTurns（原对象就地改写）
// opts.budget：est-token 预算；opts.watermark：该下标起的消息属最新一轮，不压缩；
// opts.isReceipt(m)/markReceipt(m)：已压缩标记（WeakSet，避免污染发往 API 的消息体）；
// opts.metaOf(m)：tool 消息的 {tool, path, chars} 元数据（WeakMap，同样不进消息体）
function compactTurns(turns, { budget, watermark = turns.length, isReceipt, markReceipt, metaOf }) {
  let total = estTurns(turns);
  if (total <= budget) return 0;
  let n = 0;
  for (let i = 0; i < Math.min(watermark, turns.length) && total > budget; i++) {
    const m = turns[i];
    if (m.role === 'tool' && !isReceipt(m)) {
      const meta = (metaOf && metaOf(m)) || {};
      const before = tokenEstimate(m.content || '');
      m.content = `[已压缩] ${meta.tool || 'tool'}${meta.path ? ' ' + meta.path : ''}｜原 ${meta.chars || String(m.content || '').length} 字符（该调用已真实执行）｜需要时重新调用查看`;
      if (markReceipt) markReceipt(m);
      total += tokenEstimate(m.content) - before;
      n++;
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc.function;
        const args = fn && fn.arguments;
        if (typeof args === 'string' && args.length > ARGS_KEEP_CHARS) {
          fn.arguments = args.slice(0, ARGS_KEEP_CHARS) + '…[参数已压缩]';
          total += tokenEstimate(fn.arguments) - tokenEstimate(args);
          n++;
        }
      }
      const r = m.reasoning_content;
      if (typeof r === 'string' && r.trim() && r !== '-') {
        m.reasoning_content = '-';
        total += tokenEstimate(m.reasoning_content) - tokenEstimate(r);
        n++;
      }
    }
  }
  return n;
}

module.exports = { compactTurns, estTurns, ARGS_KEEP_CHARS };
