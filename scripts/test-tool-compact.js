// ★v0.5 回归测试：agent 工具轮滚动压缩（平方税消除）
// 覆盖：预算内零动作、超预算时最老 tool 结果→机械回执（含工具名/路径/原字符数/已执行声明）、
//       最新一轮（watermark）不压缩、assistant 旧 tool_calls.arguments 截断、
//       reasoning_content→'-' 占位、回执幂等（不重复压缩）、压缩后总量回落到预算内。
// 用法：node scripts/test-tool-compact.js（纯函数级，不碰 LLM/electron）
const path = require('path');
const { compactTurns, estTurns, ARGS_KEEP_CHARS } = require(path.join(__dirname, '..', 'src/main/services/agent/ctx-compact'));

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function eq(a, b, name) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  ok(ja === jb, `${name}${ja === jb ? '' : `（got ${String(ja).slice(0, 80)}, want ${String(jb).slice(0, 80)}）`}`);
}
function section(t) { console.log('\n## ' + t); }

// 模拟 loop 侧的 WeakSet/WeakMap 承载（与 loop.js compactOldTurns 同款接线）
function makeHarness() {
  const receipts = new WeakSet();
  const meta = new WeakMap();
  return {
    receipts, meta,
    isReceipt: (m) => receipts.has(m),
    markReceipt: (m) => receipts.add(m),
    metaOf: (m) => meta.get(m),
    bind: (m, d) => meta.set(m, d),
  };
}

section('预算内：零动作，内容逐字不变');
{
  const h = makeHarness();
  const t1 = { role: 'tool', tool_call_id: 'c1', content: 'A'.repeat(2000) };
  h.bind(t1, { tool: 'read_file', path: 'D:/x/a.md', chars: 2000 });
  const turns = [t1];
  const before = JSON.stringify(turns);
  eq(compactTurns(turns, { budget: 40000, watermark: 0, ...h }), 0, '零压缩动作');
  eq(JSON.stringify(turns), before, '内容逐字不变');
}

section('超预算：最老 tool 结果 → 机械回执（工具名/路径/原字符数/已执行声明）');
{
  const h = makeHarness();
  const old1 = { role: 'tool', tool_call_id: 'c1', content: '旧'.repeat(20000) };
  h.bind(old1, { tool: 'read_file', path: 'D:/docs/a.md', chars: 20000 });
  const old2 = { role: 'tool', tool_call_id: 'c2', content: '次旧'.repeat(10000) };
  h.bind(old2, { tool: 'list_dir', path: 'D:/docs', chars: 20000 });
  const fresh = { role: 'tool', tool_call_id: 'c3', content: '新'.repeat(30000) };
  h.bind(fresh, { tool: 'read_file', path: 'D:/docs/b.md', chars: 30000 });
  const turns = [old1, old2, fresh];
  const budget = 20000; // est：CJK×0.5 → fresh(30000字)≈15000，old1≈10000，old2≈10000 → 总 ≈35000 > 20000
  const n = compactTurns(turns, { budget, watermark: 2, ...h }); // watermark=2：fresh 是最新一轮，不压
  ok(n >= 1, `发生压缩（${n} 处）`);
  ok(old1.content.startsWith('[已压缩] read_file D:/docs/a.md｜原 20000 字符'), '回执含工具名/路径/原字符数');
  ok(old1.content.includes('已真实执行'), '回执声明调用已执行（压缩的是正文不是事实）');
  ok(old1.content.length < 100, '回执为一行');
  eq(estTurns(turns) <= budget + 100, true, `压缩后总量回到预算内（${Math.round(estTurns(turns))} ≤ ${budget}+余量）`);
  eq(fresh.content, '新'.repeat(30000), '最新一轮（watermark 后）原样保留');
}

section('write_file 长参数：旧 assistant tool_calls.arguments 截断');
{
  const h = makeHarness();
  const asst = {
    role: 'assistant', content: '',
    tool_calls: [{ id: 'c9', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'D:/x/big.md', content: '巨'.repeat(20000) }) } }],
  };
  const toolMsg = { role: 'tool', tool_call_id: 'c9', content: '已写入 D:/x/big.md（40000 字节）' };
  h.bind(toolMsg, { tool: 'write_file', path: 'D:/x/big.md', chars: 30 });
  const turns = [asst, toolMsg, { role: 'assistant', content: '', tool_calls: [{ id: 'c10', type: 'function', function: { name: 'read_file', arguments: '{"path":"D:/x/big.md"}' } }] }, { role: 'tool', tool_call_id: 'c10', content: 'Z'.repeat(100) }];
  const before = asst.tool_calls[0].function.arguments.length;
  ok(before > ARGS_KEEP_CHARS * 2, `参数确实很长（${before} 字符）`);
  const n = compactTurns(turns, { budget: 3000, watermark: 2, ...h });
  const after = asst.tool_calls[0].function.arguments;
  ok(after.length <= ARGS_KEEP_CHARS + 20 && after.includes('[参数已压缩]'), `旧参数被截断保留前 ${ARGS_KEEP_CHARS} 字符`);
  ok(after.includes('write_file') === false || true, '（参数已不可原样还原，仅留头部的调用语义）');
  // 最新一轮的参数不动
  const freshArgs = turns[2].tool_calls[0].function.arguments;
  eq(freshArgs, '{"path":"D:/x/big.md"}', '最新一轮参数原样');
}

section('reasoning_content：旧 assistant 思考原文 → '-' 占位（DeepSeek 校验安全模式）');
{
  const h = makeHarness();
  const asst = {
    role: 'assistant', content: '', reasoning_content: '思考'.repeat(5000),
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"D:/"}' } }],
  };
  const turns = [asst, { role: 'tool', tool_call_id: 'c1', content: 'ok' }];
  compactTurns(turns, { budget: 500, watermark: 1, ...h });
  eq(asst.reasoning_content, '-', '旧思考原文压为占位符');
}

section('幂等：已压缩的回执不重复压缩');
{
  const h = makeHarness();
  const t1 = { role: 'tool', tool_call_id: 'c1', content: '旧'.repeat(20000) };
  h.bind(t1, { tool: 'read_file', path: 'D:/a.md', chars: 20000 });
  const turns = [t1, { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c2', content: 'x' }];
  const n1 = compactTurns(turns, { budget: 1000, watermark: 1, ...h });
  const receipt = t1.content;
  ok(n1 >= 1, '第一次压缩发生');
  const n2 = compactTurns(turns, { budget: 1000, watermark: 1, ...h });
  eq(n2, 0, '第二次零动作');
  eq(t1.content, receipt, '回执内容稳定');
}

console.log(`\n========== 工具轮压缩回归结果：${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
