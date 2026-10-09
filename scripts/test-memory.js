// ★v0.3.2 回归测试：长期记忆管理服务（/deep memory forcing 面板数据源）
// 覆盖：斜杠命令识别、id 归一化、查看排序、添加校验/淘汰、删除、角色无感知不变量。
// 用法：node scripts/test-memory.js（纯 Node，无 electron 依赖）
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVC = p => path.join(ROOT, 'src/main/services', p);

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

const store = require(SVC('store'));
store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-memory-test-')));
const memory = require(SVC('memory'));

// ============ 1. 斜杠命令识别 ============
section('isMemoryCommand：命中与不命中');
{
  ok(memory.isMemoryCommand('/deep memory forcing') === true, '标准形式命中');
  ok(memory.isMemoryCommand('/ deep memory forcing') === true, '斜杠后带空格命中');
  ok(memory.isMemoryCommand('  /Deep Memory Forcing  ') === true, '大小写/首尾空白命中');
  ok(memory.isMemoryCommand('/deep  memory   forcing') === true, '词间多空格命中');
  ok(memory.isMemoryCommand('/deep memory forcing now') === false, '多余词不命中');
  ok(memory.isMemoryCommand('deep memory forcing') === false, '缺斜杠不命中');
  ok(memory.isMemoryCommand('/deep memory') === false, '缺词不命中');
  ok(memory.isMemoryCommand('/帮我记忆') === false, '普通消息不命中');
  ok(memory.isMemoryCommand('') === false, '空串不命中');
}

// ============ 2. listMemories：id 归一化 + 排序 ============
section('listMemories：旧条目补 id（持久化）+ 按重要性排序');
{
  store.replace('memory/roleplay', {
    items: [
      { type: 'fact', content: '旧A', importance: 2, createdAt: '2026-09-20T10:00:00.000Z' },   // 无 id
      { type: 'preference', content: '旧B', importance: 5, createdAt: '2026-09-21T10:00:00.000Z' }, // 无 id
    ],
  });
  const list1 = memory.listMemories();
  eq(list1.length, 2, '两条记忆');
  ok(list1.every(it => it.id && it.id.startsWith('mem_')), '旧条目补齐 id');
  eq(list1[0].content, '旧B', '重要性高的排前');
  const list2 = memory.listMemories();
  eq(list2.map(it => it.id), list1.map(it => it.id), 'id 归一化已持久化（再次列出 id 不变）');
}

// ============ 3. addMemory：校验 + 淘汰 ============
section('addMemory：校验与归一化');
{
  let threw = '';
  try { memory.addMemory({ content: '   ' }); } catch (e) { threw = e.userMsg || e.message; }
  ok(threw.includes('不能为空'), '空内容抛错');
  const it = memory.addMemory({ type: 'mystery', content: '  前辈喜欢深夜写代码  ', importance: 99 });
  ok(it.type === 'fact', '未知类型归 fact');
  eq(it.importance, 5, 'importance 截到 5');
  eq(it.content, '前辈喜欢深夜写代码', '内容 trim');
  ok(it.id.startsWith('mem_') && !!it.createdAt, '带 id 与 createdAt');
  const it2 = memory.addMemory({ content: 'x'.repeat(80) });
  eq(it2.content.length, 60, '内容截到 60');
  eq(it2.importance, 2, 'importance 缺省 2');
}

section('addMemory：上限 50，低重要性旧条目先淘汰');
{
  const old = [];
  for (let i = 0; i < 50; i++) old.push({ id: 'mem_old' + i, type: 'fact', content: `旧${i}`, importance: 1, createdAt: `2026-09-20T00:00:${String(i % 60).padStart(2, '0')}` });
  store.replace('memory/roleplay', { items: old });
  memory.addMemory({ content: '新增的高重要性记忆', importance: 5 });
  const list = memory.listMemories();
  eq(list.length, 50, '淘汰后仍 50');
  ok(list.some(it => it.content === '新增的高重要性记忆'), '新增保留');
  ok(!list.some(it => it.id === 'mem_old0'), '最早最低重要性被淘汰');
}

// ============ 4. deleteMemory ============
section('deleteMemory：按 id 删除');
{
  const it = memory.addMemory({ content: '待删除的记忆', importance: 4 });
  eq(memory.deleteMemory(it.id), true, '删除返回 true');
  ok(!memory.listMemories().some(x => x.id === it.id), '列表中已消失');
  eq(memory.deleteMemory('mem_notexist'), false, '未知 id 返回 false');
}

