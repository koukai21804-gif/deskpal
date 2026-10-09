// ★v0.5 回归测试：多会话架构（主对话=角色扮演常驻 + 专项会话=特定任务/场景）
// 覆盖：legacy 单线程迁移（含备份文件）、会话隔离（历史/上下文/计数互不串）、
//       切换前固化（flushMemory+tick 作用于旧会话）、主对话不可删、会话卡注入、
//       MAX_KEEP 每会话独立。
// 用法：node scripts/test-sessions.js（纯 Node，LLM 打桩）
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
  ok(ja === jb, `${name}${ja === jb ? '' : `（got ${String(ja).slice(0, 90)}, want ${String(jb).slice(0, 90)}）`}`);
}
function section(t) { console.log('\n## ' + t); }

(async function main() {

const store = require(SVC('store'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-sessions-test-'));
store.init(dataDir);
store.flushAll();

const chat = require(SVC('chat'));
const sessions = require(SVC('sessions'));
const prompts = require(SVC('prompts'));
const llm = require(SVC('llm'));

// ============ 1. legacy 迁移 ============
section('迁移：单线程历史 → sessions[0] 主对话（含备份文件）');
{
  store.replace('chats/roleplay', { messages: [], userCountSince: 0, lastExtractAt: null }); // 清干净
  store.flushAll();
  const legacy = {
    messages: [
      { id: 'm1', role: 'user', content: '旧会话第一条', at: '2026-09-28T10:00:00' },
      { id: 'm2', role: 'assistant', content: '旧会话第二条', at: '2026-09-28T10:01:00' },
    ],
    userCountSince: 4, lastExtractAt: '2026-10-01T00:00:00',
  };
  store.replace('chats/roleplay', legacy);
  store.flushAll(); // 落盘成旧形状文件，迁移才有原件可备份
  const hist = chat.getHistory('roleplay'); // 触发 ensure() 迁移
  eq(hist.length, 2, '旧消息全部进入主对话会话');
  const info = chat.listSessions();
  eq(info.sessions.length, 1, '只有一个会话（主对话）');
  eq(info.sessions[0].kind, 'main', '迁移会话 kind=main');
  eq(info.sessions[0].name, '主对话', '主对话默认名');
  eq(info.sessions[0].userCountSince, 4, '未提取计数随会话迁移');
  eq(info.activeSessionId, sessions.MAIN_ID, '活跃会话=主对话');
  const baks = fs.readdirSync(path.join(dataDir, 'chats')).filter(f => f.includes('pre-sessions'));
  eq(baks.length, 1, `迁移前留了备份文件（${baks[0] || '?'}）`);
  // 幂等：再次触发不重复迁移
  chat.getHistory('roleplay');
  eq(chat.listSessions().sessions.length, 1, '迁移幂等（不重复建会话）');
}

// ============ 2. 会话隔离：历史/计数/上下文 ============
section('隔离：getHistory/saveHistory/bumpUserCount 只作用于活跃会话');
{
  const main = chat.getHistory('roleplay');
  main.push({ id: 'mm1', role: 'user', content: '主对话消息', at: '2026-10-03T10:00:00' });
  chat.saveHistory('roleplay', main);
  chat.bumpUserCount('roleplay'); // 主对话 +1

  const task = await chat.newSession({ name: '资料整理', goal: '整理卡牌数据' });
  ok(task.kind === 'task', '新会话 kind=task');
  eq(chat.getHistory('roleplay').length, 0, '新会话历史为空（不携带主对话消息）');
  const th = chat.getHistory('roleplay');
  th.push({ id: 'tt1', role: 'user', content: '专项会话消息A', at: '2026-10-03T11:00:00' });
  chat.saveHistory('roleplay', th);
  chat.bumpUserCount('roleplay');

  const info = chat.listSessions();
  eq(info.sessions.length, 2, '两个会话');
  const byCount = Object.fromEntries(info.sessions.map(s => [s.name, s.userCountSince]));
  // 主对话的 1 条未提取消息在「新建会话前的固化」中被 flush（设计行为：切走先固化）→ 归零
  eq(byCount['主对话'], 0, '主对话计数已被切换前固化清零（flush 生效）');
  eq(byCount['资料整理'], 1, '专项会话计数 1（只计自己）');

  // buildMessages 只含当前（专项）会话的消息
  const msgs = chat.buildMessages('roleplay', chat.getHistory('roleplay'));
  ok(msgs.slice(1).every(m => !String(m.content).includes('主对话消息')), '主对话消息不进专项会话上下文');
  ok(msgs.some(m => String(m.content).includes('专项会话消息A')), '专项会话自己的消息在上下文');

  // system prompt 含会话卡（专项会话名与主题）
  const sys = msgs[0].content;
  ok(sys.includes('【当前会话】专项会话「资料整理」'), '会话卡注入会话名');
  ok(sys.includes('主题：整理卡牌数据'), '会话卡注入主题');
  ok(sys.includes('不共享对话记录'), '会话卡声明跨会话边界');
}

// ============ 3. 切换前固化 ============
section('切换前固化：flushMemory 先跑在旧会话上，再切 active');
{
  llm.genericCompletion = async (msgs) => {
    // 断言提取器看到的是「旧会话」的消息（切换尚未发生）
    ok(String(msgs[0].content).includes('切换前的遗留信息'), '提取发生在切换前、读的是旧会话消息');
    return JSON.stringify([{ type: 'fact', content: '切换前固化的记忆', importance: 4 }]);
  };
  const cur = chat.getHistory('roleplay');
  cur.push({ id: 'tt2', role: 'user', content: '切换前的遗留信息', at: '2026-10-03T12:00:00' });
  chat.saveHistory('roleplay', cur);
  chat.bumpUserCount('roleplay'); // ≥1 未提取 → 切换时 force 提取
  const before = chat.listSessions().activeSessionId;
  await chat.switchSession(sessions.MAIN_ID);
  const after = chat.listSessions().activeSessionId;
  ok(before !== after, '活跃会话已切换');
  const mainSess = sessions.find(sessions.MAIN_ID);
  eq(mainSess.userCountSince, 0, '旧会话（专项）计数已清零（flush 生效）');
  // 主对话视角：看不到专项会话的消息
  ok(!chat.getHistory('roleplay').some(m => m.id === 'tt2'), '切回主对话后看不到专项会话消息');
  // system 会话卡回到主对话形态
  const sys = prompts.roleplaySystem();
  ok(sys.includes('【当前会话】主对话'), '主对话会话卡');
  ok(!sys.includes('资料整理'), '专项会话主题不再出现在主对话 system');
}

// ============ 4. 删除/重命名守卫 ============
section('删除与重命名：主对话不可删；删活跃会话回落主对话');
{
  let threw = '';
  try { await chat.deleteSession(sessions.MAIN_ID); } catch (e) { threw = e.message; }
  ok(threw.includes('不能删除'), '主对话删除被拒绝');

  const t2 = await chat.newSession({ name: '临时任务' });
  chat.renameSession(t2.id, { name: '改名后的任务', goal: '新主题' });
  const renamed = sessions.find(t2.id);
  eq(renamed.name, '改名后的任务', '重命名生效');
  eq(renamed.goal, '新主题', '主题可更新');

  await chat.deleteSession(t2.id);
  const info = chat.listSessions();
  ok(!info.sessions.some(s => s.id === t2.id), '专项会话已删除');
  eq(info.activeSessionId, sessions.MAIN_ID, '删除活跃会话后回落主对话');
  eq(info.sessions.length, 2, '剩余：主对话 + 资料整理');
}

// ============ 5. MAX_KEEP 每会话独立 ============
section('MAX_KEEP=200 按会话独立裁剪');
{
  const flood = Array.from({ length: 250 }, (_, i) => ({ id: 'f' + i, role: 'user', content: 'c' + i }));
  const t3 = await chat.newSession({ name: '洪泛测试' });
  chat.saveHistory('roleplay', flood);
  eq(chat.getHistory('roleplay').length, 200, '当前会话裁到 200');
  await chat.switchSession(sessions.MAIN_ID);
  ok(chat.getHistory('roleplay').length < 200, '主对话历史不受其他会话洪泛影响');
}

console.log(`\n========== 多会话回归结果：${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);

})().catch(e => { console.error('测试脚本异常：', e && (e.stack || e.message)); process.exit(2); });
