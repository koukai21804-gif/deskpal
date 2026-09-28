// 用户身份档案离线测试：分层存储 / prompt 注入 / 漂移落档 / P0 锁定 /
// 节奏阈值 / 回滚 / 面板保存清洗 / fs-guard 拒写 / 斜杠命令。
// 用法：node scripts/test-user-profile.js（纯 Node；LLM 漂移提取用桩）
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-profile-test-'));
const store = require(path.join(ROOT, 'src/main/services/store'));
store.init(TMP);
const guard = require(path.join(ROOT, 'src/main/services/fs-guard'));
guard.setWriteMode('userData');
const llm = require(path.join(ROOT, 'src/main/services/llm'));
const userProfile = require(path.join(ROOT, 'src/main/services/user-profile'));
const prompts = require(path.join(ROOT, 'src/main/services/prompts'));

async function main() {
  // ============ 1. 默认值与斜杠命令 ============
  section('默认值与斜杠命令');
  {
    const d = userProfile.get();
    eq(d.enabled, true, '默认注入开启');
    eq(d.drift, true, '默认漂移开启');
    eq(d.P0, '', 'P0 默认空');
    ok(userProfile.isProfileCommand('/user profile'), '识别 /user profile');
    ok(userProfile.isProfileCommand('/USER   PROFILE'), '大小写与多空格容忍');
    ok(!userProfile.isProfileCommand('/user profiles'), '近似命令不误识别');
  }

  // ============ 2. prompt 注入 ============
  section('prompt 注入（分层挂载）');
  {
    ok(!prompts.roleplaySystem().includes('用户身份档案'), '空档案不注入空段');
    userProfile.saveDoc({ P0: '示例用户，某市，测试身份锚', P2: { 当前项目: '项目A；deskpal 桌宠' }, P3: { 约定: '导出文档须附说明' } });
    const sys = prompts.roleplaySystem();
    ok(sys.includes('【用户身份档案'), '有档案时注入身份档案段');
    ok(sys.includes('[P0 身份锚——任何对话必须正确]'), 'P0 锚段注入');
    ok(sys.includes('当前项目：项目A；deskpal 桌宠'), 'P2 键值注入');
    ok(sys.includes('[P3 关系档案（你们之间）]'), 'P3 段注入');
    ok(sys.includes('以用户当下所说的为准'), '含使用守则（漂移诚实口径）');
    userProfile.saveDoc({ enabled: false, P0: 'x' });
    ok(!prompts.roleplaySystem().includes('用户身份档案'), 'enabled=false 不注入');
    userProfile.saveDoc({ enabled: true, P0: '示例用户，某市' }); // 还原
  }

  // ============ 3. 漂移提取（LLM 桩）→ 落档 → 日志 ============
  section('漂移提取与落档');
  {
    // 重建带种子的档案（saveDoc 是面板语义的整档替换，上一节的 saveDoc 已把 P2 清空）
    userProfile.saveDoc({ P0: '示例用户，某市，测试身份锚', P2: { 当前项目: '项目A；deskpal 桌宠' }, P3: { 约定: '导出文档须附说明' } });
    // 塞对话历史（漂移读 chats/roleplay 最近 20 条）
    store.replace('chats/roleplay', {
      messages: [
        { role: 'user', content: 'deskpal 刚发了 0.4.0-dev 版，联网搜索功能上线了。' },
        { role: 'assistant', content: '太好了，恭喜前辈！' },
      ],
    });
    llm.genericCompletion = async () => JSON.stringify([
      { layer: 'P2', key: '当前项目', value: '项目A + deskpal 0.4.0（联网搜索已上线）', quote: 'deskpal 刚发了 0.4.0-dev 版', reason: '项目版本变化' },
      { layer: 'P0', key: '所在地', value: '上海', quote: '（不该出现）', reason: '越权' },
      { layer: 'P9', key: '坏层级', value: 'x', quote: '', reason: '非法' },
    ]);
    userProfile.bump(); userProfile.bump(); // force 门槛：≥2 条新消息
    const r = await userProfile.tick(true);
    eq(r.changed, 1, '仅合法 P2 变更生效（1/3 条）');
    const d = userProfile.get();
    eq(d.P2['当前项目'], '项目A + deskpal 0.4.0（联网搜索已上线）', 'P2 字段被漂移更新');
    const log = d.log;
    eq(log.length, 3, '全部提案落日志（含未生效）');
    const p0e = log.find(e => e.layer === 'P0');
    eq(p0e.applied, false, 'P0 提案被拒');
    ok(/P0 身份锚锁定/.test(p0e.note), 'P0 拒绝原因可审计');
    const p9e = log.find(e => e.layer === 'P9');
    eq(p9e.applied, false, '非法层级被拒');
    const applied = log.find(e => e.applied);
    eq(applied.old, '项目A；deskpal 桌宠', '旧值快照入日志');
    eq(applied.quote, 'deskpal 刚发了 0.4.0-dev 版', '用户原话依据入日志');
    eq(d.driftCountSince, 0, '漂移后计数清零');

    // LLM 返回空数组 → 无变更
    llm.genericCompletion = async () => '[]';
    userProfile.bump(); userProfile.bump(); userProfile.bump();
    userProfile.bump(); userProfile.bump(); userProfile.bump();
    const r2 = await userProfile.tick();
    eq(r2.changed, 0, '无变更提案 → 0 变更');

    // LLM 抛错 → 不炸、有 error 返回、档案不动（计数先 bump 再快照——bump 本身是合法变更）
    llm.genericCompletion = async () => { throw new Error('接口 429'); };
    userProfile.bump(); userProfile.bump(); // force 门槛
    const before = JSON.stringify(userProfile.get());
    const r3 = await userProfile.tick(true);
    eq(r3.changed, 0, 'LLM 失败 0 变更');
    ok(r3.error, '失败原因返回');
    eq(JSON.stringify(userProfile.get()), before, 'LLM 失败档案不动');
  }

  // ============ 4. 节奏阈值 ============
  section('漂移节奏阈值');
  {
    let called = 0;
    llm.genericCompletion = async () => { called++; return '[]'; };
    // 上节失败后 driftCountSince 已被清？失败路径不清零（只有成功路径清零）——先看当前值
    userProfile.saveDoc({ ...userProfile.get(), driftCountSince: 0 });
    userProfile.bump();
    ok((await userProfile.tick()) === false, '1 条新消息不触发（未达节奏阈值直接跳过）');
    eq(called, 0, '未达阈值不烧 LLM 调用');
    for (let i = 0; i < 5; i++) userProfile.bump();
    await userProfile.tick();
    eq(called, 1, '满 6 条触发一次漂移');
    // drift=false 总开关
    userProfile.saveDoc({ ...userProfile.get(), drift: false });
    for (let i = 0; i < 6; i++) userProfile.bump();
    ok((await userProfile.tick()) === false, 'drift=false 不漂移（直接跳过）');
    eq(called, 1, 'drift=false 未调 LLM');
    userProfile.saveDoc({ ...userProfile.get(), drift: true, driftCountSince: 0 });
    // force 门槛：0 条新消息
    llm.genericCompletion = async () => { called++; return '[]'; };
    await userProfile.tick(true);
    eq(called, 1, 'force 但 0 条新消息不空跑（面板打开成本控制）');
    userProfile.bump(); userProfile.bump();
    await userProfile.tick(true);
    eq(called, 2, 'force 且 ≥2 条新消息补跑');
  }

  // ============ 5. 回滚 ============
  section('漂移回滚');
  {
    userProfile.saveDoc({ P0: '锚', P2: { 里程碑: '首笔 ≥500 元' } });
    // 漂移一条：覆盖已有字段（old 非 null）
    llm.genericCompletion = async () => JSON.stringify([{ layer: 'P2', key: '里程碑', value: '首笔已达成 800 元', quote: '首笔 800 到账了', reason: '首笔收入' }]);
    userProfile.bump(); userProfile.bump();
    await userProfile.tick(true);
    eq(userProfile.get().P2['里程碑'], '首笔已达成 800 元', '漂移覆盖成功');
    const entry = userProfile.get().log.find(e => e.applied && e.key === '里程碑');
    ok(entry && entry.old === '首笔 ≥500 元', '覆盖型变更留旧值');
    await userProfile.revert(entry.id);
    eq(userProfile.get().P2['里程碑'], '首笔 ≥500 元', '回滚恢复旧值');
    ok(userProfile.get().log.find(e => e.id === entry.id).revertedAt, '日志标记已回滚');

    // 新增型变更（old=null）回滚 → 字段删除
    llm.genericCompletion = async () => JSON.stringify([{ layer: 'P3', key: '新约定', value: '每周五一起复盘', quote: '我们约定每周五复盘', reason: '新约定' }]);
    userProfile.bump(); userProfile.bump();
    await userProfile.tick(true);
    ok(userProfile.get().P3['新约定'] === '每周五一起复盘', '新增字段漂移成功');
    const e2 = userProfile.get().log.filter(e => e.applied && e.key === '新约定').pop();
    eq(e2.old, null, '新增型 old=null');
    await userProfile.revert(e2.id);
    eq(userProfile.get().P3['新约定'], undefined, '新增型回滚删除字段');

    // 被后续覆盖 → 拒绝一键回滚
    llm.genericCompletion = async () => JSON.stringify([{ layer: 'P2', key: '里程碑', value: '累计 5000 元', quote: '累计破 5000 了', reason: '收入里程碑' }]);
    userProfile.bump(); userProfile.bump();
    await userProfile.tick(true);
    llm.genericCompletion = async () => JSON.stringify([{ layer: 'P2', key: '里程碑', value: '累计 2 万元', quote: '累计 2 万了', reason: '收入里程碑' }]);
    userProfile.bump(); userProfile.bump();
    await userProfile.tick(true);
    // 只看真正的漂移条目（revert 的记账条目 source=user 也带 applied:true，须排除）
    const older = userProfile.get().log.filter(e => e.applied && !e.revertedAt && e.source === 'drift' && e.key === '里程碑')[0];
    let threw = '';
    try { await userProfile.revert(older.id); } catch (err) { threw = err.message; }
    ok(/被后续更新覆盖/.test(threw), '被覆盖的旧变更拒绝回滚（防误伤新值）');
    // 双重回滚拒绝
    try { await userProfile.revert('nope'); threw = 'no'; } catch (err) { threw = err.message; }
    ok(/找不到/.test(threw), '不存在的日志 id 报错');
  }

  // ============ 6. 面板保存清洗 ============
  section('面板保存清洗');
  {
    const saved = userProfile.saveDoc({
      P0: '  示例用户，某市  ',
      P1: { '': '空键被清', 好键: ' 值首尾空格被清 ', 超长键名超过十二个字符的情况: 'v' },
      P2: Object.fromEntries(Array.from({ length: 36 }, (_, i) => ['k' + i, 'v' + i])),
    });
    eq(saved.P0, '示例用户，某市', 'P0 首尾空格清洗');
    eq(saved.P1[''], undefined, '空键被清');
    eq(saved.P1['好键'], '值首尾空格被清', '值清洗');
    eq(Object.keys(saved.P1).length, 2, '超长键截断后仍唯一（12字内）');
    eq(Object.keys(saved.P2).length, 30, '层键数上限 30（分层容量）');
  }

  // ============ 6.5 预填导入（applySeed：fill-empty，已有值一律保留） ============
  section('预填导入 applySeed');
  {
    userProfile.saveDoc({ P0: '', P1: { 沟通偏好: '已有值，不许被预填覆盖' }, P2: {}, P3: {} });
    const seed = {
      P0: '示例用户，某省某市',
      P1: { 沟通偏好: '预填版本', 决策偏好: '理性优先' },
      P2: { 当前项目: '项目A + deskpal' },
      P3: { 相处仪式: '早安晚安问候' },
    };
    const r = userProfile.applySeed(seed);
    const d = userProfile.get();
    eq(r.added.P0, 1, '空 P0 被预填');
    eq(d.P0, '示例用户，某省某市', 'P0 预填内容正确');
    eq(d.P1['沟通偏好'], '已有值，不许被预填覆盖', '已有字段不被覆盖（fill-empty）');
    eq(d.P1['决策偏好'], '理性优先', '新字段被补入');
    ok(r.added.P1 === 1 && r.added.P2 === 1 && r.added.P3 === 1, '各层新增计数正确');
    // 重复运行：全部已存在 → 零新增、内容不变（幂等）
    const before = JSON.stringify(d);
    const r2 = userProfile.applySeed(seed);
    eq(r2.added.P1 + r2.added.P2 + r2.added.P3 + r2.added.P0, 0, '重复导入零新增（幂等）');
    eq(JSON.stringify(userProfile.get()), before, '重复导入内容不变');
    // 种子文件冒烟（外置 JSON，只放本机 gitignore 目录；不入库、不打包、不上传）
    const seedFile = path.join(ROOT, 'docs', 'profile-seed.json');
    if (fs.existsSync(seedFile)) {
      const extSeed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
      const counts = { P1: Object.keys(extSeed.P1 || {}).length, P2: Object.keys(extSeed.P2 || {}).length, P3: Object.keys(extSeed.P3 || {}).length };
      ok(counts.P1 >= 0 && counts.P2 >= 0 && counts.P3 >= 0, `外置种子规模：P1 ${counts.P1}/P2 ${counts.P2}/P3 ${counts.P3}`);
      const vals = [...Object.values(extSeed.P1 || {}), ...Object.values(extSeed.P2 || {}), ...Object.values(extSeed.P3 || {})];
      ok(vals.every(v => String(v).length <= 240), '全部字段值 ≤240 字（不被清洗截断）');
      ok(Object.keys(extSeed.P1 || {}).concat(Object.keys(extSeed.P2), Object.keys(extSeed.P3)).every(k => String(k).length <= 12), '全部键名 ≤12 字');
    } else {
      console.log('  ⚠ docs/profile-seed.json 不存在（种子文件不入库），跳过外置种子冒烟');
    }
  }

  // ============ 6.6 注入预算闸（超限按 P3→P2→P1 截断并注明） ============
  section('注入预算闸');
  {
    const big = (n, pfx) => Object.fromEntries(Array.from({ length: n }, (_, i) => [pfx + i, '长'.repeat(200)]));
    userProfile.saveDoc({ P0: '锚'.repeat(1100), P1: big(25, 'p1k'), P2: big(15, 'p2k'), P3: big(5, 'p3k') });
    const sys = prompts.roleplaySystem();
    ok(!sys.includes('[P3 关系档案'), '超预算时 P3 整层弃置');
    ok((sys.match(/- p2k\d+/g) || []).length === 12, 'P2 截到 12 字段');
    ok((sys.match(/- p1k\d+/g) || []).length === 20, 'P1 截到末档 20 字段（P0 永不截断）');
    ok(sys.includes('超出注入预算'), '截断显式注明（不静默丢字段）');
    ok(sys.includes('[P0 身份锚') && sys.includes('锚'.repeat(1100).slice(0, 100)), 'P0 身份锚永不截断');
    const block = sys.slice(sys.indexOf('【用户身份档案'));
    ok(block.length <= 10500, `档案段 ≤ 末档硬顶（实际 ${block.length} 字符 ≈ ${Math.round(block.length / 2)} token）`);
    // 常规规模（真实种子大小）不触发截断
    userProfile.saveDoc({ P0: '示例用户，某市', P1: { a: 'x'.repeat(60), b: 'y'.repeat(60) }, P2: { c: 'z'.repeat(60) }, P3: { d: 'w'.repeat(60) } });
    ok(prompts.roleplaySystem().includes('[P3 关系档案'), '常规规模 P3 正常注入');
  }

  // ============ 7. fs-guard 拒写身份档案 ============
  section('fs-guard 身份档案拒写');
  {
    const p = path.join(store.getDataDir(), 'user', 'profile.json');
    ok(guard.canWrite(p) === false, 'userData 模式下 user/profile.json 不可写');
    guard.setWriteMode('full');
    ok(guard.canWrite(p) === false, 'full 模式下同样不可写');
    guard.setWriteMode('userData');
    ok(guard.canWrite(path.join(store.getDataDir(), 'user', 'notes.md')) === true, 'user 目录普通文件不受影响');
  }

  // ============ 8. 漂移提取 prompt 契约 ============
  section('漂移提取 prompt 契约');
  {
    const p = prompts.userProfileDriftPrompt({ P0: '测试锚', P1: { 雷区: '贴标签' }, P2: {}, P3: {} }, '用户: 测试');
    ok(p.includes('锁定') && p.includes('绝对不允许输出 P0'), 'P0 锁定指令明确');
    ok(p.includes('更新触发器'), '含更新触发器表');
    ok(p.includes('只依据用户亲口所说'), '剧情虚构排除');
    ok(p.includes('"layer":"P1|P2|P3"'), '输出格式契约');
  }

  console.log(`\n========== 测试结果：${passed} 通过 / ${failed} 失败 ==========`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('测试脚本异常：', e && (e.stack || e.message)); process.exit(2); });
