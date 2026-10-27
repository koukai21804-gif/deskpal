// ★v0.6.3 回归测试：deep_memory 工具与 Hindsight 桥只读面（跨库 list / status / search、
// 敏感净化三道闸、bank 白名单、服务未运行的诚实降级、写入隔离不受 readBanks 影响）。
// 用法：node scripts/test-deep-memory.js（纯 Node，fetch 打桩，不依赖 8890 服务在跑）
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
  ok(ja === jb, `${name}${ja === jb ? '' : `（got ${String(ja).slice(0, 100)}, want ${String(jb).slice(0, 100)}）`}`);
}
function section(t) { console.log('\n## ' + t); }

// ---- fetch 打桩：bridge rawFetch 走 global fetch，按 URL 路由到桩响应 ----
const realFetch = globalThis.fetch;
let lastUrls = [];
function stubFetch(router) {
  globalThis.fetch = async (url) => {
    lastUrls.push(String(url));
    for (const [re, resp] of router) {
      if (re.test(String(url))) {
        if (resp instanceof Error) throw resp;
        return { ok: resp.ok !== false, status: resp.status || 200, text: async () => typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body) };
      }
    }
    throw new TypeError('fetch failed');
  };
}
function restoreFetch() { globalThis.fetch = realFetch; }

