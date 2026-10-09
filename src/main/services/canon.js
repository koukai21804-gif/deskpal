// 人格宪法引擎（TITOR-CANON v1.0）：persona 三层化 + 锁层守护。
//
// 三层命名空间（canon §0）：
//   canon — 锁层（L1 身份锚 / L2 关系定义 / L3 三铁律+禁忌 / L4 语言签名）。
//           唯一合法修改者是前辈本人，且须书面理由 + provenance 留痕（canon §1/§6）。
//   ops   — 可迭代表现层（canon §2），自由修改无需批准。
//   user  — 对话对象认知（滚动档案在 user/profile.js，本层只存名字与介绍基座）。
//
// ══════════ 保护状态机（Q1 三态，按保护等级而非文件状态分） ══════════
//   protected  密钥可读且签名可验——HMAC/哈希/genesis 全量裁决，不一致即判篡改并恢复；
//   degraded   密钥不可用（文件缺失/解不开/DPAPI 拒绝，诊断差异只进事件日志，不做裁决分支）——
//              【绝不判 tamper、绝不静默补签、绝不作废旧签名】；seal.hmac 原样保留但不参与裁决；
//              期间合法修订照常写入，历史条目标 signedUnder:null、seal 标 hmacStale:true；
//   unsigned   从未配置保护（真·新装/老版本升级）——首封时补签，这是唯一的自动补签路径。
// 恢复仪式（人工，唯一能清除降级态的路径）：
//   · 密钥环境恢复 → 启动检出「stale 签名」→ status.recoverPending=true（提示有 N 次未签名修订），
//     由人在设置页点「重新配置保护」→ canon:reprovision → 重新封存（key-reprovision 留痕）；
//   · 密钥彻底回不来 → 同一个按钮，显式作废旧签名后重建。系统永不自动执行这两步。
//
// ══════════ 锚链日志（Q2：让「删字段」抬升为「伪造链条」） ══════════
// config/canon-chain.jsonl：每次封存变更（sealNow/approve）追加一条
//   {seq, at, kind, version, keyId, prevHash, hash, entryHmac, seal(完整快照)}
//   hash = H(prevHash | keyId | version | contentHash)；entryHmac = HMAC(密钥, 条目)（protected 时）。
// 锚点分工（诚实边界，risk-note v1.1 R10）：asar 常量 GENESIS_HASH 锚定链条**起点**（v1 首封
// 内容 = DEFAULTS 代码常量）；链条延伸由 entryHmac 守护（protected 态下无密钥无法伪造新条目）。
// **副作用必须写明**：GENESIS_HASH 是不受密钥保护的构建产物常量——因此 degraded 期锚链与 canon
// 一样没有裁决力：无密钥即无法验证 HMAC 链，攻击者在降级期整体重写日志+seal 可做到静默自洽。
// degraded 期的链日志只提供**恢复用的记录**，不提供**裁决用的证据**；真正的裁决发生在密钥恢复后
// （HMAC 不符→判篡改，或 recoverPending→人工收编闸）。静态 asar 也无法锚定运行期移动的链头。
// 等价保障是：任何脱锚手法（删 seal/删字段/删日志/版本回滚/**痕迹全清 S5**）都落在
// 「日志恢复或可见事故 + 状态回草案 + 人工仪式」上；唯一自动补签路径（真·首装）的判据是
// **persona.json 不存在**（此时 canon 只能是 DEFAULTS，无篡改物可被洗白），运行期清不掉。
//
// 校验顺序（verify）：a. genesis（v1 首封锚，篡改 seal 冒充初封即被抓）→ b. 锚链日志
// （seal 与链头不符=字段被剥/回滚 → 从日志恢复 + 事故留痕）→ c. HMAC（protected 时签名不符：
// 有 stale 标记→recoverPending 待人工；无标记→判篡改回退默认）→ d. L1–L4 哈希（快照恢复，
// ops 不回滚——canon 定义身份、ops 是表现迭代，该组合合法且预期）。
//
// ══════════ 威胁边界（Q3 四层，与实现一一对齐） ══════════
//   A｜本应用工具通道（agent 经 read/write_file）：fs-guard config/ 拒写 + IPC 闸，全覆盖。主目标。
//   B｜同用户/同机器其他进程：定向恶意者可自行调用 DPAPI 读密钥、可读 asar 常量——HMAC 与
//      genesis 对「定向」无效，只拦「无差别/意外」子集：误编辑、部分备份恢复、【版本回滚】
//      （旧版应用写 seal 会丢失新字段，属 B 层意外类，校验按日志恢复处理，不判篡改）。
//   C｜运行期内存：密钥解锁后驻留 main 进程内存，dump 可取，不过度防御。但密钥材料**绝不跨
//      进程**：不进 renderer、不进 IPC 载荷（status()/canon:get 只暴露 verify 结果 + keyId），
//      恶意依赖/XSS 拿不到密钥材料——这条比 dump 更值得防，因为成本低。
//   D｜跨机器/跨用户离线：DPAPI 真正有效区间（解不开就伪造不了签名）。前提：密钥不能随
//      profile 迁移工具一起走（USMT 类工具会连 DPAPI 主密钥搬走，届时本层收益归零）。
//   开放项（待查证卡）：asar 自身完整性无校验（改 asar = 改常量），见 docs 威胁边界文档。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const logger = require('../logger');

