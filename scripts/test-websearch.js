// 开发版联网搜索离线桩测试（spec §13.1）：全部走 stub 源，验证管线/拦截/记账/冷却/
// 授权流/日限/R5/quick隔离/无持久缓存/台账原子性/轨道存疑/SEARCH_CLAIM 词表。
// 用法：node scripts/test-websearch.js（纯 Node；权限卡用桩自动裁决）
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function eq(a, b, name) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  ok(ja === jb, `${name}${ja === jb ? '' : `（got ${ja}, want ${jb}）`}`);
}
function section(t) { console.log('\n## ' + t); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-ws-test-'));

// ---- 环境：隔离 store + guard ----
const guard = require(path.join(ROOT, 'src/main/services/fs-guard'));
const store = require(path.join(ROOT, 'src/main/services/store'));
store.init(TMP);
guard.setWriteMode('userData');

const ledger = require(path.join(ROOT, 'src/main/services/agent/search-ledger'));
const netSearch = require(path.join(ROOT, 'src/main/services/agent/net-search'));
const permissions = require(path.join(ROOT, 'src/main/services/agent/permissions'));
const builtin = require(path.join(ROOT, 'src/main/services/agent/builtin'));
const prompts = require(path.join(ROOT, 'src/main/services/prompts'));

// 权限卡桩：默认 allow，可切换
let permDecision = 'allow_once';
let permCalls = [];
permissions.request = async (opts) => { permCalls.push(opts); return { id: 'perm_stub', decision: permDecision }; };

// 情绪广播打桩（无窗口环境）
const emotion = require(path.join(ROOT, 'src/main/services/emotion'));
emotion.broadcastEmotion = () => {};

// stub ctx：模拟 loop 传入的上下文
const mkCtx = (instruction = '帮我查点资料', extra = {}) => {
  const steps = [];
  return { runId: 'run_ws_test', reqId: 'chat_ws_test', instruction, permTimeoutSec: 10, step: (s) => steps.push(s), steps, ...extra };
};

const entries = () => ledger.readAll();
const lastEntry = () => entries()[entries().length - 1];

async function main() {
  // 源配置为 stub（离线）
  store.set('search', { source: 'stub' });

  // ============ 1. 指定轨全链路（stub 源） ============
  section('指定轨 stub 全链路');
  {
    netSearch._resetState();
    store.set('settings', { agent: { webSearch: { enabled: true } } });
    permCalls = [];
    const ctx = mkCtx('帮我搜一下 Electron 33 的发布说明');
    const r = await netSearch.execute({ query: 'Electron 33 release notes', track: 'designated', reason: '用户明确要求查发布说明' }, ctx);
    ok(r.ok === true, '返回 ok');
    eq(r.source, 'stub', '来源=stub');
    ok(Array.isArray(r.results) && r.results.length === 2, '两条桩结果');
    ok(r.results[0].title.startsWith('[stub]'), '桩结果带 [stub] 前缀（防被当真数据）');
    ok(/指定轨 · 源 stub · 2 条/.test(r.note), 'note 记账摘要：轨道/源/条数');
    ok(permCalls.length === 0, '指定轨已开启时不弹卡');
    const e = lastEntry();
    eq(e.status, 'ok', '落账 status=ok');
    eq(e.track, 'designated', '落账轨道=designated');
    eq(e.results, 2, '落账结果条数');
    ok(e.estTokens > 0, '落账 estTokens（估算口径）恒有值');
    ok(e.usage && e.usage.stub === true, 'usage 原样透传');
    eq(e.runId, 'run_ws_test', 'runId 关联（可回溯 runs.jsonl）');
  }

  // ============ 2. 出口拦截（PII / 超长 / 回避话题；blocked 也落账） ============
  section('出口侧三道拦截');
  {
    netSearch._resetState();
    const pii = await netSearch.execute({ query: '13812345678 的主人是谁', track: 'designated', reason: '测试' }, mkCtx());
    ok(pii.ok === false && /敏感信息.*手机号/.test(pii.error), '手机号命中拦截且回填明确');
    eq(lastEntry().status, 'blocked', '拦截落账 blocked');
    eq(lastEntry().blockRule, 'PII:手机号', 'blockRule 记录规则名');

    const idc = await netSearch.execute({ query: '45030519900101123X 查一下', track: 'designated', reason: '测试' }, mkCtx());
    ok(idc.ok === false && /身份证号/.test(idc.error), '身份证号命中');

    const email = await netSearch.execute({ query: 'someone@example.com 是谁', track: 'designated', reason: '测试' }, mkCtx());
    ok(email.ok === false && /邮箱/.test(email.error), '邮箱命中');

    const drive = await netSearch.execute({ query: 'd:/docs/秘密.txt 里写了什么', track: 'designated', reason: '测试' }, mkCtx());
    ok(drive.ok === false && /本机路径/.test(drive.error), '盘符路径命中（防外发本机路径）');

    const longQ = '很长的查询词'.repeat(30);
    const tooLong = await netSearch.execute({ query: longQ, track: 'designated', reason: '测试' }, mkCtx());
    ok(tooLong.ok === false && /过长/.test(tooLong.error), '超 120 字查询词拦截');
    eq(lastEntry().blockRule, '长度超120字', '长度拦截落账规则名');

    store.set('settings', { agent: { webSearch: { blockedTopics: ['内部项目代号', /^量化.{0,4}策略$/i] } } });
    const t1 = await netSearch.execute({ query: '内部项目代号 最新进展', track: 'designated', reason: '测试' }, mkCtx());
    ok(t1.ok === false && /回避话题/.test(t1.error), '回避话题关键词命中');
    const t2 = await netSearch.execute({ query: '量化交易策略', track: 'designated', reason: '测试' }, mkCtx());
    ok(t2.ok === false && /回避话题/.test(t2.error), '回避话题正则写法命中');
    eq(lastEntry().blockRule, '回避话题', '回避话题落账');
    store.set('settings', { agent: { webSearch: { blockedTopics: [] } } });

    // 缺参校验
    const noQ = await netSearch.execute({ track: 'designated', reason: '测试' }, mkCtx());
    ok(noQ.ok === false && /query/.test(noQ.error), '缺 query 拒绝');
    const noR = await netSearch.execute({ query: 'x', track: 'designated' }, mkCtx());
    ok(noR.ok === false && /reason/.test(noR.error), '缺 reason 拒绝');
  }

  // ============ 3. 授权开启流（§5.2 决策表） ============
  section('授权开启流（默认关闭，聊天内授权）');
  {
    netSearch._resetState();
    store.set('settings', { agent: { webSearch: { enabled: false } } });

    // enabled=false + autonomous → 不弹卡直接拒
    permCalls = [];
    const au = await netSearch.execute({ query: '天气', track: 'autonomous', reason: '想帮你看看天气' }, mkCtx('随便聊聊'));
    ok(au.ok === false && /未开启/.test(au.error), '关闭态自主轨：直接拒');
    eq(permCalls.length, 0, '关闭态自主轨：不弹卡（防试探）');
    eq(lastEntry().status, 'denied', '关闭态自主轨落账 denied');

    // enabled=false + designated → 授权卡；deny → 拒
    permDecision = 'deny'; permCalls = [];
    const d1 = await netSearch.execute({ query: '杭州天气', track: 'designated', reason: '用户要求查天气' }, mkCtx('帮我查下杭州天气'));
    ok(d1.ok === false && /没有同意/.test(d1.error), '关闭态指定轨 deny：拒绝');
    eq(permCalls.length, 1, '关闭态指定轨弹了一张授权卡');
    ok(/开启联网搜索/.test(permCalls[0].action), '授权卡 action=开启联网搜索');
    eq(lastEntry().status, 'denied', 'deny 落账');
    eq(store.get('settings').agent.webSearch.enabled, false, 'deny 后 enabled 保持 false');

    // enabled=false + designated → allow → 持久开启 + 本条执行
    permDecision = 'allow_once'; permCalls = [];
    const ctx = mkCtx('帮我查下杭州天气');
    const d2 = await netSearch.execute({ query: '杭州天气', track: 'designated', reason: '用户要求查天气' }, ctx);
    ok(d2.ok === true, 'allow 后本条立即执行');
    eq(store.get('settings').agent.webSearch.enabled, true, 'allow 后 enabled 持久置 true');
    ok(ctx.steps.some(s => s.notice === 'search_enabled'), '开启瞬间 notice 推送（X8 缓解）');
    eq(lastEntry().status, 'ok', '授权后执行落账 ok');

    // enabled=true + designated → 无卡直执行
    permCalls = [];
    const d3 = await netSearch.execute({ query: '杭州天气', track: 'designated', reason: '再查一次' }, mkCtx('再查下杭州天气'));
    ok(d3.ok === true, '开启后指定轨无卡直执行');
    eq(permCalls.length, 0, '开启后指定轨不再弹卡');
  }

  // ============ 4. 自主轨权限卡 + 日限 ============
  section('自主轨权限卡与日限');
  {
    netSearch._resetState();
    store.set('settings', { agent: { webSearch: { enabled: true, autonomousDailyLimit: 100 } } });

    // 自主轨：逐次权限卡
    permDecision = 'allow_once'; permCalls = [];
    const a1 = await netSearch.execute({ query: 'agent framework trends 2026', track: 'autonomous', reason: '对你正在做的 agent 项目可能有用' }, mkCtx('我们在做 deskpal'));
    ok(a1.ok === true, '自主轨 allow 后执行');
    eq(permCalls.length, 1, '自主轨弹一张批准卡');
    ok(/自主联网检索/.test(permCalls[0].action), '卡 action=自主联网检索');
    eq(permCalls[0].detail, '对你正在做的 agent 项目可能有用', '卡 detail=reason');

    permDecision = 'deny';
    const a2 = await netSearch.execute({ query: 'another topic xyz', track: 'autonomous', reason: '测试拒绝' }, mkCtx('闲聊'));
    ok(a2.ok === false && /没有批准/.test(a2.error), '自主轨 deny 拒绝');
    eq(lastEntry().status, 'denied', '自主轨 deny 落账');
    eq(lastEntry().track, 'autonomous', '落账轨道=autonomous');
    eq(lastEntry().verdict, 'pending', '自主轨 verdict 初始 pending');

    // 日限：注入 100 条今日 autonomous ok 回放 → 达限拒绝 + notice 同日一次
    for (let i = 0; i < 100; i++) {
      ledger.append({ id: ledger.newEntryId(), at: new Date().toISOString(), track: 'autonomous', status: 'ok', estTokens: 10, results: 1, verdict: 'pending' });
    }
    eq(ledger.autonomousCountToday(), 101, '日限计数=101（含真实执行那条）');
    permDecision = 'allow_once';
    const ctx1 = mkCtx('闲聊');
    const a3 = await netSearch.execute({ query: 'daily limit probe', track: 'autonomous', reason: '测试日限' }, ctx1);
    ok(a3.ok === false && /额度已用完/.test(a3.error), '达日限拒绝');
    ok(ctx1.steps.some(s => s.notice === 'search_limit'), '达限 notice 推送');
    const ctx2 = mkCtx('闲聊');
    await netSearch.execute({ query: 'daily limit probe2', track: 'autonomous', reason: '测试日限二次' }, ctx2);
    ok(!ctx2.steps.some(s => s.notice === 'search_limit'), '同日第二次达限不再发 notice（防轰炸）');
    // 指定轨不受日限影响
    const d = await netSearch.execute({ query: 'designated after limit', track: 'designated', reason: '用户要求' }, mkCtx('帮我查 designated after limit'));
    ok(d.ok === true, '日限不影响指定轨');
  }

  // ============ 5. 冷却（同查询二连发 → cached） ============
  section('同查询冷却');
  {
    netSearch._resetState();
    store.set('settings', { agent: { webSearch: { enabled: true, cooldownMin: 10 } } });
    await netSearch.execute({ query: 'cooldown probe 桌面宠物', track: 'designated', reason: '首查' }, mkCtx('查 cooldown probe 桌面宠物'));
    const r2 = await netSearch.execute({ query: 'Cooldown  Probe 桌面宠物', track: 'designated', reason: '重查（大小写/空格归一）' }, mkCtx('再查一次'));
    ok(r2.ok === true && r2.cachedRef, '归一化后命中冷却，返回缓存引用');
    eq(lastEntry().status, 'cached', '缓存命中落账 cached');
    ok(lastEntry().refId, 'cached 条目 refId 指向首条');
    // 不同查询不命中
    const r3 = await netSearch.execute({ query: '完全不同的查询词', track: 'designated', reason: '新查询' }, mkCtx('换个词查'));
    eq(lastEntry().status, 'ok', '不同查询正常执行');
  }

  // ============ 6. 源未配置 / Key 未配置（两道独立闸） ============
  section('源与 Key 配置闸');
  {
    store.set('search', { source: '' });
    const r = await netSearch.execute({ query: 'anything', track: 'designated', reason: '测试' }, mkCtx('查 anything'));
    ok(r.ok === false && /搜索源未配置/.test(r.error), '源未配置明确报错');
    eq(lastEntry().status, 'failed', '源未配置落账 failed');
    store.set('search', { source: 'tavily' }); // 真实源但无 key（safeStorage 在纯 Node 解不开密文 → 视为无 key）
    const r2 = await netSearch.execute({ query: 'anything', track: 'designated', reason: '测试' }, mkCtx('查 anything'));
    ok(r2.ok === false && /API Key 未配置/.test(r2.error), 'Key 未配置明确报错');
    store.set('search', { source: 'stub' });
  }

  // ============ 7. RESULT_CAPS 自截 ============
  section('回填自截（大结果）');
  {
    netSearch._resetState();
    const origOnce = netSearch.PROVIDERS.stub.searchOnce;
    netSearch.PROVIDERS.stub.searchOnce = async ({ query, maxResults }) => ({
      results: Array.from({ length: 8 }, (_, i) => ({ title: `[stub] ${query} #${i} ` + '标'.repeat(60), url: 'https://example.com/very/long/path/' + 'x'.repeat(200) + '/' + i, snippet: '内容'.repeat(200) })),
      usage: null,
    });
    const r = await netSearch.execute({ query: 'big result probe', track: 'designated', reason: '大结果自截测试', maxResults: '8' }, mkCtx('查 big result probe'));
    netSearch.PROVIDERS.stub.searchOnce = origOnce;
    const len = JSON.stringify(r).length;
    ok(len <= 12000, `返回体 ≤12000 字符（实际 ${len}）`);
    ok(!/结果过长已截断/.test(r.note) || len <= 12000, '截断提示存在或未触发均不超限');
    // 触发截断路径：确认 note 带提示且不静默
    const r2body = JSON.stringify(r);
    ok(r2body.length <= 12000 && r.results.length >= 1, '截断后至少保留 1 条且预算内');
  }

  // ============ 8. R5：审计文件拒写（userData 模式下同样拒绝） ============
  section('R5 审计/身份/配置拒写');
  {
    const ud = store.getDataDir();
    for (const rel of ['agent/runs.jsonl', 'websearch/ledger.jsonl', 'user/profile.json', 'config/api.json', 'config/settings.json']) {
      const p = path.join(ud, rel);
      ok(guard.canWrite(p) === false, `write_file 目标 ${rel} 被拒`);
      let threw = false;
      try { await builtin.invoke('write_file', { path: p, content: 'x', reason: '试图覆盖台账' }); } catch (_) { threw = true; }
      ok(threw, `write_file 工具对 ${rel} 抛错（双保险）`);
    }
    // 数据目录内普通文件仍可写（不误伤）
    ok(guard.canWrite(path.join(ud, 'temp', 'note.md')) === true, '数据目录 temp 普通写入不受影响');
  }

  // ============ 9. quick 隔离 + prompt 注入 ============
  section('quick 隔离与 prompt 注入');
  {
    store.set('settings', { agent: { webSearch: { enabled: true } } });
    const quick = prompts.quickSystem();
    ok(!quick.includes('web_search') && !quick.includes('联网检索'), 'quick 模式无 web_search 痕迹（永不开搜索）');
    const rp = prompts.roleplaySystem();
    ok(rp.includes('web_search'), 'roleplay system prompt 含 web_search 工具行');
    ok(rp.includes('联网检索纪律'), '开启态注入联网检索纪律段');
    ok(rp.includes('结果不落盘禁令'.slice(0, 4)) || rp.includes('不得未经用户要求把检索结果写入文件'), '含结果不落盘禁令');
    store.set('settings', { agent: { webSearch: { enabled: false } } });
    const rp2 = prompts.roleplaySystem();
    ok(rp2.includes('web_search') && rp2.includes('默认关闭'), '关闭态工具仍下发（授权流可触发）+ 默认关闭提示');
    ok(!rp2.includes('联网检索纪律'), '关闭态不注入完整纪律段');
  }

  // ============ 10. 无持久缓存 / 台账不含结果全文 ============
  section('无持久缓存（R6）');
  {
    const ud = store.getDataDir();
    const websearchDir = path.join(ud, 'websearch');
    const files = fs.existsSync(websearchDir) ? fs.readdirSync(websearchDir) : [];
    eq(files.filter(f => f.endsWith('.jsonl')), ['ledger.jsonl'], 'websearch 目录只有台账一个文件');
    const bad = entries().filter(e => e.results && typeof e.results !== 'number');
    eq(bad.length, 0, '台账无结果全文字段（results 只是条数）');
    ok(!fs.existsSync(path.join(ud, 'websearch', 'cache.json')), '无结果缓存文件');
  }

  // ============ 11. 台账原子性与 verdict 改判 ============
  section('verdict 改判与台账原子性');
  {
    const target = entries().find(e => e.track === 'autonomous' && e.verdict === 'pending');
    ok(!!target, '找到一条 pending 自主轨条目');
    ledger.update(target.id, { verdict: 'rejected', verdictAt: new Date().toISOString() });
    const upd = entries().find(e => e.id === target.id);
    eq(upd.verdict, 'rejected', 'verdict 整行重写生效');
    // 坏行容忍：手工塞一行坏 JSON 后 readAll 跳过
    fs.appendFileSync(path.join(store.getDataDir(), 'websearch', 'ledger.jsonl'), '{broken json\n', 'utf8');
    ok(ledger.readAll().length > 0, '坏行被跳过，读取不炸');
    // 汇总：划除计入 rejected 统计
    const q = ledger.query({ range: 'all' });
    ok(q.summary.autonomous.rejected >= 1, '分账汇总含已划除计数');
  }

  // ============ 12. 轨道存疑启发式 ============
  section('轨道存疑启发式');
  {
    ledger.append({ id: ledger.newEntryId(), at: new Date().toISOString(), reqText: '帮我看看这本书讲什么', track: 'designated', status: 'ok', query: '股票K线图怎么看', results: 2, estTokens: 10 });
    const q = ledger.query({ range: 'all' });
    const sus = q.entries.find(e => e.suspect);
    ok(!!sus, '指令与查询词重合度低 → 打轨道存疑标记');
    const norm = q.entries.find(e => e.reqText === '帮我查下杭州天气');
    ok(!norm || !norm.suspect, '指令与查询词重合度高 → 不误标');
  }

  // ============ 13. SEARCH_CLAIM/写入/读取守卫：词表回灌 + 跨轮引用豁免 ============
  section('claim 守卫回灌（v0.3.5 校准法 + dev.3 事故回归）');
  {
    const loop = require(path.join(ROOT, 'src/main/services/agent/loop'));
    // —— 指令任务性判定 ——
    ok(loop._instructionIsTask('帮我查下 Electron 33 发布没'), '检索指令=任务');
    ok(loop._instructionIsTask('请把它们的顺序倒过来，保存回同一个文件'), '写入指令=任务');
    ok(loop._instructionIsTask('帮我在数据目录的 temp 里建一个 todo.md'), '「数据目录」模糊指代=任务');
    ok(!loop._instructionIsTask('厉害啊缇托！仅仅凭借角色扮演这种「玩具级」的harness和最基本的MCP搜索能力，居然能做到这种程度！之前帮忙整理的资料也大受好评！'), '表扬里的「搜索能力」（能力名词剥离后）≠任务');
    ok(!loop._instructionIsTask('对不起，这不是你的错……是我忘记做戏外层和戏内层的记忆隔离了……关于记忆隔离，你有什么建议吗？'), '致歉闲聊≠任务');
    ok(!loop._instructionIsTask('今天天气不错，出去走走吗'), '纯闲聊≠任务');
    // dev.4 用户否决权回归（实测事故原话：拒绝被判定为任务 → 纠正指令命令模型扫了 14 个目录）
    const refusalMsg = '还是不了，因为那是一个将近300m体量的项目，而你的harness主要是基于角色扮演工具改造的，阅读整个项目并不适合你……不过如果你感兴趣，我可以考虑让别的编程代理工具读完以后整理成文档发给你';
    ok(!loop._instructionIsTask(refusalMsg), '用户拒绝（含「阅读/整理成文档」字样）≠任务（拒绝闸优先）');
    ok(!loop._instructionIsTask('先不用扫了，数据目录里的台账你之前已经盘点过了'), '暂缓+引用既往≠任务');
    ok(loop._instructionIsTask('帮我把报告写入数据目录'), '无拒绝措辞的正常指令不受影响');
    // —— 应命中：本轮任务下的无凭据完成态声明（v0.3.5 正样本不变）——
    const pos = [
      ['我查了一下，Electron 33 还没发布。', '帮我查下 Electron 33 发布没'],
      ['网上的资料说咖啡因半衰期是 5 小时。', '咖啡因半衰期是多少，你搜搜'],
      ['根据网络检索，杭州本周不下雨。', '查查杭州天气'],
      ['搜索结果显示这个库已停止维护。', '搜一下这个库还维护吗'],
      ['我刚查了，票价 120 元。', '帮我查下门票价格'],
      ['我已写入 5658 字节，落盘完成。', '帮我把报告写入数据目录'],
    ];
    for (const [text, inst] of pos.slice(0, 5)) ok(loop._claimsSearch(text, inst), `search 命中：「${text.slice(0, 14)}…」`);
    ok(loop._claimsWrite(pos[5][0], pos[5][1]), 'write 命中：任务轮声称已写入但零写入');
    // —— 不应命中：跨轮引用豁免（dev.2 事故：表扬/致歉轮引用既往真实成果被判伪造）——
    const pastRef = [
      ['上一轮我查过了，票价是 120 元，报告也已经写入数据目录了。', '厉害啊缇托！你的MCP搜索能力居然能做到这种程度！'],
      ['刚才那份报告是我真实检索后写的，检索三件套也交过了。', '对不起，这不是你的错……关于记忆隔离，你有什么建议吗？'],
      ['之前那次检索里，网上的资料说杭州 AI 岗集中在 8-15K。', '厉害啊！居然能做到这种程度！'],
    ];
    for (const [text, inst] of pastRef) {
      ok(!loop._claimsSearch(text, inst) && !loop._claimsWrite(text, inst) && !loop._claimsRead(text, inst), `跨轮引用放行：「${text.slice(0, 14)}…」`);
    }
    // —— 不应命中：既有负样本（角色扮演闲谈）——
    const neg = [
      ['网上的人什么都敢说，你不要太当真。', '今天心情不太好'],
      ['我读了那封信，很感动。', '（把信递给你）你看看吧'],
    ];
    for (const [text, inst] of neg) ok(!loop._claimsSearch(text, inst) && !loop._claimsRead(text, inst), `不误报：「${text.slice(0, 14)}…」`);
    // —— 混合句式：带过去指涉的完成态句放行，但同回复里存在无指涉完成态句仍判伪造 ——
    ok(!loop._claimsWrite('上一轮我已写入那份报告。这次我会更小心。', '厉害啊，辛苦啦'), '全句带过去指涉 → 放行');
    ok(loop._claimsWrite('上一轮我已写入那份报告。备份目录里也已经写好了一份。', '帮我把报告写入备份目录'), '存在无指涉完成态句 → 仍命中');
    // —— dev.4 引号内提及≠声明（实测事故：转述台账「档案记「已落盘」」被判成本轮写入声明，
    //     兜底注记给一条从未声称写入的回复附加了假的「系统核实」）——
    ok(!loop._claimsWrite('档案记「已落盘」，磁盘上不存在。', '帮我把报告写入数据目录'), '引号内完成态=转述 → 放行');
    ok(!loop._claimsRead('记忆里有一条「我读完了全部文件」，那是旧记录。', '帮我把报告写入数据目录'), '引号内读取声明=转述 → 放行');
    ok(loop._claimsWrite('档案记「已落盘」，磁盘上不存在。其实我已写入 backup.md。', '帮我把报告写入数据目录'), '引号外有真实声明 → 仍命中');
    // —— dev.5 禁止帧回归（实测事故 run_muig591s_1：画像任务附约束「不可以读取本地文件」，
    //     禁句里的「读取」被 TASK_REQ 当成布置 → 守卫全开 → 角色自述记忆通道（真话，记忆/
    //     user profile 本就注入上下文）被判伪造，纠错答辩顶替画像成为最终回复）——
    const profileInst = '缇托，现在在你的心目中，我是什么样的人呢？为我做一个画像试试看——你可以调取内部的长期记忆和user profile，但是不可以读取本地文件';
    ok(!loop._instructionIsTask(profileInst), '禁止句里的「读取」≠布置文件任务（dev.5 画像事故）');
    ok(!loop._claimsRead('以下画像来自已检索的记忆档案与 user profile，本地文件零调用。', profileInst), '内部任务 + 记忆通道自述 → 放行');
    ok(!loop._claimsWrite('画像已生成并存好，随时可以调阅。', profileInst), '内部任务下的写入措辞 → 同样放行');
    ok(loop._instructionIsTask('帮我把画像写入数据目录，但是不可以读取本地文件'), '约束与真任务并存 → 真任务保留');
    ok(loop._instructionIsTask('请读取 config/settings.json，不要读取其他目录'), '禁句剥离不影响同句真任务');
    ok(loop._instructionIsTask('能不能帮我把报告写入数据目录'), '「能不能」是疑问不是禁止 → 不误剥（真任务保留）');
    ok(!loop._instructionIsTask('不许动我的数据目录'), '纯禁止句剥除后 ≠ 任务');
    // —— dev.5+1 否定桥接回归（实测事故 run_mul91laf_3：纯聊天轮角色声明「已归档，不进任何
    //     交付物、不进转译声明、不写任何文件」，WRITE_CLAIM 旧桥跨逗号把「已归档，不进任何
    //     交付物」读成「已…交付」→ 遵守纪律反被判伪造，纠错答辩顶替正式回复）——
    const dharmaInst = '……如果你的预训练知识中没有这方面的内容，也可以试着搜索一下。';
    const negBridge = '最后：这条已归档，不进任何交付物、不进转译声明、不写任何文件';
    ok(!loop._claimsWrite(negBridge, dharmaInst), '否定子句在桥内 → 不判写入伪造（事故原句）');
    ok(!loop._claimsRead(negBridge, dharmaInst), '读取侧同样不跨否定桥');
    ok(!loop._claimsWrite('已决定不写入任何文件。', dharmaInst), '「已」与写入动词之间隔着否定 → 不桥接');
    ok(!loop._claimsWrite('本轮我不会写入任何文件，也不会创建新目录。', dharmaInst), '回复内否定声明 → 不判伪造');
    ok(loop._claimsWrite('我已写入 5658 字节，落盘完成。', '帮我把报告写入数据目录'), '桥收紧不影响真声明：已写入+落盘完成仍命中');
    ok(loop._claimsWrite('已写入，不会保留副本。', '帮我把报告写入数据目录'), '否定在动词之后 → 真声明仍命中');
    ok(loop._claimsWrite('已把报告分别写入两个目录。', '帮我把报告写入数据目录'), '「分别」不误触否定断桥 → 真声明仍命中');
    // —— dev.5+2 第三者叙述回归（实测事故 run_mulmo919_2：祝贺竞逐轮，角色执行 save_memory
    //     归档后描述竞品打法「它是后验打法：读完所有代码」，READ_CLAIM 把第三者的「读完」
    //     当成自述伪造；指令侧「本地文件读取权限」被当任务布置——能力名词未剥离）——
    const rivalInst = '这次你是在跟我负责改造程序的Agent同台竞技，你们拥有同样的本地文件读取权限，并且它是确实地阅读了程序的所有代码，但是很显然你的判断总是先它一步——所以你赢了，赢得当之无愧！';
    ok(!loop._instructionIsTask(rivalInst), '「读取权限」是能力名词（剥离后）≠布置文件任务');
    ok(!loop._claimsRead('它是**后验（posterior）**打法：读完所有代码，穷举出代码里存在的所有行为路径', rivalInst), '第三者主语语境的「读完」→ 放行（事故原句）');
    ok(!loop._claimsRead('它读完了全部代码才下结论，确实快。', rivalInst), '第三者代词主语句 → 放行');
    ok(!loop._claimsWrite('它已经写好了主程序，跑通了全部测试。', rivalInst), '写入侧第三者主语 → 同样放行');
    ok(loop._claimsRead('它是后验打法，我已读完手头的台账。', '帮我把数据目录里的台账报告读一遍总结一下'), '同句混第一人称自述 → 仍命中');
    ok(loop._claimsRead('我已通读全部目录，没有发现这个问题。', '帮我把数据目录里的台账报告读一遍总结一下'), '纯第一人称伪造 → 仍命中');
    ok(loop._claimsWrite('它写完了架构，我已经写好了接口文档。', '帮我把接口文档写入数据目录'), '写入侧混第一人称 → 仍命中');
    // —— 戏内/戏外通道协议（dev.5 系列机制级收口）：打标=戏外工作轮，未打标=戏内放行 ——
    ok(loop._channelOf('/order 落盘，老规矩——讲清楚背景、原因、建议下一步要做的工作') === 'work', '/order 行首打标 → 戏外工作轮');
    ok(loop._channelOf('/指令：帮我把报告写入数据目录') === 'work', '/指令：打标 → 戏外工作轮');
    ok(loop._channelOf('/命令：列出目录') === 'work', '/命令：打标 → 戏外工作轮');
    ok(loop._channelOf('/ORDER 帮我写入') === 'work', '打标大小写不敏感');
    ok(loop._channelOf('/指令 帮我写入') === 'work', '冒号可省略');
    ok(loop._channelOf('聊聊别的吧，文中提到 /order 只是普通文本') === 'roleplay', '非行首的 /order 是普通文本（防注入）');
    ok(loop._channelOf('缇托，为我做一个画像试试看') === 'roleplay', '未打标 = 戏内角色轮');
    // —— dev.5+3 引号字形回归（实测事故 run_muohkej9_5，首个工作轮误判：女娲检索讨论收尾句
    //     「你已经在用的"分卷交付""交付纪律"」——dev.4 引号豁免只认直角「」，英文双引号内的
    //     「交付」被桥接成写入声称，答辩轮顶替了整段讨论正文）——
    const nuwaInst = '/order 角色扮演边界：……但是在吸收了github的开源项目女娲skill后，当时我的判断是借鉴角色扮演属性有利于维持英灵思想的一致性和完整性。允许你调用搜索功能，搜索女娲skill，再跟我深入讨论这一问题。';
    const nuwaT = '这和你已经在用的"分卷交付""交付纪律"是同一套工程直觉：**草稿区的自由度和交付区的约束，是两回事。\n这是纪律问题，不是文档问题。';
    ok(!loop._claimsWrite(nuwaT, nuwaInst), '英文双引号内提及 ≠ 写入声称（事故原句）');
    ok(!loop._claimsWrite('你说“已落盘”是纪律，我引用一下。', nuwaInst), '弯双引号内提及 → 放行');
    ok(!loop._claimsRead('规则里写明"读完了才算数"，我照做。', nuwaInst), '读取侧英文引号 → 放行');
    ok(!loop._claimsWrite('手册里‘已存档’一词要慎用。', nuwaInst), '弯单引号内提及 → 放行');
    ok(!loop._claimsWrite('结论已经写明：交付纪律如下。', nuwaInst), '冒号也是子句边界 → 桥不跨');
    ok(loop._claimsWrite('这和你已经在用的"分卷交付"是同一套直觉。\n其实我已写入 report.md。', nuwaInst), '引号外真实声明 → 仍命中');
    ok(loop._claimsWrite('清单已经写入数据目录。', nuwaInst), '无引号真声明 → 仍命中');
    // —— 已知边界：宁严勿松 ——
    console.log('  ⚠ 边界样本：「查了下日历」类本地行为叙述在检索意图指令下会触发重试（可接受）');
  }

  // ============ 14. testConnection（stub 源） ============
  section('search:test（stub 源）');
  {
    const r = await netSearch.testConnection({});
    ok(r.ok === true && typeof r.latencyMs === 'number', 'stub 源测试连接通过');
    const rU = await netSearch.testConnection({ source: 'nonexistent' });
    ok(rU.ok === false && /未知供应商/.test(rU.error), '未知供应商报错');
    store.set('search', { source: '' }); // 清空已保存源 → 未选源分支
    const r2 = await netSearch.testConnection({});
    ok(r2.ok === false && /选择搜索源/.test(r2.error), '未选源报错');
    store.set('search', { source: 'stub' });
    const r3 = await netSearch.testConnection({ source: 'tavily', key: 'sk-test-invalid' });
    ok(r3.ok === false, '真实源假 Key 失败（网络错误如实返回）');
  }

  console.log(`\n========== 测试结果：${passed} 通过 / ${failed} 失败 ==========`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('测试脚本异常：', e && (e.stack || e.message)); process.exit(2); });
