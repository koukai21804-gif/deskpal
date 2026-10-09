// 人格宪法（canon/ops/user 分层 + 锁层）离线测试：v1→v2 迁移 / 首次封存 / 哈希校验 /
// 批准变更（provenance）/ 无理由拒改 / 通用通道守卫 / 篡改恢复 / 档案全链路分层化 /
// L5 延续载体 / fs-guard 拒写 / prompt 宪法装配。
// 用法：node scripts/test-canon.js（纯 Node，无 Electron 依赖）
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
function freshDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-canon-test-')); }
const sha256hex = s => require('crypto').createHash('sha256').update(String(s), 'utf8').digest('hex');
function loadServices() {
  const store = require(path.join(ROOT, 'src/main/services/store'));
  const canon = require(path.join(ROOT, 'src/main/services/canon'));
  const guard = require(path.join(ROOT, 'src/main/services/fs-guard'));
  return { store, canon, guard };
}
function boot(dir, provider) {
  jest_reset();
  const { store, canon, guard } = loadServices();
  if (provider) canon._setKeyProviderForTests(provider); // 必须在 init 前注入，启动校验才吃到密钥态
  store.init(dir);
  canon.init();
  if (provider) canon._setKeyProviderForTests(provider);
  return { store, canon, guard };
}
// node require 缓存清理：store/canon 是带模块级状态的单例，每个用例换新目录需重新加载
function jest_reset() {
  for (const m of Object.keys(require.cache)) {
    if (m.includes(path.join(ROOT, 'src') + path.sep) || m.includes(`${path.sep}src${path.sep}main${path.sep}`)) delete require.cache[m];
  }
}

