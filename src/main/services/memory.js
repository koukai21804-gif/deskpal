// 长期记忆管理服务：scope 三态体系（v0.5）+ /deep memory forcing 面板数据源
// 查看/添加/删除/改层 memory/roleplay 条目。与 chat.js 的 memoryTick（自动提取）共用一份存储。
// scope 语义（取代 importance 排序——实测 50 条全 5 分，排序退化为「最旧优先」，注入通道冻结 5 天）：
//   core      身份级认知。字数硬上限（CORE_CHAR_BUDGET≈500 token），不参与自动淘汰，
//             自动提取禁止写入；满载时新条降级为 working 并在回执注明（不静默丢）。
//   working   滚动工作记忆。注入最近 8 条（新→旧）；库满时最旧者进 archive。
//   ephemeral 事件记录。带 ttlDays（默认 14），过期进 archive；不进每轮注入。
// archive：淘汰条目的归档（可查、可还原，但不进注入面——「可回溯」不等于「还在认知里」）。
// 该通道的所有操作不经过聊天历史/LLM，角色对此无感知（斜杠消息也不会入史）。
const store = require('./store');

const MAX = 50;
const TYPES = ['relationship', 'event', 'fact', 'preference'];
const SCOPES = ['core', 'working', 'ephemeral'];
const CORE_CHAR_BUDGET = 1000; // core 总字数上限（token-est 口径 CJK×0.5 ≈ 500 token）
const EPHEMERAL_TTL_DAYS = 14;
const ARCHIVE_MAX = 100;
let seq = 0;

// 斜杠命令识别（渲染层与主进程双端同款正则；主进程兜底防止消息被误发进 LLM/历史）
const MEMORY_COMMAND_RE = /^\s*\/\s*deep\s+memory\s+forcing\s*$/i;
function isMemoryCommand(text) { return MEMORY_COMMAND_RE.test(String(text || '')); }

function doc() { return store.get('memory/roleplay'); }
function items() { return doc().items || []; }

