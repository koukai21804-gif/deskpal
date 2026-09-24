// ★v0.3 回归测试：角色扮演上下文组装与长期记忆（防 OOC 机制）
// 覆盖：buildMessages 窗口(20)/token 砍半/标签剥离、saveHistory 存储上限(200)、
//       roleplaySystem 人设+长期记忆注入(top10 按重要性)、memoryTick 提取/兜底/淘汰。
// 用法：node scripts/test-context.js（纯 Node，LLM 与 electron 依赖全部打桩）
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

(async function main() {

// ---- 环境：隔离 userData ----
const store = require(SVC('store'));
store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-context-test-')));

const chat = require(SVC('chat'));
const prompts = require(SVC('prompts'));
const llm = require(SVC('llm'));
const dayjs = require('dayjs');

// ============ 1. buildMessages：窗口与结构 ============
section('buildMessages：system 在首位');
{
  const out = chat.buildMessages('roleplay', [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '嗯。' },
  ]);
  eq(out.length, 3, 'system + 2 条历史');
  eq(out[0].role, 'system', '首条为 system');
  ok(out[0].content.includes('缇托'), 'system 含人设（默认宠物）');
  ok(out[0].content.includes('速问') === false, 'roleplay 用 roleplaySystem');
  eq(out.slice(1).map(m => m.role), ['user', 'assistant'], '历史角色与顺序保留');
}

section('buildMessages：仅注入最近 20 条（CTX_MSGS），更早历史不进上下文');
{
  const history = [];
  for (let i = 1; i <= 35; i++) history.push({ role: i % 2 ? 'user' : 'assistant', content: `msg${String(i).padStart(2, '0')}` });
  const out = chat.buildMessages('roleplay', history);
  const msgs = out.slice(1);
  eq(msgs.length, 20, '只取最近 20 条');
  eq(msgs[0].content, 'msg16', '窗口起点=第 16 条（msg01–msg15 被丢弃）');
  eq(msgs[msgs.length - 1].content, 'msg35', '窗口终点=最后一条');
  ok(!out[0].content.includes('msg01'), '最早的消息不出现在任何位置');
}

section('buildMessages：token 超限砍半（保窗内最新消息）');
{
  // 每条约 2600 est-token（5200 个 CJK 字符 ×0.5），10 条必超 6400
  const big = '超'.repeat(5200);
  const history = [];
  for (let i = 1; i <= 10; i++) history.push({ role: i % 2 ? 'user' : 'assistant', content: big + `（#${i}）` });
  const out = chat.buildMessages('roleplay', history);
  const msgs = out.slice(1);
  ok(msgs.length < 10, `砍半后条数 <10（实际 ${msgs.length}）`);
  ok(msgs.length >= 2, `保底仍保留最新消息（实际 ${msgs.length}）`);
  ok(msgs[msgs.length - 1].content.includes('#10'), '最新一条必在');
  ok(msgs[0].content.includes('#10') === false || msgs.length === 1, '最早的消息先被砍');
}

section('buildMessages：历史消息中的情绪/节拍/日程标签已剥离');
{
  const history = [
    { role: 'user', content: '明天三点提醒我[情绪:平常]' },
    { role: 'assistant', content: '好呀[开心]！定好了。[日程:{"title":"x","kind":"event","start":"2026-09-24 15:00"}]\n[情绪:开心]' },
  ];
  const out = chat.buildMessages('roleplay', history);
  const msgs = out.slice(1); // 只查历史消息（system 里的标签是输出协议说明，本就合法）
  ok(!msgs.some(m => (m.content || '').includes('[情绪')), '无 [情绪:] 泄漏');
  ok(!msgs.some(m => (m.content || '').includes('[日程')), '无 [日程:] 泄漏');
  ok(!msgs.some(m => /\[(开心|思考|惊讶|愤怒|悲伤|平常)\]/.test(m.content || '')), '无节拍短标签泄漏');
  ok(msgs[1].content.includes('定好了'), '正文保留');
}

section('buildMessages：quick 标签用 quickSystem（无人设记忆/任务段）');
{
  const out = chat.buildMessages('quick', []);
  ok(out[0].content.includes('速问速答'), 'quick 用速问速答 system');
  ok(!out[0].content.includes('任务执行模式'), 'quick 无 agent 段');
}

// ============ 2. saveHistory：存储上限（存档≠上下文） ============
section('saveHistory：存档最多 200 条（MAX_KEEP），只影响存储不影响本轮上下文');
{
  const msgs = [];
  for (let i = 1; i <= 250; i++) msgs.push({ id: 'm' + i, role: 'user', content: 'c' + i });
  chat.saveHistory('roleplay', msgs);
  const kept = chat.getHistory('roleplay');
  eq(kept.length, 200, '超存裁到 200');
  eq(kept[0].content, 'c51', '保留最新的 200 条（旧的头 50 条淘汰）');
}

// ============ 3. roleplaySystem：人设常驻 + 长期记忆注入 ============
section('roleplaySystem：人设与禁忌每轮全量注入（防 OOC 基座）');
{
  const sys = prompts.roleplaySystem();
  ok(sys.includes('角色设定') && sys.includes('禁忌'), '人设区块存在');
  ok(sys.includes('不要跳出角色'), '保持角色硬规则存在');
  ok(!sys.includes('【长期记忆'), '无记忆时无长期记忆区块');
}

section('roleplaySystem：长期记忆 top10 按重要性注入（伪史），超出者不注入');
{
  const items = [];
  for (let i = 1; i <= 12; i++) items.push({ type: 'fact', content: `记忆条目${i}号`, importance: i, createdAt: dayjs().format() });
  store.replace('memory/roleplay', { items });
  const sys = prompts.roleplaySystem();
  ok(sys.includes('【长期记忆（之前对话中的重要信息）】'), '长期记忆区块出现');
  for (let i = 12; i >= 3; i--) ok(sys.includes(`记忆条目${i}号`), `importance=${i}（top10）注入`);
  ok(!sys.includes('记忆条目2号'), 'importance=2（第 11 名）不注入');
  ok(!sys.includes('记忆条目1号'), 'importance=1（第 12 名）不注入');
  store.replace('memory/roleplay', { items: [] }); // 还原
}

// ============ 4. memoryTick：提取链路 ============
section('memoryTick：距上次提取 <6 条用户消息 → 不调用 LLM');
{
  let llmCalled = 0;
  llm.genericCompletion = async () => { llmCalled++; return '[]'; };
  store.replace('chats/roleplay', { messages: [{ role: 'user', content: 'hi' }], userCountSince: 3, lastExtractAt: null });
  await chat.memoryTick();
  eq(llmCalled, 0, '未达阈值不调 LLM');
  eq(store.get('memory/roleplay').items.length, 0, '无记忆写入');
}

section('memoryTick：≥6 条 → LLM 提取（重要性≥2 过滤、未知类型归 fact、计数清零）');
{
  let got = null;
  llm.genericCompletion = async (msgs) => {
    got = msgs;
    return JSON.stringify([
      { type: 'fact', content: '用户叫小明', importance: 5 },
      { type: 'preference', content: '喜欢天文', importance: 4 },
      { type: 'fact', content: '太琐碎应被过滤', importance: 1 },
      { type: 'mystery', content: '未知类型归 fact', importance: 3 },
    ]);
  };
  const msgs = [];
  for (let i = 0; i < 12; i++) msgs.push({ role: 'user', content: `用户消息${i}` }, { role: 'assistant', content: '好' });
  store.replace('chats/roleplay', { messages: msgs, userCountSince: 7, lastExtractAt: null });
  await chat.memoryTick();
  ok(!!got, 'LLM 被调用');
  ok(got[0].content.includes('对话记忆提取器'), '用提取器 prompt');
  ok(got[0].content.includes('用户消息11'), '取最近 20 条作输入');
  const items = store.get('memory/roleplay').items;
  eq(items.length, 3, 'importance=1 被过滤，余 3 条');
  ok(items.some(i => i.content === '用户叫小明' && i.importance === 5 && i.type === 'fact'), '高重要性事实入库');
  ok(items.some(i => i.type === 'fact' && i.content === '未知类型归 fact'), '未知类型兜底为 fact');
  const chatData = store.get('chats/roleplay');
  eq(chatData.userCountSince, 0, 'userCountSince 清零');
  ok(!!chatData.lastExtractAt, 'lastExtractAt 记录');
}

section('memoryTick(force)/flushMemory：不足阈值但强制 → 补提取（会话尾部缺口收口）');
{
  let llmCalled = 0;
  llm.genericCompletion = async () => {
    llmCalled++;
    return JSON.stringify([{ type: 'preference', content: '用户偏好纯思辨性哲学探讨', importance: 4 }]);
  };
  store.replace('memory/roleplay', { items: [] });
  store.replace('chats/roleplay', { messages: [{ role: 'user', content: '我们聊聊世界本质' }], userCountSince: 2, lastExtractAt: null });
  const done = await chat.flushMemory();
  eq(done, true, 'flushMemory 返回 true');
  eq(llmCalled, 1, 'force 无视阈值调用 LLM');
  eq(store.get('memory/roleplay').items.length, 1, '尾部消息补提取入库');
  eq(store.get('chats/roleplay').userCountSince, 0, '计数清零');
}

section('memoryTick：无未提取消息（since=0）→ 即使 force 也不调 LLM');
{
  let llmCalled = 0;
  llm.genericCompletion = async () => { llmCalled++; return '[]'; };
  store.replace('chats/roleplay', { messages: [{ role: 'user', content: 'hi' }], userCountSince: 0, lastExtractAt: null });
  await chat.memoryTick(true);
  eq(llmCalled, 0, 'since=0 不调 LLM（面板重复打开零开销）');
}

section('memoryTick：并发互斥——面板/定时器/回复收尾同时触发只提取一次');
{
  let llmCalled = 0;
  llm.genericCompletion = async () => {
    llmCalled++;
    await new Promise(r => setTimeout(r, 30));
    return JSON.stringify([{ type: 'fact', content: '只应入库一次', importance: 3 }]);
  };
  store.replace('memory/roleplay', { items: [] });
  store.replace('chats/roleplay', { messages: [{ role: 'user', content: 'x' }], userCountSince: 9, lastExtractAt: null });
  await Promise.all([chat.memoryTick(true), chat.memoryTick(true), chat.flushMemory()]);
  eq(llmCalled, 1, 'LLM 只调用一次');
  eq(store.get('memory/roleplay').items.length, 1, '记忆只写一条（无重复条目）');
}

section('memoryTick：LLM 输出异常 → 正则兜底仍产出记忆');
{
  llm.genericCompletion = async () => '这不是JSON';
  store.replace('memory/roleplay', { items: [] });
  store.replace('chats/roleplay', { messages: [{ role: 'user', content: '我是新来的实习生' }], userCountSince: 11, lastExtractAt: null });
  await chat.memoryTick();
  const items = store.get('memory/roleplay').items;
  eq(items.length, 1, '兜底产出 1 条');
  ok(items[0].content.includes('我是'), '兜底正则命中自我介绍');
}

section('memoryTick：记忆上限 50，按（重要性,时间）淘汰');
{
  // 预填 50 条低重要性旧记忆
  const old = [];
  for (let i = 0; i < 50; i++) old.push({ type: 'fact', content: `旧${i}`, importance: 1, createdAt: `2026-09-20T00:00:${String(i % 60).padStart(2, '0')}` });
  store.replace('memory/roleplay', { items: old });
  llm.genericCompletion = async () => JSON.stringify(
    Array.from({ length: 8 }, (_, k) => ({ type: 'fact', content: `新${k}`, importance: 5 }))
  );
  store.replace('chats/roleplay', { messages: [{ role: 'user', content: 'x' }], userCountSince: 10, lastExtractAt: null });
  await chat.memoryTick();
  const items = store.get('memory/roleplay').items;
  eq(items.length, 50, '淘汰后仍为 50');
  eq(items.filter(i => i.importance === 5).length, 8, '8 条新记忆全部保留');
  ok(!items.some(i => i.content === '旧0'), '最旧的低重要性记忆被淘汰');
}

console.log(`\n========== 上下文/记忆回归结果：${passed} 通过 / ${failed} 失败 ==========`);
process.exit(failed ? 1 : 0);

})();