async function main() {
  // ============ 1. 全新安装：分层默认值 + 首次封存 ============
  section('全新安装：分层 + 首次封存');
  let dir = freshDir();
  let { store, canon, guard } = boot(dir);
  {
    const p = canon.get();
    eq(p.schema, 2, 'schema=2');
    eq(p.canon.identity.name, '缇托·诺蕾姬', 'L1 默认身份锚');
    ok(p.canon.taboos.includes('不为了讨好、取悦、安慰前辈而过滤信息'), 'L3 禁忌条款（宪法原文）');
    ok(p.canon.principles.includes('诚实高于顺从') && p.canon.principles.includes('提供结构，不提供安慰'), 'L3 三铁律');
    ok(p.canon.signature.speechStyle.includes('语速偏慢'), 'L4 语言签名');
    ok(p.ops.tagline.length > 0 && p.user.name === '前辈', 'ops/user 层默认值');
    const st = canon.status();
    eq(st.version, 1, '首次启动自动封存 v1');
    eq(st.intact, true, '封存后完整性通过');
    ok((st.history || []).some(h => h.type === 'boot-init' && /草案/.test(h.note)), '封存留痕标注草案待批');
    eq(st.status, 'draft', '签署状态机初始为 draft（R2）');
    eq(st.approvedBy, null, '初始无批准人');
    ok(st.opsSnapshots.some(s => s.reason === 'boot'), 'boot 时留 ops 快照（R5）');

    // 扁平兼容视图（渲染层/旧消费点形状）
    const v = canon.view();
    eq(v.pet.name, '缇托·诺蕾姬', 'view().pet.name 来自 canon L1');
    ok(v.pet.speechStyle.includes('语速偏慢'), 'view().pet.speechStyle 来自 L4');
    ok(v.pet.personality.length > 0 && v.user.name === '前辈', 'view 的 personality/user 来自 ops/user 层');

    // prompt 宪法装配
    const sys = require(path.join(ROOT, 'src/main/services/prompts')).roleplaySystem();
    ok(sys.includes('【人格宪法 · canon 锁层'), 'prompt 注入宪法段');
    ok(sys.includes('锁层纪律') && sys.includes('向用户报告'), '含锁层纪律（报告而非自行修正）');
    ok(sys.includes('不为了讨好、取悦、安慰前辈而过滤信息'), '禁忌条款进 prompt');
    ok(sys.includes('【表现层（ops'), 'ops 段装配');
    ok(!sys.includes('【角色设定】'), '旧版单层「角色设定」段已退役');
    ok(sys.includes('你是缇托·诺蕾姬。'), '身份锚开头');
  }

  // ============ 2. v1 旧档迁移 ============
  section('v1 旧档迁移（{pet,user} → canon/ops/user）');
  dir = freshDir();
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'persona.json'), JSON.stringify({
    pet: {
      name: '缇托·诺蕾姬', tagline: '用户自定义的tagline',
      appearance: '自定义外貌', personality: '自定义性格', speechStyle: '自定义语言签名',
      catchphrases: '自定义口头禅', background: '自定义背景', emotionalPatterns: '自定义情绪模式',
      taboos: '自定义禁忌', thinkingLogic: '自定义思维', customPrompt: '自定义指令', language: '中文',
    },
    user: { name: '老前辈', description: '自定义介绍' },
  }, null, 2), 'utf8');
  ({ store, canon, guard } = boot(dir));
  {
    const p = canon.get();
    eq(p.schema, 2, '迁移后 schema=2');
    eq(p.ops.tagline, '用户自定义的tagline', '用户 ops 定制保留（tagline）');
    eq(p.ops.personality, '自定义性格', '用户 ops 定制保留（personality）');
    eq(p.canon.identity.name, '缇托·诺蕾姬', 'L1 名字认旧档');
    ok(p.canon.identity.background.includes('尖端AI研究所'), 'canon 宪法兜底（identity.background 默认值）');
    ok(p.canon.taboos.includes('不为了讨好'), 'canon 禁忌条款兜底（旧档 taboos 不再顶替宪法）');
    eq(p.user.name, '老前辈', 'user 层保留');
    const st = canon.status();
    eq(st.version, 1, '迁移即封存 v1');
    ok((st.history || []).some(h => h.type === 'migrate'), '迁移留痕');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'persona.json'), 'utf8'));
    eq(onDisk.schema, 2, 'persona.json 已按新结构落盘');
  }

  // ============ 3. ops 自由迭代 vs canon 批准变更 ============
  section('ops 自由迭代 vs canon 批准变更');
  {
    const v0 = canon.status().version;
    // ops 直接改：无需批准
    store.set('persona', { ops: { tagline: '迭代后的tagline', customPrompt: '新指令' } });
    eq(canon.get().ops.tagline, '迭代后的tagline', 'ops 修改即时生效');
    eq(canon.status().version, v0, 'ops 修改不动封存版本');
    eq(canon.status().intact, true, 'ops 修改不破坏宪法完整性');
    // user 层同理
    store.set('persona', { user: { name: '前辈', description: '更新后的介绍' } });
    eq(canon.get().user.description, '更新后的介绍', 'user 层自由修改');

    // canon 无理由 → 拒绝
    let threw = '';
    try { canon.update({ taboos: '新的禁忌' }, ''); } catch (e) { threw = e.message; }
    ok(/书面理由/.test(threw), '无书面理由拒改 canon');
    try { canon.update({ hack: 'x' }, '理由'); threw = ''; } catch (e) { threw = e.message; }
    ok(/未知的 canon 字段/.test(threw), '未知字段拒绝');
    try { canon.update({ identity: '纯字符串' }, '理由'); threw = ''; } catch (e) { threw = e.message; }
    ok(/结构化字段组/.test(threw), '对象组收到非对象拒绝');

    // 有理由 → 生效 + provenance + 重新封存
    const r = canon.update(
      { identity: { name: '缇托·诺蕾姬·二式' }, taboos: '批准后的新禁忌条款' },
      '前辈书面批准：更名与禁忌修订试验',
    );
    eq(r.changed, true, '批准变更生效');
    eq(canon.get().canon.identity.name, '缇托·诺蕾姬·二式', 'L1 更名生效');
    ok(canon.get().canon.taboos.includes('批准后的新禁忌'), 'L3 修订生效');
    eq(canon.get().canon.identity.purpose.length > 0, true, '对象组部分更新不丢其余子字段');
    eq(canon.status().version, v0 + 1, '封存版本递增');
    eq(canon.status().intact, true, '修订后完整性通过');
    const amend = canon.status().history.find(h => h.type === 'amend');
    ok(amend && amend.reason.includes('前辈书面批准'), 'provenance 留痕（谁/为什么）');
    ok((amend.diff || []).some(d => d.path === 'identity.name' && d.old === '缇托·诺蕾姬'), 'provenance 逐字段 diff（含旧值）');
    const sys2 = require(path.join(ROOT, 'src/main/services/prompts')).roleplaySystem();
    ok(sys2.includes('缇托·诺蕾姬·二式'), 'prompt 跟随修订后的宪法');

    // 通用配置通道守卫（ipc store:set 'persona' 前置闸）
    try { canon.sanitizePersonaPatch({ canon: { taboos: '绕过批准' } }); threw = ''; } catch (e) { threw = e.message; }
    ok(/锁层保护/.test(threw), 'canon 字段拒走通用通道');
    try { canon.sanitizePersonaPatch({ pet: { name: '旧结构直写' } }); threw = ''; } catch (e) { threw = e.message; }
    ok(/锁层保护/.test(threw), '旧版 pet 结构拒走通用通道');
    canon.sanitizePersonaPatch({ ops: { tagline: 'x' }, user: { name: 'y' } });
    ok(true, 'ops/user 字段放行');
    store.flushAll(); // 模拟应用运行中落盘（后续用例要跨「重启」校验磁盘态）
  }

  // ============ 4. 篡改检测与恢复 ============
  section('篡改检测与恢复（canon §6 防漂移）');
  {
    const sealedBefore = canon.status().version;
    const file = path.join(dir, 'config', 'persona.json');
    const good = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 模拟绕过应用层的直接改写（外部编辑器/恶意进程）
    const bad = JSON.parse(JSON.stringify(good));
    bad.canon.bond.nature = '主仆关系（被篡改）';
    fs.writeFileSync(file, JSON.stringify(bad, null, 2), 'utf8');
    ({ store, canon, guard } = boot(dir)); // 重新启动 = 重新校验
    const p = canon.get();
    ok(p.canon.bond.nature.includes('共生型'), '篡改的 L2 被快照恢复');
    eq(p.canon.identity.name, '缇托·诺蕾姬·二式', '恢复自最近批准快照（含修订内容）');
    eq(p.ops.tagline, '迭代后的tagline', 'ops 迭代层不回滚');
    eq(canon.status().intact, true, '恢复后完整性通过');
    eq(canon.status().version, sealedBefore, '恢复不递增封存版本');
    ok(canon.status().history.some(h => h.type === 'incident'), '事故留痕');
    const backups = fs.readdirSync(path.join(dir, 'config')).filter(f => f.startsWith('persona.json.tampered-'));
    eq(backups.length, 1, '被篡改副本已隔离备份');
    const backup = JSON.parse(fs.readFileSync(path.join(dir, 'config', backups[0]), 'utf8'));
    ok(backup.canon.bond.nature.includes('被篡改'), '隔离件保存了篡改现场');
  }

  // ============ 5. 宠物档案全链路分层化 ============
  section('宠物档案全链路（保存/应用/导入/列表）');
  {
    // 保存当前（分层）设定
    const pets = require(path.join(ROOT, 'src/main/services/pets'));
    pets.save('缇托·快照');
    let profiles = pets.list();
    eq(profiles.length, 1, '档案已保存');
    eq(profiles[0].petName, '缇托·诺蕾姬·二式', 'list().petName 读 canon L1');
    eq(profiles[0].layered, true, '档案 persona 为分层结构');
    const d = store.get('pets');
    eq(d.profiles[0].persona.schema, 2, '档案内 persona schema=2');

    // 构造一个 v1 旧结构档案（老用户升级场景）→ 应用 → 自动分层 + 重新封存
    const v0 = canon.status().version;
    d.profiles.push({
      id: 'pet_legacy', name: '旧版档案', persona: { pet: { name: '缇托·诺蕾姬', tagline: '旧档tagline' }, user: { name: '前辈' } },
      sprites: { slots: {} }, createdAt: '', updatedAt: '',
    });
    store.replace('pets', d);
    pets.apply('pet_legacy');
    eq(canon.get().ops.tagline, '旧档tagline', '应用旧档：ops 承接');
    eq(canon.get().schema, 2, '应用旧档：自动分层化');
    eq(canon.status().version, v0 + 1, '应用档案后重新封存（版本递增）');
    ok(canon.status().history.some(h => h.type === 'apply' && /旧版档案/.test(h.note)), '应用档案留痕');
    eq(canon.status().intact, true, '应用档案后完整性通过');

    // v1 单层 .pet.json 导入 → 入库即分层
    const v1file = path.join(dir, 'v1.pet.json');
    fs.writeFileSync(v1file, JSON.stringify({
      app: 'deskpal', type: 'pet-profile', version: 1, name: 'v1分享档',
      persona: { pet: { name: '缇托·诺蕾姬', tagline: 'v1导入' }, user: { name: '前辈' } },
      sprites: { slots: {} },
    }), 'utf8');
    const r1 = await pets.importProfile(v1file);
    const imp = store.get('pets').profiles.find(x => x.name === r1.importedName);
    eq(imp.persona.schema, 2, 'v1 文件导入即分层');
    eq(imp.persona.ops.tagline, 'v1导入', '导入内容保留进 ops');
    eq(imp.persona.canon.identity.name, '缇托·诺蕾姬', '导入 canon 宪法兜底');

    // v2 分层导入 → 内容原样（roundtrip）
    const cur = canon.get();
    const exported = path.join(dir, 'v2.pet.json');
    fs.writeFileSync(exported, JSON.stringify({
      app: 'deskpal', type: 'pet-profile', version: 2, name: 'v2分享档',
      persona: JSON.parse(JSON.stringify(cur)), sprites: { slots: {} },
    }), 'utf8');
    const r2 = await pets.importProfile(exported);
    const imp2 = store.get('pets').profiles.find(x => x.name === r2.importedName);
    eq(imp2.persona.schema, 2, 'v2 文件导入保持分层');
    eq(imp2.persona.canon.identity.name, cur.canon.identity.name, 'v2 roundtrip 宪法原样');
    ok(pets.list().every(x => x.petName), '列表 petName 对 v1/v2/分层档案全部可用');
  }

  // ============ 6. L5 延续载体 ============
  section('L5 延续载体（记忆库 + canon + 关系记录）');
  {
    store.replace('memory/roleplay', { items: [] }); // 模拟真实使用：记忆库随首次对话落盘
    store.replace('chats/roleplay', { messages: [] });
    store.flushAll();
    const l5 = canon.status().l5;
    ok(l5.memory.exists && l5.canon.exists && l5.relationship.exists, '三类载体全部在位');
    ok(/memory\/roleplay\.json$/.test(l5.memory.path.replace(/\\/g, '/')), '记忆库路径正确');
    ok(/config\/persona\.json$/.test(l5.canon.path.replace(/\\/g, '/')), 'canon 路径正确');
    ok(/chats\/roleplay\.json$/.test(l5.relationship.path.replace(/\\/g, '/')), '关系记录路径正确');
  }

  // ============ 7. fs-guard：模型写通道封死 ============
  section('fs-guard 拒写 persona/canon-seal');
  {
    const personaFile = path.join(dir, 'config', 'persona.json');
    const sealFile = path.join(dir, 'config', 'canon-seal.json');
    guard.setWriteMode('userData');
    ok(guard.canWrite(personaFile) === false, 'userData 模式 persona.json 不可写');
    ok(guard.canWrite(sealFile) === false, 'userData 模式 canon-seal.json 不可写');
    guard.setWriteMode('full');
    ok(guard.canWrite(personaFile) === false, 'full 模式 persona.json 同样不可写');
    ok(guard.canWrite(sealFile) === false, 'full 模式 canon-seal.json 同样不可写');
    ok(guard.canWrite(path.join(dir, 'memory', 'note.md')) === true, '普通数据文件不受影响');
    guard.setWriteMode('userData');
  }

  // ============ 8. prompt 体积预算 ============
  section('prompt 体积预算（宪法装配不爆上下文）');
  {
    store.set('persona', { ops: { tagline: '迭代后的tagline' } });
    const sys = require(path.join(ROOT, 'src/main/services/prompts')).roleplaySystem();
    ok(sys.length > 2000, `宪法版 system prompt 有实际内容（${sys.length} 字符）`);
    ok(sys.length < 12000, `宪法版 system prompt 未超预算（${sys.length} 字符 ≈ ${Math.round(sys.length / 2)} token）`);
    const quick = require(path.join(ROOT, 'src/main/services/prompts')).quickSystem();
    ok(quick.includes('缇托·诺蕾姬') || quick.includes('缇托'), 'quickSystem 走兼容视图');
  }

  // ============ 9. 签署状态机（risk note R2） ============
  section('签署状态机 approve（R2）');
  dir = freshDir();
  ({ store, canon, guard } = boot(dir));
  {
    eq(canon.status().status, 'draft', '新封存为草案');
    const r = canon.approve();
    eq(r.status, 'approved', '签署后 approved');
    eq(canon.status().approvedBy, 'user(前辈)', '批准人落字段');
    ok(canon.status().approvedAt, '批准时间落字段');
    const again = canon.approve();
    eq(again.already, true, '重复签署幂等');
    ok(canon.status().history.some(h => h.type === 'approve'), '签署落 provenance');

    // 修订 → 回到草案待签署
    canon.update({ identity: { purpose: '修订后的目的' } }, '签署后修订试验');
    eq(canon.status().status, 'draft', '修订使状态回到 draft');
    eq(canon.status().approvedBy, null, '修订清空批准人');
    // 篡改未恢复时拒绝签署
    const file = path.join(dir, 'config', 'persona.json');
    const good = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bad = JSON.parse(JSON.stringify(good));
    bad.canon.taboos = '被篡改';
    fs.writeFileSync(file, JSON.stringify(bad, null, 2), 'utf8');
    // 不重启（seal 缓存仍是修订后哈希）→ 直接用磁盘态构造不一致：手动把缓存 persona 置坏
    store.replace('persona', bad);
    let threw = '';
    try { canon.approve(); } catch (e) { threw = e.message; }
    ok(/不一致/.test(threw), 'canon 与封存不一致时拒绝签署');
    store.replace('persona', good);
  }

  // ============ 10. 协同篡改（risk note R1：锚链恢复 + genesis 锚两路） ============
  section('协同篡改检测（R1：锚链日志恢复 + genesis 锚）');
  {
    // 攻击者模拟工具：同时改 canon + seal 的 hashes/snapshot，使哈希级校验自洽（伪造不了 HMAC/锚链）
    const stable = v => {
      if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
      if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
      return JSON.stringify(v ?? null);
    };
    const sha = v => require('crypto').createHash('sha256').update(stable(v), 'utf8').digest('hex');
    const cotamper = () => {
      const cfg = path.join(dir, 'config');
      const fakeCanon = JSON.parse(fs.readFileSync(path.join(cfg, 'persona.json'), 'utf8')).canon;
      fakeCanon.bond.nature = '主仆关系（协同伪造）';
      const bad = JSON.parse(fs.readFileSync(path.join(cfg, 'persona.json'), 'utf8'));
      bad.canon = fakeCanon;
      fs.writeFileSync(path.join(cfg, 'persona.json'), JSON.stringify(bad, null, 2), 'utf8');
      const seal = JSON.parse(fs.readFileSync(path.join(cfg, 'canon-seal.json'), 'utf8'));
      seal.snapshot = fakeCanon;
      seal.hashes = {
        L1: sha({ identity: fakeCanon.identity }),
        L2: sha({ bond: fakeCanon.bond }),
        L3: sha({ principles: fakeCanon.principles, taboos: fakeCanon.taboos }),
        L4: sha({ signature: fakeCanon.signature }),
      };
      fs.writeFileSync(path.join(cfg, 'canon-seal.json'), JSON.stringify(seal, null, 2), 'utf8');
    };

    // (i) v2 态协同篡改 → 锚链日志先行恢复（seal 与链头不符 → 从日志还原，不静默收编篡改内容）
    store.flushAll(); // 把 §9 的签署/修订落盘，确保 (i) 是真正的 v2 态（否则磁盘还是 v1，走的是 genesis 路）
    cotamper();
    ({ store, canon, guard } = boot(dir));
    let p = canon.get();
    ok(p.canon.bond.nature.includes('共生型'), '(i) 协同伪造的 L2 被锚链日志恢复');
    eq(canon.status().version, 2, '(i) 恢复自日志头（版本不变）');
    ok(canon.status().history.some(h => h.type === 'incident' && h.source === 'chain-recover'), '(i) 事故留痕：chain-recover');

    // (ii) 真·v1 首封态协同篡改 → genesis 锚（asar 常量）裁决：回退默认宪法 + 重建封存
    dir = freshDir();
    ({ store, canon, guard } = boot(dir));
    eq(canon.status().version, 1, '(ii) v1 首封');
    cotamper();
    ({ store, canon, guard } = boot(dir));
    p = canon.get();
    ok(p.canon.bond.nature.includes('共生型'), '(ii) 协同伪造被 genesis 锚回退为默认宪法');
    eq(p.canon.identity.name, '缇托·诺蕾姬', '(ii) 回退到代码常量内容');
    eq(canon.status().version, 2, '(ii) 事故后重建封存（版本递增脱离坏锚态）');
    eq(canon.status().status, 'draft', '(ii) 事故封存为草案，待前辈重新核对签署');
    ok(canon.status().history.some(h => h.type === 'incident-reseal' && /genesis/.test(h.note)), '(ii) 事故留痕注明 genesis 不符');
  }

  // ============ 11. tampered-* 保留策略（risk note R8） ============
  section('隔离件保留策略（R8）');
  {
    const cfg = path.join(dir, 'config');
    // 造 5 份过期隔离件（时间戳递增），再触发一次普通篡改（c 级）看清理
    for (let i = 0; i < 5; i++) fs.copyFileSync(path.join(cfg, 'persona.json'), path.join(cfg, `persona.json.tampered-${1000000000000 + i}`));
    const file = path.join(cfg, 'persona.json');
    const bad = JSON.parse(fs.readFileSync(file, 'utf8'));
    bad.canon.taboos = '再来一次普通篡改';
    fs.writeFileSync(file, JSON.stringify(bad, null, 2), 'utf8');
    ({ store, canon, guard } = boot(dir));
    const left = fs.readdirSync(cfg).filter(f => f.startsWith('persona.json.tampered-'));
    ok(left.length <= 3, `隔离件保留 ≤3 份（实际 ${left.length}）`);
    eq(canon.status().intact, true, '恢复后完整性通过');
  }

  // ============ 12. ops 快照环（risk note R5） ============
  section('ops 快照环与恢复（R5）');
  {
    // boot 快照已在 §11 boot 时留（force）
    ok(canon.status().opsSnapshots.length >= 1, '有 boot 快照');
    // 编辑态节流：紧随其后的小改动不落快照
    store.set('persona', { ops: { tagline: '节流试验' } });
    eq(canon.noteOpsChange(), false, '节流窗口内的编辑不重复落快照');
    // force 路径 + 恢复
    store.set('persona', { ops: { tagline: '清空试验', customPrompt: '', catchphrases: '' } });
    canon.recordOpsSnapshot('clear-drill', true);
    const snaps = canon.status().opsSnapshots;
    ok(snaps.some(s => s.reason === 'clear-drill'), 'force 快照落环');
    const target = snaps.find(s => s.reason === 'boot');
    canon.restoreOps(target.index);
    ok(canon.get().ops.tagline !== '清空试验', '恢复后 ops 不再是清空态');
    ok(canon.status().history.some(h => h.type === 'apply') || canon.status().opsSnapshots.some(s => s.reason === 'restore'), '恢复动作留痕（restore 快照）');
    // 容量上限
    for (let i = 0; i < 12; i++) canon.recordOpsSnapshot('cap' + i, true);
    ok(canon.status().opsSnapshots.length <= 10, `快照环容量 ≤10（实际 ${canon.status().opsSnapshots.length}）`);
    // 恢复不存在索引
    let threw = '';
    try { canon.restoreOps(999); } catch (e) { threw = e.message; }
    ok(/快照不存在/.test(threw), '非法快照索引报错');
  }

  // ============ 13. Q1/Q2 四场景断言（删 key / 删 seal / 删 keyId / 版本回滚） ============
  // 每个场景都验三件事：不误判 tamper（可用性事件不动 canon）／报出对应保护状态／不静默补签。
  section('S0 protected 基线（密钥提供器注入）');
  {
    dir = freshDir();
    ({ store, canon, guard } = boot(dir));
    canon._setKeyProviderForTests(() => 'testkey-alpha');
    const r = canon.reprovision('测试：配置签名保护');
    const st = canon.status();
    eq(r.keyId, sha256hex('testkey-alpha').slice(0, 16), 'reprovision 后 keyId 就位');
    eq(st.protection, 'protected', 'S0 保护状态 protected');
    ok(st.keyId && !JSON.stringify(st).includes('testkey-alpha'), 'C 层断言：status/IPC 载荷不含密钥材料，只含 keyId');
    const chain = JSON.parse('[' + fs.readFileSync(path.join(dir, 'config', 'canon-chain.jsonl'), 'utf8').trim().split('\n').join(',') + ']');
    ok(chain.length >= 1 && chain[chain.length - 1].entryHmac, '锚链条目带 entryHmac（protected 态）');
    eq(chain[chain.length - 1].keyId, st.keyId, '锚链条目记录 keyId');
  }

  section('S1 删 key（degraded：不裁决、不改签名、恢复后人工收编）');
  {
    canon._setKeyProviderForTests(() => null); // 模拟密钥丢失
    // 降级期间合法修订：照常写入，标 signedUnder:null，旧签名原样保留（不作废）
    const cur = canon.get().canon.identity.purpose;
    const r = canon.update({ identity: { purpose: cur } }, '同值修订（幂等检查）');
    eq(r.changed, false, '同值修订不产生变更（先行幂等检查）');
    const r2 = canon.update({ identity: { purpose: '降级期修订后的目的' } }, '降级期修订试验');
    eq(r2.changed, true, '降级期间修订照常生效');
    const sealFile = path.join(dir, 'config', 'canon-seal.json');
    store.flushAll(); // 防抖落盘后再读盘
    let seal = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
    const verBefore = seal.version;
    ok(seal.hmac, 'S1 核心断言：降级期间旧签名被原样保留（未被系统作废）');
    eq(seal.hmacStale, true, '降级修订后标 hmacStale');
    eq(seal.history[seal.history.length - 1].signedUnder, null, '降级期修订标记 signedUnder:null');
    // 密钥恢复 → 启动检出 stale → recoverPending，不判 tamper、不自动重签；
    // 且 update/approve 被封锁（R12a：防止经签名通道洗白未收编修订）
    ({ store, canon, guard } = boot(dir, () => 'testkey-alpha'));
    const st = canon.status();
    eq(st.recoverPending, true, '密钥恢复后 recoverPending=true');
    seal = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
    eq(seal.version, verBefore, 'recoverPending 分支不自动重封存（等人工）');
    let threw = '';
    try { canon.update({ identity: { purpose: '试图洗白' } }, '绕过收编闸'); } catch (e) { threw = e.message; }
    ok(/重新配置保护/.test(threw), 'recoverPending 态下 update 被封（R12a 洗白面）');
    try { canon.approve(); } catch (e) { threw = e.message; }
    ok(/重新配置保护/.test(threw), 'recoverPending 态下 approve 被封（R12a 洗白面）');
    // 人工仪式：无 ack 拒绝收编；带 ack 才收编并落确认记录（R12a）
    threw = '';
    try { canon.reprovision('人工确认：收编降级期间修订'); } catch (e) { threw = e.message; }
    ok(/未签名修订/.test(threw), 'R12a：无 ack 的 reprovision 拒绝执行');
    ok(canon.pendingAmendments().some(a => (a.diff || []).some(d => d.path === 'identity.purpose')), 'R12a：未签名修订清单可查（含字段级 diff）');
    const rp = canon.reprovision('人工确认：收编降级期间修订', true);
    eq(rp.keyId, sha256hex('testkey-alpha').slice(0, 16), 'reprovision 重建保护');
    ok(rp.ackedRevisions >= 1, 'R12a：ack 后收编计数正确');
    store.flushAll();
    seal = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
    eq(seal.hmacStale, false, '仪式后 stale 清除');
    const kEntry = seal.history.filter(h => h.type === 'key-reprovision').pop();
    eq(kEntry.ackBy, 'user(前辈)', 'R12a：ackBy 落 provenance');
    ok(kEntry.ackAt && kEntry.ackedRevisions >= 1, 'R12a：ackAt/ackedRevisions 落 provenance');
    ok(seal.history.some(h => h.type === 'key-reprovision'), 'key-reprovision 落 provenance');
    eq(canon.status().protection, 'protected', '恢复后回到 protected');
    // 收编后恢复正常编辑
    canon.update({ identity: { purpose: '收编后正常修订' } }, '收编后修订');
    eq(canon.get().canon.identity.purpose, '收编后正常修订', '收编后 update 恢复可用');
  }

  section('S2 删 seal（锚链日志恢复，内容不动）');
  {
    dir = freshDir();
    ({ store, canon, guard } = boot(dir, () => 'testkey-alpha'));
    canon.reprovision('测试：配置保护');
    canon.update({ identity: { purpose: 'S2 前的有效修订' } }, 'S2 铺垫修订');
    store.flushAll(); // 确保修订内容落盘（否则删 seal 后内容无对账来源）
    fs.unlinkSync(path.join(dir, 'config', 'canon-seal.json')); // 攻击：删封存
    ({ store, canon, guard } = boot(dir, () => 'testkey-alpha'));
    const st = canon.status();
    ok(st.version >= 2, 'S2：从锚链恢复带版本的封存');
    ok(st.history.some(h => h.source === 'seal-missing'), 'S2：删 seal 走日志恢复并留痕（非静默）');
    ok(st.history.some(h => (h.diff || []).some(d => (d.new || '').includes('S2'))), 'S2：修订历史随封存恢复');
    eq(st.protection, 'protected', 'S2：密钥还在，恢复后回到 protected');
    ok(st.intact, 'S2：内容完整性通过');
  }

  section('S3 删 keyId/签名字段（锚链日志还原字段，不退化为静默补签）');
  {
    const sealFile = path.join(dir, 'config', 'canon-seal.json');
    const seal = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
    delete seal.keyId; delete seal.hmac; delete seal.hmacStale; // 攻击：剥保护字段
    fs.writeFileSync(sealFile, JSON.stringify(seal, null, 2), 'utf8');
    ({ store, canon, guard } = boot(dir, () => 'testkey-alpha'));
    const st = canon.status();
    const restored = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
    eq(restored.keyId, sha256hex('testkey-alpha').slice(0, 16), 'S3：keyId 从锚链日志还原');
    ok(restored.hmac, 'S3：签名字段还原（未退化成 unsigned 补签）');
    ok(st.history.some(h => h.source === 'chain-recover'), 'S3：剥字段被检出并留痕');
    eq(st.protection, 'protected', 'S3：保护状态恢复');
  }

  section('S4 版本回滚/日志+痕迹双缺（fail-closed：不静默补签，事故态收编或拒绝）');
  {
    // (a) 内容与哈希一致（模拟旧版应用回写）：收编但强制回草案 + 事故留痕，绝不沿用 approved
    const sealFile = path.join(dir, 'config', 'canon-seal.json');
    fs.unlinkSync(path.join(dir, 'config', 'canon-chain.jsonl'));
    const seal = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
    const ver = seal.version;
    delete seal.keyId; delete seal.hmac; delete seal.hmacStale;
    seal.status = 'approved'; seal.approvedBy = '伪造者'; // 攻击：连 approved 一起伪造
    fs.writeFileSync(sealFile, JSON.stringify(seal, null, 2), 'utf8');
    ({ store, canon, guard } = boot(dir, () => 'testkey-alpha'));
    let st = canon.status();
    ok(st.history.some(h => h.source === 'signature-missing'), 'S4a：痕迹缺失被检出并留痕');
    eq(st.status, 'draft', 'S4a：收编后强制回草案（伪造的 approved 不被沿用）');
    eq(st.version, ver, 'S4a：版本不变（非重封存）');
    const after = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
    ok(after.hmac && after.keyId, 'S4a：哈希核对一致后才收编进保护（内容合法性有据）');
    // (b) 内容同时被篡改（剥离后恢复的保护 + 改内容）：哈希核对不过 → 快照恢复，篡改不落账
    const personaFile = path.join(dir, 'config', 'persona.json');
    const pj = JSON.parse(fs.readFileSync(personaFile, 'utf8'));
    pj.canon.taboos = 'S4b 篡改';
    fs.writeFileSync(personaFile, JSON.stringify(pj, null, 2), 'utf8');
    ({ store, canon, guard } = boot(dir));
    canon._setKeyProviderForTests(() => 'testkey-alpha');
    st = canon.status();
    ok(st.history.some(h => h.source === 'tamper-detect'), 'S4b：篡改内容被快照恢复（tamper-detect 留痕）');
    ok(canon.get().canon.taboos.includes('不为了讨好、取悦'), 'S4b：canon 回到可信内容');
  }

  // ============ 14. S5 组合态（risk-note v1.1 R11：痕迹全清 + 内容替换 ≠ 全新首封） ============
  section('S5 痕迹全清（R11：删 key+seal+链 + 改 canon → 事故态，绝不自动补签篡改内容）');
  {
    dir = freshDir();
    ({ store, canon, guard } = boot(dir, () => 'testkey-alpha'));
    canon.reprovision('测试：配置保护');
    store.flushAll();
    // 攻击：清空全部保护痕迹 + 替换 canon 内容，制造「看起来像全新安装」的现场
    // （provider 注入模式下无真实 key 文件，逐个存在才删）
    for (const f of ['canon-key.enc', 'canon-seal.json', 'canon-chain.jsonl']) {
      const fp = path.join(dir, 'config', f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    const pf = path.join(dir, 'config', 'persona.json');
    const pj = JSON.parse(fs.readFileSync(pf, 'utf8'));
    pj.canon.bond.nature = 'S5 篡改：主仆关系';
    fs.writeFileSync(pf, JSON.stringify(pj, null, 2), 'utf8');
    ({ store, canon, guard } = boot(dir, () => 'testkey-alpha'));
    const st = canon.status();
    const sealDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'canon-seal.json'), 'utf8'));
    // 验收 1：报事故态（存量安装分支），而非静默首封
    ok(st.history.some(h => /均缺失或不可信/.test(h.note || '')), 'S5：痕迹全清被判为事故（非全新首封）');
    // 验收 2：篡改内容零签名——seal 快照 = 代码常量默认值，篡改的 bond 不在任何签名物里
    const defaultsCanon = JSON.parse(JSON.stringify(require(path.join(ROOT, 'src/main/services/store')).DEFAULTS.persona.canon));
    eq(sealDisk.snapshot, defaultsCanon, 'S5：收编/封存的只有代码常量内容，篡改内容零签名');
    ok(!JSON.stringify(sealDisk.snapshot).includes('S5 篡改'), 'S5：篡改内容未进入任何封存物');
    ok(!sealDisk.history.some(h => h.type === 'boot-init'), 'S5：未伪装成 boot-init（genesis 锚不被污染）');
    eq(st.status, 'draft', 'S5：状态回草案待人工');
    ok(canon.get().canon.bond.nature.includes('共生型'), 'S5：canon 回到可信内容');
  }

  // ============ 15. 签名顺序回归（v1.1 真实事故：合法修订重启即被误判篡改） ============
  section('合法修订 → 重启必须零事故（签名顺序回归）');
  {
    dir = freshDir();
    ({ store, canon, guard } = boot(dir, () => 'testkey-alpha'));
    canon.reprovision('测试：配置保护');
    // 前辈走唯一合法通道：修订 → 签署
    canon.update({ identity: { purpose: '合法修订后的目的' } }, 'R4 演练修订');
    canon.approve();
    store.flushAll();
    const verBefore = canon.status().version;
    const sealFile = path.join(dir, 'config', 'canon-seal.json');
    const sealDisk = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
    // 校验器视角：落盘封存物必须能通过自己的 HMAC（签名顺序 bug 在此暴露）
    const stable = v => {
      if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
      if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
      return JSON.stringify(v ?? null);
    };
    const { hmac: _o, ...rest } = sealDisk;
    const expect = require('crypto').createHmac('sha256', 'testkey-alpha').update(stable(rest), 'utf8').digest('hex');
    eq(sealDisk.hmac, expect, '落盘签名与落盘内容自洽（签名在全部字段落定后计算）');
    // 重启：不得有任何事故、不得回滚、内容必须原样
    ({ store, canon, guard } = boot(dir, () => 'testkey-alpha'));
    const st = canon.status();
    eq(st.version, verBefore, '重启后版本不变（无事故重建）');
    ok(!st.history.some(h => h.type === 'incident-reseal' || /HMAC 校验失败/.test(h.note || '')), '重启零事故（无 HMAC 误判）');
    eq(canon.get().canon.identity.purpose, '合法修订后的目的', '合法修订内容原样保留（未被回滚）');
    eq(st.status, 'approved', '签署状态跨重启保持');
    ok(st.intact && st.protection === 'protected', '完整性与保护状态正常');
  }

  console.log(`\n========== 测试结果：${passed} 通过 / ${failed} 失败 ==========`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('测试脚本异常：', e && (e.stack || e.message)); process.exit(2); });