// electron 仅在打包运行时存在；纯 Node 测试进程 graceful 降级（degraded 态，哈希/genesis 仍在）
let safeStorage = null;
try { ({ safeStorage } = require('electron')); } catch (_) { /* 纯 Node 测试环境 */ }

const SCHEMA = 2;
const MAX_HISTORY = 200;
const DIFF_CAP = 60;
const OPS_SNAPSHOT_CAP = 10;
const OPS_SNAPSHOT_THROTTLE_MS = 10 * 60 * 1000;
const TAMPERED_KEEP = 3;
const CHAIN_KEEP = 30;               // 锚链日志保留条数（含完整 seal 快照）
const GENESIS_HASH = crypto.createHash('sha256')
  .update(stableStringify(store.DEFAULTS.persona.canon), 'utf8').digest('hex');

// 测试钩子：注入密钥提供函数以模拟 protected/degraded 切换（生产代码永不调用）
let keyProviderOverride = null;

const LOCK_GROUPS = [
  { id: 'L1', keys: ['identity'], label: '身份锚' },
  { id: 'L2', keys: ['bond'], label: '关系定义' },
  { id: 'L3', keys: ['principles', 'taboos'], label: '三铁律与禁忌' },
  { id: 'L4', keys: ['signature'], label: '语言签名' },
];
const CANON_KEYS = ['identity', 'bond', 'principles', 'taboos', 'signature'];
const OPS_KEYS = ['tagline', 'appearance', 'personality', 'catchphrases', 'thinkingLogic', 'customPrompt', 'language'];