// ============ 5. 角色无感知不变量 ============
section('无感知不变量：记忆管理不触碰聊天历史与提取计数');
{
  store.replace('chats/roleplay', { messages: [{ role: 'user', content: ' existing ' }], userCountSince: 7, lastExtractAt: '2026-09-22T00:00:00.000Z' });
  memory.listMemories();
  memory.addMemory({ content: '管理动作的记忆', importance: 3 });
  const it = memory.listMemories().find(x => x.content === '管理动作的记忆');
  memory.deleteMemory(it.id);
  const chatData = store.get('chats/roleplay');
  eq(chatData.messages.length, 1, '聊天历史未被修改');
  eq(chatData.userCountSince, 7, '提取计数未被修改');
  eq(chatData.lastExtractAt, '2026-09-22T00:00:00.000Z', '上次提取时间未被修改');
}

// ============ 6. scope 三态体系（v0.5：core/working/ephemeral + 归档 + 合并） ============
section('scope：core 字数预算与满载降级（不静默丢）');
{
  store.replace('memory/roleplay', { items: [], archive: [] });
  // 20 条 × 恰好 50 字 = 1000 字（CORE_CHAR_BUDGET）填满 core
  for (let i = 0; i < 20; i++) {
    const it = memory.addMemory({ content: ('core身份' + String(i).padStart(2, '0')).padEnd(50, '甲'), scope: 'core' });
    ok2(it.scope === 'core', `第 ${i + 1} 条 core 写入成功`);
  }
  eq2(memory.coreUsage().used, 1000, 'core 占用恰好 1000 字');
  const over = memory.addMemory({ content: '超预算的身份级认知内容 Exactly50字符宽度的样例数据ABCD'.padEnd(50, '乙'), scope: 'core' });
  eq2(over.scope, 'working', 'core 超字数预算 → 降级为 working');
  ok2(over.note && over.note.includes('core 已满'), '降级在回执注明（不静默）');
  ok2(memory.listMemories().filter(i => i.scope === 'core').length === 20, 'core 仍 20 条');
  // setScope 面板改层：core 满时再升一条 → 拒绝并说明
  const w = memory.addMemory({ content: '一条普通工作记忆' });
  let threw = '';
  try { memory.setScope(w.id, 'core'); } catch (e) { threw = e.message; }
  ok2(threw.includes('core 已满'), 'core 满载时 setScope 升层被拒绝并说明');
  eq2(memory.setScope(w.id, 'ephemeral').scope, 'ephemeral', 'setScope 降层成功');
}

section('scope：ephemeral 过期归档 / working 溢出归档 / core 永不淘汰');
{
  store.replace('memory/roleplay', { items: [
    { id: 'mem_e1', type: 'event', content: '过期事件', scope: 'ephemeral', ttlDays: 1, createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString() },
    { id: 'mem_c1', type: 'fact', content: '身份认知', scope: 'core', createdAt: '2026-09-01T00:00:00' },
  ], archive: [] });
  memory.addMemory({ content: '触发一次 sweep 的写入' });
  ok2(!memory.listMemories().some(i => i.id === 'mem_e1'), '过期 ephemeral 移出库');
  ok2(memory.listArchive().some(a => a.id === 'mem_e1' && a.reason === 'ttl'), '过期进归档（reason=ttl）');
  ok2(memory.listMemories().some(i => i.id === 'mem_c1'), 'core 不受过期清扫影响');
  // 溢出：core 25 + working 30 = 55 > 50 → 淘汰最旧 working、core 不动、进归档；
  // 另带一条已过期 ephemeral（首次 sweep 即按 ttl 入档，供下方还原测试用）
  store.replace('memory/roleplay', { items: [
    ...Array.from({ length: 25 }, (_, i) => ({ id: 'mem_c' + i, type: 'fact', content: 'core' + i, scope: 'core', createdAt: '2026-09-01T00:00:00' })),
    ...Array.from({ length: 30 }, (_, i) => ({ id: 'mem_w' + i, type: 'fact', content: 'w' + i, scope: 'working', createdAt: new Date(Date.now() - (31 - i) * 3600 * 1000).toISOString() })),
    { id: 'mem_e2', type: 'event', content: '过期事件二号', scope: 'ephemeral', ttlDays: 1, createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString() },
  ], archive: [] });
  memory.addMemory({ content: '第 56 条记忆' });
  const its = memory.listMemories();
  eq2(its.length, 50, '总数回到 50');
  eq2(its.filter(i => i.scope === 'core').length, 25, 'core 25 条全保留（永不淘汰）');
  ok2(!its.some(i => i.id === 'mem_w0'), '最旧 working 被淘汰');
  ok2(memory.listArchive().some(a => a.id === 'mem_w0' && a.reason === 'overflow'), '溢出淘汰进归档（reason=overflow）');
  // 归档还原（恢复=重新确认）：满库时直接恢复最旧条目也能存活——顶掉的是另一条最旧，回执如实报告
  const r = memory.restoreArchive('mem_w0');
  ok2(r.content === 'w0', '归档条目可恢复');
  ok2(r.evicted.length >= 1, `满库恢复时回执报告为腾位又归档了 ${r.evicted.length} 条`);
  const items2 = memory.listMemories();
  ok2(items2.some(i => i.id === 'mem_w0'), '恢复的最旧条目存活（不再被 sweep 立即再淘汰）');
  ok2(!items2.some(i => i.id === 'mem_w6'), '被顶掉的是另一条最旧 working（mem_w6）');
  eq2(items2.length, 50, '条数守恒（仍 50）');
  ok2(memory.listArchive().some(a => a.id === 'mem_w6' && a.reason === 'overflow'), '被顶条目进归档留痕');
  ok2(!memory.listArchive().some(a => a.id === 'mem_w0'), '恢复后从归档列表消失');
  // 恢复计入注入顺位：restoredAt 使其成为 working 最新 → 进最近 8
  ok2(memory.injectable().working.some(i => i.id === 'mem_w0'), '恢复条目进入 working 注入窗口');
  // 过期限时事件恢复 → 自动转 working（否则下次写入即被再次归档），回执注明
  const r2 = memory.restoreArchive('mem_e2');
  ok2(r2.scope === 'working', '过期限时事件恢复后自动转 working');
  ok2(r2.note && r2.note.includes('working'), '转换在回执注明');
  ok2(!('ttlDays' in r2), 'ttlDays 已清除');
  ok2(memory.listMemories().some(i => i.id === 'mem_e2' && i.scope === 'working'), '过期事件以 working 身份回库');
}

