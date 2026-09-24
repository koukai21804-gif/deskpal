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

console.log(`\n========== 记忆管理回归结果：${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);