let seq = 0;
let lastOpsSnapAt = 0;
function newId(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + (++seq); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function friendly(msg) { const e = new Error(msg); e.userMsg = msg; return e; }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function cleanText(v) { return String(v == null ? '' : v).trim(); }
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (isPlainObject(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
function hashOf(v) { return crypto.createHash('sha256').update(stableStringify(v), 'utf8').digest('hex'); }

// ══════════ 密钥三态（Q1） ══════════
// 返回 { state, key, keyId, detail }。state ∈ protected/degraded/unsigned。
// 读路径绝不生成密钥——生成只发生在 init 的 unsigned 首封与 canon:reprovision 仪式。
function readKeyState() {
  if (keyProviderOverride) {
    try {
      const key = keyProviderOverride();
      return key
        ? { state: 'protected', key, keyId: sha256hex(key).slice(0, 16), detail: 'test-provider' }
        : { state: 'degraded', key: null, keyId: null, detail: 'test-provider-null' };
    } catch (_) { return { state: 'degraded', key: null, keyId: null, detail: 'test-provider-threw' }; }
  }
  try {
    if (!safeStorage) return { state: 'degraded', key: null, keyId: null, detail: 'electron 不可用（纯 Node）' };
    if (!safeStorage.isEncryptionAvailable()) return { state: 'degraded', key: null, keyId: null, detail: 'DPAPI 不可用' };
    const file = keyFilePath();
    if (!fs.existsSync(file)) return { state: 'degraded', key: null, keyId: null, detail: '密钥文件缺失' };
    const key = safeStorage.decryptString(fs.readFileSync(file)); // 解不开会 throw → degraded
    return { state: 'protected', key, keyId: sha256hex(key).slice(0, 16), detail: 'ok' };
  } catch (e) {
    return { state: 'degraded', key: null, keyId: null, detail: '密钥解密失败: ' + e.message };
  }
}
function keyFilePath() { return path.join(store.getDataDir(), 'config', 'canon-key.enc'); }
function sha256hex(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

// 显式配置/重建密钥（仅 init 的 unsigned 首封与 reprovision 仪式调用）
function provisionKey() {
  if (keyProviderOverride) return readKeyState();
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return { state: 'degraded', key: null, keyId: null, detail: 'DPAPI 不可用' };
  const file = keyFilePath();
  if (fs.existsSync(file)) return readKeyState(); // 已存在绝不覆盖（覆盖=静默洗白旧签名）
  const key = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, safeStorage.encryptString(key));
  return { state: 'protected', key, keyId: sha256hex(key).slice(0, 16), detail: 'provisioned' };
}

function hmacOf(key, text) { return crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex'); }

// ══════════ 归一化（任意来源 → 合法分层 persona） ══════════
function normalizePersona(raw) {
  const d = store.DEFAULTS.persona;
  if (raw && raw.pet && !raw.canon) return fromLegacy(raw);
  const src = isPlainObject(raw) ? raw : {};
  const canon = {};
  for (const k of CANON_KEYS) {
    const def = d.canon[k], cur = src.canon && src.canon[k];
    canon[k] = isPlainObject(def) ? { ...def, ...(isPlainObject(cur) ? cur : {}) } : cleanText(cur ?? def);
  }
  const ops = {};
  for (const k of OPS_KEYS) ops[k] = cleanText((src.ops || {})[k] ?? d.ops[k]);
  ops.language = ops.language || d.ops.language;
  return {
    schema: SCHEMA,
    canon,
    ops,
    user: {
      name: cleanText((src.user || {}).name ?? d.user.name) || d.user.name,
      description: cleanText((src.user || {}).description ?? d.user.description),
    },
  };
}

function fromLegacy(raw) {
  const layered = normalizePersona(null);
  const pet = raw.pet || {};
  layered.canon.identity.name = cleanText(pet.name) || layered.canon.identity.name;
  for (const k of OPS_KEYS) if (cleanText(pet[k]) !== '') layered.ops[k] = cleanText(pet[k]);
  layered.user.name = cleanText((raw.user || {}).name) || layered.user.name;
  layered.user.description = cleanText((raw.user || {}).description) || layered.user.description;
  return layered;
}

function get() { return normalizePersona(store.get('persona')); }

// 扁平兼容视图：{pet, user}（v0.3 字段名），渲染层与旧消费点零改动。
function view(p) {
  const P = p ? normalizePersona(p) : get();
  return {
    pet: {
      name: P.canon.identity.name,
      tagline: P.ops.tagline, appearance: P.ops.appearance, personality: P.ops.personality,
      speechStyle: P.canon.signature.speechStyle, catchphrases: P.ops.catchphrases,
      background: P.canon.identity.background, emotionalPatterns: P.canon.signature.emotionalPatterns,
      taboos: P.canon.taboos, thinkingLogic: P.ops.thinkingLogic,
      customPrompt: P.ops.customPrompt, language: P.ops.language,
    },
    user: { name: P.user.name, description: P.user.description },
  };
}

// ══════════ seal 读写 + 锚链日志 ══════════
function getSeal() { return store.get('canon/seal'); }

function hashCanon(canon) {
  const out = {};
  for (const g of LOCK_GROUPS) out[g.id] = hashOf(Object.fromEntries(g.keys.map(k => [k, canon[k]])));
  return out;
}

function pushHistory(seal, entry) {
  seal.history = [...(seal.history || []), { id: newId('cn'), at: new Date().toISOString(), ...entry }].slice(-MAX_HISTORY);
}

// 锚链日志：追加一条（含完整 seal 快照），超出 CHAIN_KEEP 裁剪最旧。原子写。
function chainFile() { return path.join(store.getDataDir(), 'config', 'canon-chain.jsonl'); }

function chainRead() {
  try {
    const text = fs.readFileSync(chainFile(), 'utf8');
    return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function chainAppend(entry) {
  try {
    const items = [...chainRead(), entry].slice(-CHAIN_KEEP);
    const file = chainFile();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, items.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) { logger.warn('[canon] 锚链日志写入失败: ' + e.message); }
}

// saveSeal 是 seal 写的唯一出口：盖签名/标记 keyId → 落 store → 追加锚链。
// degraded 时 hmac 保持原样不重签、标 hmacStale（Q1：不静默补签、不作废旧签名）。
// ackFields（R12a）：附加到最新历史条目的确认记录（ackBy/ackAt/ackedRevisions），随同一次落链。
// ⚠ 顺序铁律：HMAC 必须在 seal 的**全部**字段（含 signedUnder/ackFields）落定之后计算。
//   先签后改 = 签名与落盘内容必然不一致 = 下次启动必然误判「协同篡改」并回滚合法修订
//   （v1.1 真实环境事故根因：合法修订重启即被回滚）。
function saveSeal(seal, { kind = 'seal', ackFields = null } = {}) {
  const ks = readKeyState();
  if (ks.state === 'protected') {
    seal.keyId = ks.keyId;
    seal.hmacStale = false;
  } else {
    // degraded：原样保留旧签名与旧 keyId（密钥身份不因不可读而改变）；
    // 只有「曾经有过签名」才标 stale（真·未配置保护不是 stale，是 unsigned）
    if (seal.hmac || seal.keyId) seal.hmacStale = true;
  }
  // 新历史条目标注签名状态（Q1：降级期间的修订 signedUnder:null）
  const last = (seal.history || [])[((seal.history || []).length) - 1];
  if (last && last.signedUnder === undefined) last.signedUnder = seal.hmacStale ? null : (seal.keyId || null);
  if (last && ackFields) Object.assign(last, ackFields);
  // 全部变更落定后再计算签名
  if (ks.state === 'protected') {
    const { hmac: _omit, ...rest } = seal;
    seal.hmac = hmacOf(ks.key, stableStringify(rest));
  }

  store.replace('canon/seal', seal);

  // 锚链条目：hash 覆盖 prevHash/keyId/version/contentHash；protected 时再加 entryHmac
  const prev = chainRead();
  const prevHash = prev.length ? prev[prev.length - 1].hash : '';
  const contentHash = hashOf(seal.snapshot);
  const entry = {
    seq: (prev.length ? prev[prev.length - 1].seq : 0) + 1,
    at: new Date().toISOString(),
    kind, version: seal.version || 0,
    keyId: seal.keyId || null,
    prevHash, contentHash,
    seal: clone(seal),
  };
  entry.hash = sha256hex(stableStringify({ prevHash, keyId: entry.keyId, version: entry.version, contentHash, kind, seq: entry.seq }));
  if (ks.state === 'protected') {
    const { entryHmac: _e, ...rest } = entry;
    entry.entryHmac = hmacOf(ks.key, stableStringify(rest));
  }
  chainAppend(entry);
  return seal;
}

function sealNow(persona, meta = {}) {
  const seal = getSeal();
  seal.version = (seal.version || 0) + 1;
  seal.doc = seal.doc || 'TITOR-CANON v1.0';
  seal.sealedAt = new Date().toISOString();
  seal.hashes = hashCanon(persona.canon);
  seal.snapshot = clone(persona.canon);
  seal.status = 'draft';
  seal.approvedBy = null;
  seal.approvedAt = null;
  pushHistory(seal, {
    version: seal.version, by: meta.by || 'user(前辈)', type: meta.type || 'seal',
    reason: meta.reason || '', source: meta.source || 'manual',
    diff: meta.diff || [], note: meta.note || '',
  });
  return saveSeal(seal, { kind: meta.type || 'seal', ackFields: meta.ackFields || null });
}

// ══════════ 启动流程 ══════════
// 返回 { incident, protection } 供 main.js 弹窗/推送与设置页展示（Q3：事件可见）。
function init() {
  const file = store.filePathOf('persona');
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { raw = null; }
  let incident = null;

  if (raw && raw.pet && !raw.canon) {
    const layered = fromLegacy(raw);
    store.replace('persona', layered);
    logger.info('[canon] persona 已从 v1 单层结构迁移为 canon/ops/user 三层');
    const ks = provisionKey();
    if (ks.state !== 'protected') logger.warn(`[canon] 迁移期签名保护未就绪（${ks.detail}），seal 以 unsigned/degraded 落盘`);
    sealNow(layered, { by: 'system', type: 'migrate', source: 'migration', note: 'persona v1 → v2 三层迁移，canon 以 TITOR-CANON v1.0 兜底封存' });
  } else {
    const layered = normalizePersona(raw);
    if (!raw || raw.schema !== SCHEMA || !raw.canon || !raw.ops || !raw.user) store.replace('persona', layered);
    const seal = getSeal();
    if (!seal.version) {
      // seal 缺失（版本 0）：三分支，绝不能把现存 canon 误标成「全新首封」（会污染 genesis 锚）
      const chain = chainRead();
      const ks = readKeyState();
      const trusted = chain.length ? walkChain(chain, ks) : null;
      if (trusted && trusted.seal) {
        // 分支 1：锚链在 → 从日志恢复最近可信封存（S2 删 seal 的正路；不判篡改、留事故痕）
        store.replace('canon/seal', clone(trusted.seal));
        const rec = getSeal();
        const note = `封存文件缺失，已从锚链日志恢复 v${rec.version}；状态回草案待人工确认`;
        pushHistory(rec, { version: rec.version, by: 'system', type: 'incident', source: 'seal-missing', reason: '', diff: [], note, at: new Date().toISOString() });
        saveSeal(rec, { kind: 'seal-missing-recover' });
        logger.warn(`[canon] ${note}`);
        incident = { at: new Date().toISOString(), note, version: rec.version };
      } else if (raw) {
        // 分支 2：日志也不可信/不存在，但 persona.json 存在（存量安装被删 seal）→ fail-closed：
        // 内容无法验证，回退默认宪法并以事故封存，等人工核对后重新批准（绝不静默收编存量内容）
        incident = resetToDefaults(getSeal(), '封存文件与锚链日志均缺失或不可信（存量安装），无法验证 canon——已回退默认宪法并以草案重新封存，请人工核对后重新批准', new Date().toISOString());
      } else {
        // 分支 3：真·首装（persona.json 不存在）→ unsigned → 配置保护 + 初版封存（唯一自动补签路径）
        provisionKey();
        sealNow(layered, { by: 'titor(草案)', type: 'boot-init', source: 'boot-init', note: '初版封存：TITOR-CANON v1.0（草案，批准待前辈签署）' });
      }
    } else {
      incident = verify(layered, seal);
    }
  }
  recordOpsSnapshot('boot', true);
  store.flushAll();
  return { incident, protection: protectionState().state };
}

// 保护状态（Q1 三态；供 status()/init 返回。密钥材料永不外泄，只出 state/keyId/诊断摘要）
function protectionState() {
  const seal = getSeal();
  const everProtected = !!(seal.hmac || seal.keyId || chainRead().some(e => e.keyId));
  const ks = readKeyState();
  if (!everProtected && !seal.hmac && !seal.keyId && ks.state !== 'protected') {
    return { state: 'unsigned', detail: ks.detail, keyId: null };
  }
  if (ks.state === 'protected') {
    return { state: 'protected', detail: ks.detail, keyId: ks.keyId };
  }
  return { state: 'degraded', detail: ks.detail, keyId: seal.keyId || null };
}

// ══════════ 启动校验（顺序：genesis → 锚链 → HMAC → 哈希；见文件头） ══════════
// 返回事故对象或 null。
function verify(persona, seal) {
  const at = new Date().toISOString();
  const ks = readKeyState();

  // a. genesis：v1 首封快照必须等于代码常量（伪造「初始封存」即被抓；asar 常量锚定链条起点）
  const first = (seal.history || [])[0] || {};
  if (seal.version === 1 && first.type === 'boot-init' && hashOf(seal.snapshot) !== GENESIS_HASH) {
    return resetToDefaults(seal, 'v1 首封快照与代码内 genesis 锚不符（疑似伪造初始封存），已回退默认宪法并重新封存为草案', at);
  }

  // b. 锚链日志：seal 与链头不符 = 字段被剥/被改/版本回滚（B 层意外类）→ 从日志恢复，不判篡改；
  //    恢复后【继续】c/d 校验（同一启动内把被篡改的 canon 也修完，不留到下次启动）
  let chainIncident = null;
  const chain = chainRead();
  if (chain.length) {
    const head = chain[chain.length - 1];
    const sealMatchesHead = head.seal && stableStringify(head.seal) === stableStringify(seal);
    if (!sealMatchesHead) {
      // 链条自身完整性：逐条验 hash 链；protected 态再验 entryHmac（失败则回退到最近可验头）
      const trusted = walkChain(chain, ks);
      if (trusted && trusted.seal) {
        seal = clone(trusted.seal);
        store.replace('canon/seal', seal);
        const note = `seal 与锚链日志不符（疑似字段剥离或版本回滚，B 层意外类），已从日志恢复最近可信封存 v${seal.version}；继续执行内容校验`;
        pushHistory(seal, { version: seal.version, by: 'system', type: 'incident', source: 'chain-recover', reason: '', diff: [], note, at });
        saveSeal(seal, { kind: 'chain-recover' });
        logger.warn(`[canon] 锁层校验事故：${note}`);
        chainIncident = { at, note, version: seal.version };
      } else {
        // 整条链都不可信：fail-closed 到人工仪式，绝不静默接受
        const note = '锚链日志完整性校验失败（无法找到可信任链头），保留当前 seal 与 canon，需要人工「重新配置保护」后才能恢复裁决';
        logger.warn(`[canon] ${note}`);
        seal.hmacStale = true;
        store.replace('canon/seal', seal);
        return { at, note, version: seal.version };
      }
    }
  } else if (seal.keyId || seal.hmac) {
    // 日志缺失但 seal 声称有保护：不静默补建——记事故，状态回草案，等人工重新配置
    const note = '锚链日志缺失而 seal 含保护字段（可能被删除或由旧版本写入），已保留现场；请人工「重新配置保护」';
    pushHistory(seal, { version: seal.version, by: 'system', type: 'incident', source: 'chain-missing', reason: '', diff: [], note, at });
    seal.hmacStale = true;
    saveSeal(seal, { kind: 'chain-missing' });
    logger.warn(`[canon] ${note}`);
    return { at, note, version: seal.version };
  }

  // c. HMAC：仅 protected 态参与裁决（Q1：degraded 绝不判 tamper）
  if (ks.state === 'protected' && seal.hmac) {
    const { hmac: _omit, ...rest } = seal;
    if (hmacOf(ks.key, stableStringify(rest)) !== seal.hmac) {
      if (seal.hmacStale) {
        // 降级期间的合法修订/恢复场景：不判篡改，转人工确认（不自动重签=不静默洗白）
        const n = (seal.history || []).filter(h => h.signedUnder === null).length;
        const note = `密钥已恢复，seal 携带 ${n} 条未签名修订（hmacStale），待人工「重新配置保护」后重新封存`;
        logger.warn(`[canon] ${note}`);
        return { at, note, version: seal.version, recoverPending: true };
      }
      return resetToDefaults(seal, '封存文件 HMAC 校验失败：canon+seal 可能被协同改写，已回退默认宪法并重新封存为草案；请人工核对后重新批准', at);
    }
  }
  // c'. 补签闸（Q2：唯一的自动补签路径——真·老版本升级）：仅「无任何保护痕迹且版本=1」时允许；
  //     version>1 却无保护字段 = 痕迹被剥/旧版回写，走仪式不静默补签
  if (ks.state === 'protected' && !seal.hmac) {
    if (!seal.keyId && seal.version === 1) {
      saveSeal(getSeal(), { kind: 'bootstrap-sign' });
      logger.info('[canon] 旧封存无签名（老版本升级），本次启动补签');
    } else {
      // 痕迹缺失：先做内容一致性检查（哈希对得上才允许收编），再以事故态收编进保护、回草案
      const cur0 = hashCanon(persona.canon);
      const dirty0 = LOCK_GROUPS.filter(g => cur0[g.id] !== (seal.hashes || {})[g.id]).map(g => g.id);
      if (dirty0.length) {
        return resetToDefaults(seal, `seal 无签名且内容与封存哈希不符（${dirty0.join('/')}）——拒绝收编，已回退默认宪法`, at);
      }
      const note = `seal 无签名但版本为 v${seal.version}（保护痕迹缺失，疑似字段剥离或旧版回写）：内容经哈希核对一致后收编进保护，状态回草案待人工确认`;
      seal.status = 'draft'; seal.approvedBy = null; seal.approvedAt = null; // 剥离过保护的 seal 不沿用 approved
      seal.hmacStale = true;
      pushHistory(seal, { version: seal.version, by: 'system', type: 'incident', source: 'signature-missing', reason: '', diff: [], note, at });
      saveSeal(seal, { kind: 'signature-missing' });
      logger.warn(`[canon] ${note}`);
      return { at, note, version: seal.version };
    }
  }

  // d. L1–L4 哈希：常规意外篡改 → 按最近批准快照恢复 canon（ops 不回滚，组合态合法——R9 语义）
  const cur = hashCanon(persona.canon);
  const mismatch = LOCK_GROUPS.filter(g => cur[g.id] !== (seal.hashes || {})[g.id]).map(g => g.id);
  let dIncident = null;
  if (mismatch.length) {
    const backup = quarantineTampered();
    const restored = clone(persona);
    restored.canon = clone(seal.snapshot || store.DEFAULTS.persona.canon);
    store.replace('persona', restored);
    const note = `canon 与封存快照不一致（${mismatch.join('/')}），已恢复并隔离被改副本（${backup || '备份失败'}）；ops 层保留当前状态不回滚——canon 定义身份、ops 是表现迭代，该组合合法（R9 语义）`;
    pushHistory(seal, { version: seal.version, by: 'system', type: 'incident', source: 'tamper-detect', reason: '', diff: [], note, at });
    saveSeal(seal, { kind: 'tamper-recover' });
    logger.warn(`[canon] 锁层校验事故：${note}`);
    dIncident = { at, note, version: seal.version };
  } else {
    pruneTamperedBackups();
  }
  // 同一启动内先发生锚链恢复、后又发生内容恢复：合并事故说明，一次弹窗讲完整件事
  if (chainIncident && dIncident) {
    dIncident.note = `${chainIncident.note}；随后 ${dIncident.note}`;
    return dIncident;
  }
  return dIncident || chainIncident || null;
}

// 链条回溯：逐条验 hash 链 + entryHmac（protected 时），返回最近一条可信条目（含 seal 快照）
function walkChain(chain, ks) {
  let trusted = null;
  for (const entry of chain) {
    const expect = sha256hex(stableStringify({ prevHash: entry.prevHash, keyId: entry.keyId, version: entry.version, contentHash: entry.contentHash, kind: entry.kind, seq: entry.seq }));
    if (entry.hash !== expect) break;
    if (trusted && entry.prevHash !== trusted.hash) break;
    if (entry.entryHmac && ks.state === 'protected') {
      const { entryHmac: _e, ...rest } = entry;
      if (hmacOf(ks.key, stableStringify(rest)) !== entry.entryHmac) break;
    }
    trusted = entry;
  }
  return trusted && trusted.seal ? trusted : null;
}

// seal 不可信时的兜底：canon 回退默认宪法 + 重建封存（status=draft 待重新签署）
function resetToDefaults(seal, note, at) {
  const restored = get();
  restored.canon = clone(store.DEFAULTS.persona.canon);
  store.replace('persona', restored);
  sealNow(restored, { by: 'system', type: 'incident-reseal', source: 'tamper-detect', note, diff: [] });
  logger.warn(`[canon] 锁层校验事故：${note}`);
  return { at, note, version: getSeal().version };
}

// 篡改现场隔离（R8：保留最近 TAMPERED_KEEP 份）
function quarantineTampered() {
  try {
    const file = store.filePathOf('persona');
    const name = `persona.json.tampered-${Date.now()}`;
    fs.copyFileSync(file, path.join(path.dirname(file), name));
    pruneTamperedBackups();
    return name;
  } catch (_) { return null; }
}

function pruneTamperedBackups() {
  try {
    const dir = path.dirname(store.filePathOf('persona'));
    const olds = fs.readdirSync(dir).filter(f => f.startsWith('persona.json.tampered-')).sort().reverse();
    for (const f of olds.slice(TAMPERED_KEEP)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  } catch (_) {}
}

// ══════════ 批准变更（唯一合法 canon 写通道） ══════════
function diffCanon(oldC, newC) {
  const out = [];
  const push = (path, a, b) => out.push({ path, old: String(a ?? '').slice(0, DIFF_CAP), new: String(b ?? '').slice(0, DIFF_CAP) });
  for (const k of CANON_KEYS) {
    const a = oldC[k], b = newC[k];
    if (!isPlainObject(a)) { if (a !== b) push(k, a, b); continue; }
    for (const f of Object.keys({ ...a, ...b })) if (a[f] !== b[f]) push(`${k}.${f}`, a[f], b[f]);
  }
  return out;
}

function update(changes, reason) {
  guardNotRecoverPending('修订');
  const why = cleanText(reason);
  if (why.length < 2) throw friendly('canon 锁层修改必须附书面理由（provenance 必填：为什么改）');
  if (!isPlainObject(changes) || !Object.keys(changes).length) throw friendly('没有提供任何 canon 变更内容');
  const bad = Object.keys(changes).filter(k => !CANON_KEYS.includes(k));
  if (bad.length) throw friendly(`未知的 canon 字段：${bad.join('、')}（合法：${CANON_KEYS.join('、')}）`);

  const persona = get();
  const next = clone(persona);
  for (const k of CANON_KEYS) {
    if (!(k in changes)) continue;
    const v = changes[k];
    if (isPlainObject(persona.canon[k])) {
      if (!isPlainObject(v)) throw friendly(`canon.${k} 是结构化字段组，须以对象形式提供各子字段`);
      next.canon[k] = { ...persona.canon[k], ...sanitizeGroup(k, v) };
    } else {
      next.canon[k] = cleanText(v);
    }
  }
  const diff = diffCanon(persona.canon, next.canon);
  if (!diff.length) return { changed: false, version: getSeal().version };

  store.replace('persona', next);
  const seal = sealNow(next, { by: 'user(前辈)', type: 'amend', source: 'user-approval', reason: why.slice(0, 200), diff });
  logger.info(`[canon] 宪法已批准修订 v${seal.version}（${diff.length} 处）${seal.hmacStale ? '（降级态：本次修订标记为未签名）' : ''}，provenance 已留痕`);
  return { changed: true, version: seal.version, diff, sealedAt: seal.sealedAt };
}

function sanitizeGroup(k, v) {
  const out = {};
  for (const [f, val] of Object.entries(v || {})) out[String(f).slice(0, 24)] = cleanText(val);
  return out;
}

// ══════════ 签署（R2）与重新配置保护（Q1 恢复仪式） ══════════
// recoverPending 封锁（risk-note v1.1 R12 洗白面）：存在未收编的未签名修订且密钥可用时，
// update/approve 都会经 saveSeal 重签——等于绕过确认闸收编未签名内容（无论该安装是
// 「签过名后降级」（hmacStale 路径）还是「降级出生从未签名」（无 stale 标记路径），
// 判据统一为 unsignedAmendments 非空 + protected）。唯一出路是带 ack 的 reprovision。
function recoverPendingNow() {
  const seal = getSeal();
  return !!(readKeyState().state === 'protected' && unsignedAmendments(seal).length);
}

function guardNotRecoverPending(action) {
  if (recoverPendingNow()) {
    throw friendly(`存在未收编的未签名修订，${action}前请先在设置页完成「重新配置保护」的人工确认（risk-note v1.1 R12a）`);
  }
}

// 未签名修订清单（R12a 确认闸的数据源；渲染层确认对话展示用）。
// 只统计修正式变更（amend）——boot-init/migrate/apply 等封存创建类条目不是「修订」；
// 已被 ack 过的 reprovision 收编的条目（absorbedBy）不再计入。
function unsignedAmendments(seal) {
  return (seal.history || []).filter(h => h.signedUnder === null && h.type === 'amend' && !h.absorbedBy);
}

function pendingAmendments() {
  const seal = getSeal();
  return unsignedAmendments(seal)
    .map(h => ({ at: h.at, type: h.type, reason: h.reason || '', note: h.note || '', diff: h.diff || [] }));
}

function approve() {
  guardNotRecoverPending('签署');
  const seal = getSeal();
  const persona = get();
  const cur = hashCanon(persona.canon);
  const dirty = LOCK_GROUPS.filter(g => cur[g.id] !== (seal.hashes || {})[g.id]).map(g => g.id);
  if (dirty.length) throw friendly(`宪法内容与封存不一致（${dirty.join('/')}），先解决篡改事故再签署`);
  if (seal.status === 'approved') return { status: seal.status, approvedAt: seal.approvedAt, already: true };
  seal.status = 'approved';
  seal.approvedBy = 'user(前辈)';
  seal.approvedAt = new Date().toISOString();
  pushHistory(seal, { version: seal.version, by: seal.approvedBy, type: 'approve', reason: '', diff: [], note: `签署批准 v${seal.version}（TITOR-CANON 状态机：approved）` });
  saveSeal(seal, { kind: 'approve' });
  logger.info(`[canon] 宪法 v${seal.version} 已由前辈签署批准`);
  return { status: seal.status, version: seal.version, approvedAt: seal.approvedAt };
}

// 人工仪式：密钥恢复后的「重新封存」/ 密钥彻底丢失后的「显式作废旧签名并重建」。
// 系统永不自动调用本函数。
// R12a 收编闸：存在未签名修订时必须 ack=true（渲染层已向用户逐条展示 diff 并获确认），
// 确认记录落 ackBy/ackAt/ackedRevisions——收编从此有据可查，不再与合法修订不可区分。
function reprovision(reason, ack = false) {
  const why = cleanText(reason);
  if (why.length < 2) throw friendly('重新配置保护必须附书面理由（将落 provenance）');
  const seal = getSeal();
  const pending = unsignedAmendments(seal);
  if (pending.length && ack !== true) {
    throw friendly(`存在 ${pending.length} 条未签名修订（降级期间产生），须先逐条确认内容再重新配置保护——请走设置页「重新配置保护」确认流程`);
  }
  const ks = provisionKey();
  if (ks.state !== 'protected') throw friendly(`密钥仍不可用，无法重新配置保护（${ks.detail}）`);
  // 标记待收编条目：absorbedBy 指向即将产生的新封存版本（历史条目永久保留审计痕迹，但不再计入未收编）
  const pendingIds = new Set(pending.map(h => h.id));
  const absorbVer = (seal.version || 0) + 1;
  const absorbAt = new Date().toISOString();
  for (const h of seal.history || []) {
    if (pendingIds.has(h.id)) { h.absorbedBy = absorbVer; h.absorbedAt = absorbAt; }
  }
  const persona = get();
  const noteExtra = pending.length ? `；已确认收编 ${pending.length} 条未签名修订` : '';
  const seal2 = sealNow(persona, {
    by: 'user(前辈)', type: 'key-reprovision', source: 'reprovision',
    reason: why.slice(0, 200), diff: [],
    note: `重新配置签名保护（keyId=${ks.keyId}）并重新封存${noteExtra}`,
    ackFields: pending.length ? { ackBy: 'user(前辈)', ackAt: new Date().toISOString(), ackedRevisions: pending.length } : null,
  });
  logger.info(`[canon] 签名保护已重新配置（keyId=${ks.keyId}），宪法重新封存为 v${seal2.version}（草案）${noteExtra}`);
  return { version: seal2.version, keyId: ks.keyId, sealedAt: seal2.sealedAt, ackedRevisions: pending.length };
}

// ══════════ 渲染层通道守卫 / 档案重封存 / ops 快照 ══════════
function sanitizePersonaPatch(patch) {
  const banned = Object.keys(patch || {}).filter(k => ['canon', 'pet', 'meta', 'schema'].includes(k));
  if (banned.length) {
    throw friendly(`persona 的 ${banned.join('/')} 字段受锁层保护：canon 变更请走批准通道（设置页「申请修改」），旧版 pet 结构已迁移为 canon/ops 分层`);
  }
}

function reseal(meta = {}) {
  const persona = get();
  const seal = sealNow(persona, {
    by: 'user(前辈)', type: 'apply', source: meta.source || 'profile-apply',
    reason: '', diff: [], note: meta.note || '',
  });
  recordOpsSnapshot(meta.source || 'profile-apply', true);
  return seal;
}

function recordOpsSnapshot(reason, force = false) {
  try {
    const now = Date.now();
    if (!force && now - lastOpsSnapAt < OPS_SNAPSHOT_THROTTLE_MS) return false;
    lastOpsSnapAt = now;
    const doc = store.get('canon/opshist');
    const p = get();
    const item = { at: new Date().toISOString(), reason: String(reason || '').slice(0, 24), name: p.canon.identity.name, ops: clone(p.ops) };
    const items = [...(doc.items || []), item].slice(-OPS_SNAPSHOT_CAP);
    if (JSON.stringify(items) === JSON.stringify(doc.items || [])) return false;
    store.replace('canon/opshist', { items });
    return true;
  } catch (_) { return false; }
}

function noteOpsChange() { return recordOpsSnapshot('edit', false); }

function listOpsSnapshots() {
  return (store.get('canon/opshist').items || []).map((it, index) => ({
    index, at: it.at, reason: it.reason, name: it.name,
    tagline: (it.ops || {}).tagline || '', customPrompt: (it.ops || {}).customPrompt || '',
  })).reverse();
}

function restoreOps(index) {
  const items = store.get('canon/opshist').items || [];
  const it = items[+index];
  if (!it || !it.ops) throw friendly('快照不存在');
  const p = get();
  p.ops = clone(it.ops);
  store.replace('persona', p);
  recordOpsSnapshot('restore', true);
  logger.info(`[canon] ops 已恢复至 ${it.at} 的快照（reason=${it.reason}）`);
  return { restoredAt: it.at };
}

// ══════════ 状态（Q3：密钥材料绝不进本函数返回值 → 永不进 renderer） ══════════
function status() {
  const seal = getSeal();
  const persona = get();
  const cur = hashCanon(persona.canon);
  const intact = LOCK_GROUPS.every(g => cur[g.id] === (seal.hashes || {})[g.id]);
  const prot = protectionState();
  const unsignedRevisions = unsignedAmendments(seal).length;
  const pending = recoverPendingNow();
  return {
    version: seal.version || 0,
    doc: seal.doc || 'TITOR-CANON v1.0',
    sealedAt: seal.sealedAt,
    intact,
    status: seal.status === 'approved' ? 'approved' : 'draft',
    approvedBy: seal.approvedBy || null,
    approvedAt: seal.approvedAt || null,
    // Q1 三态 + 恢复挂起（degraded/recoverPending 时 UI 提示「重新配置保护」）
    protection: prot.state,
    protectionDetail: prot.detail,
    keyId: prot.keyId,
    recoverPending: pending,
    unsignedRevisions,
    pendingAmendments: pending ? pendingAmendments() : [],
    history: seal.history || [],
    opsSnapshots: listOpsSnapshots(),
    l5: l5Status(),
  };
}

function l5Status() {
  const dir = store.getDataDir();
  const carriers = {
    memory: 'memory/roleplay.json',
    canon: 'config/persona.json',
    relationship: 'chats/roleplay.json',
  };
  const out = {};
  for (const [k, rel] of Object.entries(carriers)) {
    try { out[k] = { path: path.join(dir, rel), exists: fs.existsSync(path.join(dir, rel)) }; }
    catch (_) { out[k] = { path: path.join(dir, rel), exists: false }; }
  }
  return out;
}

module.exports = {
  init, get, view, update, approve, reprovision, status, normalizePersona, sanitizePersonaPatch, reseal,
  recordOpsSnapshot, noteOpsChange, listOpsSnapshots, restoreOps, pendingAmendments,
  LOCK_GROUPS, CANON_KEYS, OPS_KEYS, SCHEMA,
  _setKeyProviderForTests: fn => { keyProviderOverride = fn; }, // 仅供测试脚本注入，生产禁用
};