// 截断可见化（P0-3）：超限硬切必须带省略号——被截断的条目与完整条目在面板/注入里可区分
function capText(text, max) {
  const s = String(text || '').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function persist() { store.replace('memory/roleplay', doc()); }

// 旧条目归一化：补 id、补 scope（缺省 working）并落盘
function ensureIds() {
  const list = items();
  let dirty = false;
  for (const it of list) {
    if (!it.id) { it.id = 'mem_' + Date.now().toString(36) + '_' + (++seq); dirty = true; }
    if (!SCOPES.includes(it.scope)) { it.scope = 'working'; dirty = true; }
  }
  if (dirty) persist();
  return list;
}

function coreChars(list) {
  return list.filter(i => i.scope === 'core').reduce((s, i) => s + String(i.content || '').length, 0);
}

function isExpired(it, now) {
  if (it.scope !== 'ephemeral' || !it.ttlDays) return false;
  const created = new Date(it.createdAt || 0).getTime();
  return Number.isFinite(created) && (now - created) > it.ttlDays * 24 * 3600 * 1000;
}

// 有效时序键：恢复（restoredAt）视为一次重新确认——淘汰与 working 注入的「新旧」
// 都按它排。否则满库时恢复一条最旧记忆会被 sweep 立即再次淘汰（恢复=白做）。
function effKey(it) { return String(it.restoredAt || it.createdAt || ''); }

// 淘汰与归档（写路径统一走这里）：
//   1) 过期 ephemeral → archive；2) 超 MAX → 先淘汰最旧 ephemeral，再淘汰最旧 working；core 永不淘汰
//   （全 core 且超限的极端情况允许超限——宁可库大，不丢身份级认知）
// 归档副本剥掉 restoredAt——那是上一轮恢复的痕迹，与本轮淘汰无关。
function sweep() {
  const d = doc();
  const now = Date.now();
  const archive = d.archive || (d.archive = []);
  let list = d.items || (d.items = []);
  const expired = list.filter(i => isExpired(i, now));
  if (expired.length) {
    list = list.filter(i => !isExpired(i, now));
    for (const it of expired) {
      const { restoredAt: _r, ...clean } = it;
      archive.push({ ...clean, archivedAt: new Date().toISOString(), reason: 'ttl' });
    }
  }
  while (list.length > MAX) {
    const victim = list.filter(i => i.scope === 'ephemeral').sort((a, b) => effKey(a).localeCompare(effKey(b)))[0]
      || list.filter(i => i.scope === 'working').sort((a, b) => effKey(a).localeCompare(effKey(b)))[0];
    if (!victim) break; // 只剩 core：不淘汰
    list = list.filter(i => i !== victim);
    const { restoredAt: _r2, ...clean2 } = victim;
    archive.push({ ...clean2, archivedAt: new Date().toISOString(), reason: 'overflow' });
  }
  d.items = list;
  if (archive.length > ARCHIVE_MAX) d.archive = archive.slice(-ARCHIVE_MAX);
  persist();
}

// 面板列表：按注入语义排序（core 在前按时间升序，working/ephemeral 按有效时序新→旧）
function listMemories() {
  const list = ensureIds();
  const rank = { core: 0, working: 1, ephemeral: 2 };
  return list.map(it => ({ ...it }))
    .sort((a, b) => (rank[a.scope] - rank[b.scope])
      || (a.scope === 'core' ? String(a.createdAt).localeCompare(String(b.createdAt)) : effKey(b).localeCompare(effKey(a))));
}

function normalize(s) { return String(s || '').replace(/\s+/g, ''); }

// 新增（save_memory 工具 / 面板 / 兜底共用）：
//   · 与现有条目逐字同文 → 合并（更新内容与 createdAt，不另开条目）
//   · core 写入超字数预算 → 降级 working，回执注明
function addMemory({ type, content, importance, scope, ttlDays } = {}) {
  const text = String(content || '').trim();
  if (!text) throw new Error('记忆内容不能为空');
  const list = ensureIds();
  const norm = normalize(text);
  const dup = list.find(i => normalize(i.content) === norm);
  const now = new Date().toISOString();
  if (dup) {
    dup.content = capText(text, 60);
    dup.type = TYPES.includes(type) ? type : dup.type;
    if (Number.isFinite(+importance)) dup.importance = Math.min(5, Math.max(1, Math.round(+importance)));
    dup.createdAt = now; // 合并视为该认知被再次确认，时间戳刷新（影响 working 注入顺位）
    sweep();
    return { ...dup, merged: true };
  }
  let sc = SCOPES.includes(scope) ? scope : 'working';
  let note = '';
  if (sc === 'core' && coreChars(list) + Math.min(text.length, 60) > CORE_CHAR_BUDGET) {
    sc = 'working';
    note = `core 已满（${coreChars(list)}/${CORE_CHAR_BUDGET} 字上限），本条按 working 写入；如需入 core 请在记忆面板调整`;
  }
  const item = {
    id: 'mem_' + Date.now().toString(36) + '_' + (++seq),
    type: TYPES.includes(type) ? type : 'fact',
    content: capText(text, 60),
    importance: Math.min(5, Math.max(1, Math.round(+importance) || 2)),
    scope: sc,
    createdAt: now,
    ...(sc === 'ephemeral' ? { ttlDays: Math.min(90, Math.max(1, Math.round(+ttlDays) || EPHEMERAL_TTL_DAYS)) } : {}),
  };
  if (note) item.note = note;
  list.push(item);
  sweep();
  return { ...item };
}

// 自动提取结果的落库口（chat.js runExtract 调用）：
//   · mergeInto 命中现有 id → 原位合并（content 换成合并后的完整描述，createdAt 刷新）
//   · mergeInto 指向 core 条目 → 拒绝合并、按新 working 条目落库（自动提取禁止写 core）
//   · 其余按新条目落库，scope 强制 working（自动提取是漂移源，core 只收显式写入）
function mergeExtracted(extracted) {
  const list = ensureIds();
  const now = new Date().toISOString();
  let added = 0, merged = 0;
  for (const x of extracted) {
    const text = capText(String(x.content || '').trim(), 60);
    if (!text) continue;
    if (x.mergeInto) {
      const target = list.find(i => i.id === x.mergeInto);
      if (target && target.scope !== 'core') {
        target.content = text;
        target.type = TYPES.includes(x.type) ? x.type : target.type;
        target.createdAt = now;
        merged++;
        continue;
      }
      // 指向不存在/core 的 mergeInto：按新条目走（信息不丢）
    }
    const item = {
      id: 'mem_' + Date.now().toString(36) + '_' + (++seq),
      type: TYPES.includes(x.type) ? x.type : 'fact',
      content: text,
      importance: Math.min(5, Math.max(1, Math.round(+x.importance) || 2)),
      scope: 'working',
      createdAt: now,
    };
    list.push(item);
    added++;
  }
  sweep();
  return { added, merged };
}

// 注入面（prompts.memoriesBlock 用）：core 全量（升序）+ working 最近 8（有效时序降序）；ephemeral 不注入
function injectable() {
  const list = ensureIds();
  const core = list.filter(i => i.scope === 'core')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const working = list.filter(i => i.scope === 'working')
    .sort((a, b) => effKey(b).localeCompare(effKey(a)))
    .slice(0, 8);
  return { core, working };
}

function deleteMemory(id) {
  const list = ensureIds();
  const idx = list.findIndex(it => it.id === id);
  if (idx < 0) return false;
  list.splice(idx, 1);
  persist();
  return true;
}

function setScope(id, scope) {
  if (!SCOPES.includes(scope)) throw new Error('未知 scope: ' + scope);
  const list = ensureIds();
  const it = list.find(x => x.id === id);
  if (!it) throw new Error('找不到这条记忆');
  if (scope === 'core' && it.scope !== 'core' && coreChars(list.filter(x => x.id !== id)) + String(it.content).length > CORE_CHAR_BUDGET) {
    throw new Error(`core 已满（${coreChars(list.filter(x => x.id !== id))}/${CORE_CHAR_BUDGET} 字上限）。先移出或删除一条 core 再试`);
  }
  it.scope = scope;
  if (scope === 'ephemeral' && !it.ttlDays) it.ttlDays = EPHEMERAL_TTL_DAYS;
  persist();
  return { ...it };
}

function coreUsage() { return { used: coreChars(items()), budget: CORE_CHAR_BUDGET }; }

// 归档查看/还原（面板）：restoreArchive 返回 {…item, note, evicted}
//   · 恢复 = 重新确认（restoredAt 记入有效时序）：满库时顶掉「另一条最旧」而非自己
//   · evicted = 为腾位而新归档的条目（空库位时为空数组）——面板如实转告用户
//   · 已过期的 ephemeral 不按限时恢复（否则下次写入即被再次归档）：转为 working 并在 note 注明
function listArchive() { return (doc().archive || []).slice().reverse(); }
function restoreArchive(id) {
  const d = doc();
  const archive = d.archive || [];
  const idx = archive.findIndex(a => a.id === id);
  if (idx < 0) throw new Error('找不到这条归档记忆');
  const [it] = archive.splice(idx, 1);
  delete it.archivedAt; delete it.reason; delete it.restoredAt;
  let note = '';
  if (it.scope === 'ephemeral' && isExpired(it, Date.now())) {
    it.scope = 'working';
    delete it.ttlDays;
    note = '该条原为限时事件且已过有效期，恢复为 working 长期记忆（如需限时可在列表中再改层级）';
  }
  it.restoredAt = new Date().toISOString();
  const before = archive.length; // sweep 若为腾位再归档，从这里起算新增
  (d.items || (d.items = [])).push(it);
  sweep();
  const evicted = (d.archive || []).slice(before).map(e => ({ content: e.content, reason: e.reason }));
  return { ...it, note, evicted };
}

module.exports = {
  isMemoryCommand, listMemories, addMemory, deleteMemory, setScope, mergeExtracted,
  injectable, coreUsage, listArchive, restoreArchive,
  TYPES, SCOPES, MAX, CORE_CHAR_BUDGET, EPHEMERAL_TTL_DAYS,
};