(async function main() {

// ---- 环境：隔离 userData ----
const store = require(SVC('store'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-deepmem-test-'));
store.init(dataDir);
store.flushAll();

const bridge = require(SVC('hindsight-bridge'));
const tools = require(SVC('agent/tools'));
require(SVC('agent/builtin'));
const loop = require(SVC('agent/loop'));
const deep = tools.get('deep_memory');
const H = deep && deep.handler;

// ============ 1. 配置默认值与白名单 ============
section('配置：readBanks 默认值、回落与写库隔离');
{
  eq(bridge.config().readBanks, ['deskpal-tito', 'hermes-main', 'hermes-clio'], '默认 readBanks 三库（含 hermes 只读）');
  eq(bridge.config().bank, 'deskpal-tito', '写库仍是 deskpal-tito');
  ok(bridge.readBanks().includes('hermes-main') && !bridge.readBanks().includes('_canary') && !bridge.readBanks().includes('_eval'), '心跳/评测库不入默认清单');
  store.set('hindsight', { readBanks: ['deskpal-tito', 'hermes-clio'] });
  eq(bridge.readBanks(), ['deskpal-tito', 'hermes-clio'], '用户自定义 readBanks 生效（配置合并）');
  eq(bridge.config().bank, 'deskpal-tito', '改 readBanks 不影响写库 bank');
  store.set('hindsight', { readBanks: [] });
  eq(bridge.readBanks(), ['deskpal-tito'], 'readBanks 空数组回落到写库自身');
  store.set('hindsight', { readBanks: null });
  eq(bridge.readBanks(), ['deskpal-tito'], 'readBanks 置 null（深合并留存 null）同样回落写库自身');
  store.replace('hindsight', {});
  eq(bridge.readBanks(), ['deskpal-tito', 'hermes-main', 'hermes-clio'], 'store.replace 整体复位后恢复默认三库（后续用例的干净基线）');
  eq(typeof bridge.listMemories, 'function', 'bridge 导出 listMemories');
  eq(typeof bridge.listBanks, 'function', 'bridge 导出 listBanks');
  eq(typeof bridge.health, 'function', 'bridge 导出 health');
  eq(typeof bridge.searchMemories, 'function', 'bridge 导出 searchMemories');
}

// ============ 2. 工具注册与戏内白名单 ============
section('工具面：注册、只读权限、戏内白名单');
{
  ok(!!deep, 'deep_memory 已注册');
  eq(deep.permission, 'read', 'permission=read（只读，不触发写权限闸）');
  eq(deep.enabled, true, 'enabled=true');
  ok(loop.ROLEPLAY_TOOLS.includes('deep_memory'), '在 ROLEPLAY_TOOLS 戏内白名单内');
  const names = tools.openAiSchemas().filter(s => loop.ROLEPLAY_TOOLS.includes(s.function.name)).map(s => s.function.name);
  ok(names.includes('deep_memory'), '戏内 schema 过滤后仍下发 deep_memory');
  eq(tools.RESULT_CAPS.deep_memory, 8000, 'RESULT_CAPS.deep_memory=8000');
}

// ============ 3. listMemories 净化 ============
section('listMemories：sensitive/L1/state/归属四道闸与 limit');
{
  const items = [
    { text: '用户喜欢复盘后散步', metadata: { attribution: 'user' }, state: 'valid', fact_type: 'fact', occurred_start: '2026-10-20T00:00:00+00:00' },
    { text: '这条被 L2 标记为敏感', metadata: { sensitive: 'true' }, state: 'valid' },
    { text: '密钥 sk-AbCdEf1234567890AbCd 泄漏样例', metadata: {}, state: 'valid' },
    { text: '已被失效的旧条目', metadata: {}, state: 'invalid' },
    { text: '归属不明的一句话', metadata: { attribution: 'unknown' }, state: 'valid', fact_type: 'observation' },
  ];
  stubFetch([[/memories\/list/, { body: { items } }]]);
  const r = await bridge.listMemories('deskpal-tito', 5);
  ok(r.ok, 'list ok');
  eq(r.items.length, 2, '敏感/L1/失效三条被滤，剩 2 条');
  eq(r.items[0].text, '用户喜欢复盘后散步', '干净条目原样返回');
  eq(r.items[0].at, '2026-10-20T00:00:00+00:00', 'at 取 occurred_start');
  ok(r.items[1].text.startsWith('（归属未定）'), 'unknown 归属加前缀，不冒充 user');
  ok(lastUrls.some(u => u.includes('time_field=updated_at') && u.includes('state=valid')), 'URL 带 time_field=updated_at&state=valid');
  lastUrls = [];
  const r2 = await bridge.listMemories('deskpal-tito', 2);
  ok(lastUrls[0].includes('limit=4'), '多取一倍（limit=2→请求 4）对冲净化损耗');
  eq(r2.items.length, 2, '净化后截断到 limit');
  restoreFetch();
}

// ============ 4. searchMemories 与 recall 兼容 ============
section('searchMemories：语义检索、L1 过滤、down 判定、recall 旧签名兼容');
{
  stubFetch([[/memories\/recall$/, { body: { results: [
    { text: '用户在复盘会学到倾听', metadata: { attribution: 'user' } },
    { text: '又一个 sk-ZxYwVu0987654321ZxYw 键样例', metadata: {} },
  ] } }]]);
  const s = await bridge.searchMemories('复盘', 'deskpal-tito', 5);
  ok(s.ok, 'search ok');
  eq(s.items, ['用户在复盘会学到倾听'], 'recall 结果也过本地 L1');
  const legacy = await bridge.recall('复盘', 5);
  ok(Array.isArray(legacy) && legacy.length === 1, 'recall() 旧签名仍返回字符串数组');
  stubFetch([[/memories\/recall$/, new TypeError('fetch failed')]]);
  const down = await bridge.searchMemories('复盘', 'deskpal-tito', 5);
  ok(!down.ok && down.down === true, '网络不可达标记 down=true');
  eq((await bridge.recall('复盘', 5)).length, 0, 'recall() 网络失败静默返回 []（聊天主流程不阻塞）');
  restoreFetch();
}

// ============ 5. status 动作 ============
section('工具 status：链路健康与库概况');
{
  stubFetch([
    [/__proxy\/health$/, { body: { proxy: 'ok', upstream: 'ok', l2: 'ok', stats: {} } }],
    [/v1\/default\/banks\?/, { body: { banks: [
      { bank_id: '_canary', fact_count: 7, last_write_at: '2026-10-25T18:10:29Z' },
      { bank_id: 'deskpal-tito', fact_count: 1150, last_write_at: '2026-10-25T17:54:02Z' },
      { bank_id: 'hermes-main', fact_count: 399, last_write_at: '2026-10-20T17:55:18Z' },
      { bank_id: '_eval', fact_count: 42, last_write_at: '2026-10-13T18:22:53Z' },
    ] } }],
  ]);
  const out = await H({ action: 'status' });
  ok(out.includes('代理 正常') && out.includes('上游 hindsight-api 正常') && out.includes('L2 语义过滤 正常'), '三段链路状态如实呈现');
  ok(out.includes('deskpal-tito｜1150 条'), '条数如实引用');
  ok(out.includes('hermes-main｜399 条｜') && out.includes('✓可读'), '可读库标 ✓');
  ok(out.includes('写入只允许 deskpal-tito'), '写隔离声明在场');
  stubFetch([[/.*/, new TypeError('fetch failed')]]);
  const outDown = await H({ action: 'status' });
  ok(outDown.includes('不可达') && outDown.includes('hindsight-service.bat') && outDown.includes('不要编造'), '服务未运行→诚实降级+启动指引+禁编造');
  restoreFetch();
}

// ============ 6. list 动作 ============
section('工具 list：跨库各取最新、单库、白名单外拒绝');
{
  stubFetch([
    [/banks\/deskpal-tito\/memories\/list/, { body: { items: [{ text: '缇托库最新一条', metadata: { attribution: 'user' }, state: 'valid', occurred_start: '2026-10-25T00:00:00+00:00' }] } }],
    [/banks\/hermes-main\/memories\/list/, { body: { items: [{ text: 'main 库最新一条', metadata: { attribution: 'user' }, state: 'valid', occurred_start: '2026-10-20T00:00:00+00:00' }] } }],
    [/banks\/hermes-clio\/memories\/list/, { body: { items: [{ text: 'clio 库最新一条', metadata: { attribution: 'user' }, state: 'valid', occurred_start: '2026-10-23T00:00:00+00:00' }] } }],
  ]);
  const out = await H({ action: 'list', bank: 'all', limit: 5 });
  ok(out.includes('[deskpal-tito]') && out.includes('[hermes-main]') && out.includes('[hermes-clio]'), '跨库行带 [bank] 前缀');
  const order = [out.indexOf('[deskpal-tito]'), out.indexOf('[hermes-clio]'), out.indexOf('[hermes-main]')];
  ok(order.every(i => i >= 0) && order[0] < order[1] && order[1] < order[2], '按条目时间倒序（tito→clio→main 依次出现）');
  ok(out.includes('只读不可写'), '跨库尾部声明 hermes 只读');
  const out2 = await H({ action: 'list', bank: 'all', limit: 2 });
  eq((out2.match(/^- \[/gm) || []).length, 2, 'limit 截断跨库条数');
  const denied = await H({ action: 'list', bank: '_eval' });
  ok(denied.includes('不在可读清单') && denied.includes('readBanks'), '白名单外库被拒并指引配置');
  const single = await H({ action: 'list' });
  ok(single.includes('[deskpal-tito]') && single.includes('缇托库最新一条'), 'bank 缺省=自己的库');
  stubFetch([[/memories\/list/, { body: { items: [] } }]]);
  const empty = await H({ action: 'list', bank: 'hermes-clio' });
  ok(empty.includes('没有可展示的干净条目') && empty.includes('不要编造'), '空库→如实告知禁编造');
  stubFetch([[/memories\/list/, new TypeError('fetch failed')]]);
  const downList = await H({ action: 'list', bank: 'deskpal-tito' });
  ok(downList.includes('获取失败') && downList.includes('hindsight-service.bat'), 'list 服务未运行→降级提示');
  restoreFetch();
}

// ============ 7. search 动作与只读性 ============
section('工具 search：query 必填、结果格式、全动作零写入');
{
  let threw = false;
  try { await H({ action: 'search' }); } catch (_) { threw = true; }
  ok(threw, 'search 缺 query 抛参数错误');
  stubFetch([[/memories\/recall$/, { body: { results: [{ text: '用户的复盘方法论：先事实后感受', metadata: { attribution: 'user' } }] } }]]);
  const out = await H({ action: 'search', query: '复盘 方法论', limit: 3 });
  ok(out.includes('「复盘 方法论」') && out.includes('用户的复盘方法论'), '检索词与命中条目都呈现');
  ok(out.includes('过滤代理'), '标注结果经代理过滤');
  stubFetch([[/memories\/recall$/, new TypeError('This operation was aborted')]]);
  const outDown = await H({ action: 'search', query: '复盘' });
  ok(outDown.includes('检索失败') && outDown.includes('hindsight-service.bat'), 'search 超时→降级提示（abort 也算 down）');
  // 只读铁律：三个动作全程 retain 不被调用（save_memory 写入面不受影响）
  let retainCalls = 0;
  const origRetain = bridge.retain;
  bridge.retain = async () => { retainCalls++; return true; };
  await H({ action: 'status' });
  await H({ action: 'list', bank: 'all' });
  await H({ action: 'search', query: 'x' });
  bridge.retain = origRetain;
  eq(retainCalls, 0, 'status/list/search 全程零 retain（deep_memory 纯只读）');
  restoreFetch();
}

// ============ 8. 失败记账 ============
section('桥接失败记账：失败递增、成功归零');
{
  stubFetch([[/memories\/list/, new TypeError('fetch failed')]]);
  await bridge.listMemories('deskpal-tito', 3);
  const f1 = bridge.status().failCount;
  await bridge.listMemories('deskpal-tito', 3);
  ok(bridge.status().failCount > f1, '连续失败计数递增');
  stubFetch([[/memories\/list/, { body: { items: [] } }]]);
  await bridge.listMemories('deskpal-tito', 3);
  eq(bridge.status().failCount, 0, '一次成功即归零');
  restoreFetch();
}

restoreFetch();
store.flushAll();
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}

console.log(`\n===== test-deep-memory：${passed} 通过，${failed} 失败 =====`);
if (failed) process.exit(1);
})().catch(e => { console.error('测试脚本异常：', e); process.exit(1); });