section('合并：同文 add 合并 / mergeExtracted 原位更新 / core 合并保护（自动提取禁写 core）');
{
  store.replace('memory/roleplay', { items: [], archive: [] });
  const m1 = memory.addMemory({ content: '前辈零代码', importance: 5 });
  const m2 = memory.addMemory({ content: '前辈零代码', importance: 5 });
  eq2(m2.id, m1.id, '同文写入=合并同一 id（不另开条目）');
  ok2(m2.merged === true, '回执带 merged 标');
  eq2(store.get('memory/roleplay').items.length, 1, '库内仍 1 条');
  const r = memory.mergeExtracted([{ type: 'fact', content: '前辈零代码，以验收口径协作', importance: 5, mergeInto: m1.id }]);
  eq2(r.merged, 1, 'mergeInto 命中 → 计合并');
  eq2(r.added, 0, '无新增');
  eq2(memory.listMemories().find(x => x.id === m1.id).content, '前辈零代码，以验收口径协作', '原位更新为合并后完整描述');
  // mergeInto 指向 core → 拒改 core，按新 working 条目落库（信息不丢、身份层不动）
  const c1 = memory.addMemory({ content: '身份级认知条目', scope: 'core' });
  const r2 = memory.mergeExtracted([{ type: 'fact', content: '自动提取想改写 core', importance: 3, mergeInto: c1.id }]);
  eq2(r2.added, 1, '指向 core 的 mergeInto 降为新条目');
  eq2(memory.listMemories().find(x => x.id === c1.id).content, '身份级认知条目', 'core 内容未被自动提取改动');
  // 自动提取产出的新条目永远是 working
  const r3 = memory.mergeExtracted([{ type: 'fact', content: '自动提取的新事实', importance: 3, scope: 'core' }]);
  eq2(memory.listMemories().find(x => x.content === '自动提取的新事实').scope, 'working', 'mergeExtracted 强制 working（scope 入参被忽略）');
}

section('截断可见化：超长内容带省略号（P0-3）');
{
  store.replace('memory/roleplay', { items: [], archive: [] });
  const it = memory.addMemory({ content: '某条超过六十个字符上限的超长记忆内容'.padEnd(80, '长') });
  eq2(it.content.length, 60, '截到 60');
  ok2(it.content.endsWith('…'), '截断带省略号（可检）');
}

function ok2(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function eq2(a, b, name) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  ok2(ja === jb, `${name}${ja === jb ? '' : `（got ${String(ja).slice(0, 60)}, want ${String(jb).slice(0, 60)}）`}`);
}

console.log(`\n========== 记忆管理回归结果：${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
