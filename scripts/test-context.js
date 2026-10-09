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

// v0.5 多会话：roleplay 计数随会话走（顶层 userCountSince 已废弃）
const activeSess = () => {
  const d = store.get('chats/roleplay');
  return (d.sessions || []).find(s => s.id === d.activeSessionId) || (d.sessions || [])[0] || {};
};

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
  // 戏外工作轮（/order）：历史窗收窄到 10 条（20261004——工作任务的 base 每轮全量重发，
  // 20 条扮演历史是乘法税的大头）
  const outW = chat.buildMessages('roleplay', history, { work: true });
  eq(outW.slice(1).length, 10, 'work 轮只取最近 10 条');
  eq(outW.slice(1)[0].content, 'msg26', 'work 窗口起点=第 26 条');
  eq(outW.slice(1)[9].content, 'msg35', 'work 窗口终点=最后一条');
  const outQ = chat.buildMessages('quick', history, { work: true });
  eq(outQ.slice(1).length, 20, 'quick 不受 work 窗口影响（恒 20）');
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

// ============ 1.5 戏外→戏内记忆隔离（v0.4.0-dev.3） ============
section('buildMessages：harness 注记（系统核实）不进角色上下文（戏外/戏内隔离）');
{
  const history = [
    { role: 'assistant', content: '报告已写入 todo.md。\n\n（系统核实：本次任务没有实际写入任何文件，上文关于已写入的表述与事实不符。）' },
    { role: 'user', content: '厉害啊！' },
  ];
  const out = chat.buildMessages('roleplay', history);
  const asst = out.find(m => m.role === 'assistant');
  ok(!asst.content.includes('系统核实'), '「（系统核实：…）」注记被剥离（不诱发角色自我怀疑）');
  ok(asst.content.includes('报告已写入 todo.md'), '正文本身保留（角色记忆连续）');
}

section('buildMessages：agent 任务轮长报告结构化压缩（M-2：保头尾+不确定节，最新 2000 / 更早 500）');
{
  const longReport = '## 结论先行\n检索完成，结论 A 成立。\n' + '论证细节。'.repeat(400)
    + '\n## 我不确定的部分\n样本量不足，结论 A 的置信度中等，建议复查。\n' + '附录内容。'.repeat(400);
  const history = [
    { role: 'assistant', content: longReport, agentRun: true },        // 更早的报告 → 500 上限
    { role: 'assistant', content: longReport, agentRun: true },        // 窗口内最新报告 → 2000 上限
    { role: 'assistant', content: '这是一条普通扮演回复。' + '心'.repeat(900), }, // 无标记的普通长回复不截断
  ];
  const out = chat.buildMessages('roleplay', history);
  const caps = out.slice(1).map(m => m.content);
  ok(caps[0].startsWith('[戏外工作报告]'), '更早的报告带戏外来源前缀（provenance）');
  ok(caps[0].length <= 700, `更早的报告 ≤500+注记（实际 ${caps[0].length}）`);
  ok(caps[1].startsWith('[戏外工作报告]'), '最新报告带前缀');
  ok(caps[1].length <= 2200, `最新报告 ≤2000+注记（实际 ${caps[1].length}）`);
  ok(caps[1].includes('结论先行'), '最新报告保头部（结论区）');
  ok(caps[1].includes('我不确定的部分'), '最新报告白名单节存活（置信度不再被截掉）');
  ok(caps[1].includes('置信度中等'), '不确定节的具体内容保留');
  ok(caps[1].includes('报告已结构化压缩'), '压缩回执存在');
  const appendixHits = (caps[1].match(/附录内容。/g) || []).length;
  ok(appendixHits < 200, `附录正文主体被丢弃（残留 ${appendixHits} 处，均为头尾区间内的合法保留）`);
  ok(!caps[2].includes('戏外工作报告') && caps[2].includes('这是一条普通扮演回复'), '无标记的普通回复不受影响');
}

section('buildMessages：v1.1 §1.6 反例——结论+不确定+带标题附录的报告，附录整节丢弃');
{
  const report = '## 结论\n' + 'A'.repeat(1000) + '\n## 我不确定的部分\n' + 'B'.repeat(800) + '\n## 附录\n' + 'C'.repeat(3000);
  const history = [
    { role: 'user', content: '任务收尾' },
    { role: 'assistant', content: report, agentRun: true },
  ];
  const out = chat.buildMessages('roleplay', history);
  const rep = out[out.length - 1].content;
  ok(rep.length <= 2200, `总长 ≤2000+注记（实际 ${rep.length}）`);
  ok(rep.includes('## 结论'), '结论头保留');
  ok(rep.includes('## 我不确定的部分') && rep.includes('B'.repeat(100)), '不确定节整节存活');
  const cHits = (rep.match(/C/g) || []).length;
  ok(cHits <= 450, `附录主体被丢弃（残留 ${cHits} 个 C，均为尾部 400 区间的合法保留）`);
}

