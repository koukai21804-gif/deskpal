// 长期记忆管理服务：/deep memory forcing 斜杠命令的面板数据源
// 查看/添加/删除 memory/roleplay 条目。与 chat.js 的 memoryTick（自动提取）共用一份存储，
// 淘汰规则一致：上限 50，超出按（重要性升序，时间升序）淘汰。
// 该通道的所有操作不经过聊天历史/LLM，角色对此无感知（斜杠消息也不会入史）。
const store = require('./store');

const MAX = 50;
const TYPES = ['relationship', 'event', 'fact', 'preference'];
let seq = 0;

// 斜杠命令识别（渲染层与主进程双端同款正则；主进程兜底防止消息被误发进 LLM/历史）
const MEMORY_COMMAND_RE = /^\s*\/\s*deep\s+memory\s+forcing\s*$/i;
function isMemoryCommand(text) { return MEMORY_COMMAND_RE.test(String(text || '')); }

function items() { return store.get('memory/roleplay').items || []; }

function persist(list) { store.replace('memory/roleplay', { items: list }); }

// 旧条目没有 id：列出时补齐并落盘（一次性归一化），删除/展示都靠 id
function ensureIds() {
  const list = items();
  let dirty = false;
  for (const it of list) {
    if (!it.id) { it.id = 'mem_' + Date.now().toString(36) + '_' + (++seq); dirty = true; }
  }
  if (dirty) persist(list);
  return list;
}

function listMemories() {
  return ensureIds()
    .map(it => ({ ...it }))
    .sort((a, b) => (b.importance || 0) - (a.importance || 0) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function addMemory({ type, content, importance } = {}) {
  const text = String(content || '').trim();
  if (!text) throw new Error('记忆内容不能为空');
  const list = ensureIds();
  const item = {
    id: 'mem_' + Date.now().toString(36) + '_' + (++seq),
    type: TYPES.includes(type) ? type : 'fact',
    content: text.slice(0, 60),
    importance: Math.min(5, Math.max(1, Math.round(+importance) || 2)),
    createdAt: new Date().toISOString(),
  };
  list.push(item);
  if (list.length > MAX) {
    // 与 memoryTick 同款淘汰：按（重要性升序，时间升序）排后保留末尾 MAX 条（高重要性/新者优先）
    list.sort((a, b) => (a.importance - b.importance) || (a.createdAt < b.createdAt ? -1 : 1));
    list.splice(0, list.length - MAX);
  }
  persist(list);
  return { ...item };
}

function deleteMemory(id) {
  const list = ensureIds();
  const idx = list.findIndex(it => it.id === id);
  if (idx < 0) return false;
  list.splice(idx, 1);
  persist(list);
  return true;
}

module.exports = { isMemoryCommand, listMemories, addMemory, deleteMemory, TYPES, MAX };