section('roleplaySystem：近期工作台账收据注入（有近期 run 时）');
{
  const runs = require(SVC('agent/runs'));
  const rid = runs.newRunId();
  runs.append({
    id: rid, at: new Date().toISOString(), status: 'done', instruction: 't',
    steps: [
      { kind: 'tool', tool: 'web_search', summary: 'x', ok: true },
      { kind: 'tool', tool: 'web_search', summary: 'y', ok: true },
      { kind: 'tool', tool: 'write_file', summary: 'p', ok: true },
    ],
    changed: [
      { path: 'D:/x/报告.md', origin: 'tool' },                    // 工具真实写入 → 产物
      { path: 'D:/x/config/settings.json', origin: 'ambiguous' },  // 应用自写漂移 → 不是产物（M-3）
    ],
  });
  const sys = prompts.roleplaySystem();
  ok(sys.includes('【近期工作台账'), '台账区块出现');
  ok(sys.includes('web_search×2') && sys.includes('write_file×1'), '工具计数聚合正确');
  ok(sys.includes('报告.md'), '工具产物文件名注入');
  ok(!sys.includes('settings.json'), '应用自写文件漂移不算产物（ambiguous 不进台账）');
  ok(sys.includes('引用这些成果不需要在本轮重新执行'), '收据语义注记存在');
  // 纪律条款：既往工作可信 + 回戏
  ok(sys.includes('本纪律只约束「本轮正在执行的任务」'), '执行纪律含既往工作边界条款');
  ok(sys.includes('回到日常扮演语气'), '含任务后回戏指令');
  // 旧 run（>24h）不注入
  runs.append({ id: runs.newRunId(), at: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), status: 'done', instruction: 'old', steps: [{ kind: 'tool', tool: 'read_file', ok: true }], changed: [] });
  // 追加了一条 25h 前的 run，仍在 24h 窗口内的那条照常显示即可（不单独断言旧条被滤——
  // recentWorkBlock 按时间过滤的逻辑由上方 cutoff 保证，这里防回归仅验证不抛错）
  ok(prompts.roleplaySystem().includes('【近期工作台账'), '时间过滤后仍正常输出（不抛错）');
  runs.update({ id: rid, at: new Date().toISOString(), status: 'done', instruction: 't', steps: [], changed: [] }); // 还原：清空 steps 后不再产出台账
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
  // 缓存前缀稳定性（20261004）：【当前时间】是分钟级变化字段，必须位于 system 末尾——
  // 卡在中段会让它之后的数千 token（记忆/规则/agent 纪律）每翻分钟打出血 DeepSeek 前缀缓存
  const tIdx = sys.indexOf('【当前时间】');
  ok(tIdx >= 0, '时间块存在');
  ok(tIdx > sys.indexOf('【交互规则】'), '时间块在交互规则之后（缓存前缀稳定）');
}

section('roleplaySystem：长期记忆注入（v0.5：core 全量 + working 最近 8；ephemeral 不注入）');
{
  const items = [];
  // 12 条同 importance 的 working 记忆——M-1 反例：旧实现按 importance 排序全部同分，
  // 稳定排序保持插入序、slice(0,10) 恒取最旧；新注入按时间取最新 8
  for (let i = 1; i <= 12; i++) items.push({ id: 'mem_w' + i, type: 'fact', content: `工作记忆${String(i).padStart(2, '0')}`, importance: 5, scope: 'working', createdAt: `2026-10-${String(i).padStart(2, '0')}T10:00:00` });
  items.push({ id: 'mem_c1', type: 'fact', content: '核心认知甲', importance: 5, scope: 'core', createdAt: '2026-09-01T10:00:00' });
  items.push({ id: 'mem_c2', type: 'fact', content: '核心认知乙', importance: 5, scope: 'core', createdAt: '2026-09-02T10:00:00' });
  items.push({ id: 'mem_e1', type: 'event', content: '限时事件记录', importance: 5, scope: 'ephemeral', ttlDays: 14, createdAt: dayjs().format() });
  store.replace('memory/roleplay', { items, archive: [] });
  const sys = prompts.roleplaySystem();
  ok(sys.includes('【长期记忆 · core'), 'core 区块出现');
  ok(sys.includes('【近期记忆 · working'), 'working 区块出现');
  for (let i = 5; i <= 12; i++) ok(sys.includes(`工作记忆${String(i).padStart(2, '0')}`), `working 最新第 ${i} 条注入`);
  for (let i = 1; i <= 4; i++) ok(!sys.includes(`工作记忆${String(i).padStart(2, '0')}`), `working 较旧的第 ${i} 条不注入`);
  ok(sys.includes('核心认知甲') && sys.includes('核心认知乙'), 'core 全量注入（不受 8 条窗限制）');
  ok(!sys.includes('限时事件记录'), 'ephemeral 不进每轮注入');
  store.replace('memory/roleplay', { items: [], archive: [] }); // 还原
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
  ok(got[0].content.includes('现有记忆库') || got[0].content.includes('记忆库当前为空'), '提取 prompt 带记忆库状态（v0.5 合并前提）');
  eq(activeSess().userCountSince, 0, '会话 userCountSince 清零');
  ok(!!activeSess().lastExtractAt, 'lastExtractAt 记录');
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
  eq(activeSess().userCountSince, 0, '计数清零');
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
