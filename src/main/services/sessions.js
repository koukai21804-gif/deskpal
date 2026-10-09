// 多会话管理（v0.5）：主对话（角色扮演常驻）+ 多个专项会话（具体任务/专项场景）。
// 数据形状（chats/roleplay）：{ schema:2, sessions:[{id,name,kind,goal,messages,
// userCountSince,lastExtractAt,createdAt,updatedAt}], activeSessionId }。
// 设计约束：
//   · 记忆提取/档案漂移的计数随会话走——切走会话前由 chat.js 先 flush，跨会话不丢未提取信息；
//   · 迁移一次性：旧单线程形状（messages[]）→ sessions[0]（kind=main），迁移前把原文件
//     复制为 roleplay.pre-sessions-*.bak.json（盘上留原件，不靠代码回滚）；
//   · 本模块只碰数据形状，不碰 LLM/计时器——切会话时的 flush 编排在 chat.js。
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const store = require('./store');
const logger = require('../logger');

const KEY = 'chats/roleplay';
const MAIN_ID = 's_main';

function newId() { return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// 旧形状 → sessions[0]。幂等：已迁移（sessions 非空）原样返回。
// 返回 { doc, migrated }；doc 是 store 缓存里的活对象（调用方改完用 persist 落盘）。
function ensure() {
  const doc = store.get(KEY);
  if (Array.isArray(doc.sessions) && doc.sessions.length) {
    if (!doc.sessions.find(s => s.id === doc.activeSessionId)) {
      doc.activeSessionId = doc.sessions[0].id;
      persist(doc);
    }
    return { doc, migrated: false };
  }
  // 迁移前留备份（只在确有历史消息时；空库跳过，避免测试/首装产生垃圾备份）
  const legacyMsgs = Array.isArray(doc.messages) ? doc.messages : [];
  if (legacyMsgs.length) {
    try {
      const src = store.filePathOf(KEY);
      const bak = path.join(path.dirname(src), 'roleplay.pre-sessions-' + dayjs().format('YYYYMMDD-HHmm') + '.bak.json');
      if (fs.existsSync(src)) fs.copyFileSync(src, bak);
      logger.info('[sessions] 单线程历史已迁移为多会话，原件备份至 ' + bak);
    } catch (e) { logger.warn('[sessions] 迁移备份失败（继续迁移）: ' + e.message); }
  }
  const now = dayjs().format();
  const main = {
    id: MAIN_ID, name: '主对话', kind: 'main', goal: '',
    messages: legacyMsgs.slice(-200),
    userCountSince: doc.userCountSince || 0,
    lastExtractAt: doc.lastExtractAt || null,
    createdAt: now, updatedAt: now,
  };
  const migrated = {
    schema: 2, sessions: [main], activeSessionId: MAIN_ID, lastExtractAt: doc.lastExtractAt || null,
  };
  store.replace(KEY, migrated);
  return { doc: store.get(KEY), migrated: true };
}

function persist(doc) { store.replace(KEY, doc); }

// 当前活跃会话（活对象引用：改字段后调 persist 落盘）
function active() {
  const { doc } = ensure();
  return doc.sessions.find(s => s.id === doc.activeSessionId) || doc.sessions[0];
}

// 面板列表：剥掉 messages 大数组
function list() {
  const { doc } = ensure();
  return {
    activeSessionId: doc.activeSessionId,
    sessions: doc.sessions.map(s => ({
      id: s.id, name: s.name, kind: s.kind, goal: s.goal || '',
      msgCount: (s.messages || []).length,
      userCountSince: s.userCountSince || 0,
      createdAt: s.createdAt, updatedAt: s.updatedAt,
    })),
  };
}

function find(id) {
  const { doc } = ensure();
  return doc.sessions.find(s => s.id === id) || null;
}

// 新建专项会话（不切 active——切换由 chat.js 在 flush 完旧会话后调 switchTo）
function create({ name, goal } = {}) {
  const { doc } = ensure();
  const n = doc.sessions.filter(s => s.kind !== 'main').length + 1;
  const sess = {
    id: newId(),
    name: String(name || '').trim().slice(0, 24) || `专项会话 ${n}`,
    kind: 'task',
    goal: String(goal || '').trim().slice(0, 120),
    messages: [], userCountSince: 0, lastExtractAt: null,
    createdAt: dayjs().format(), updatedAt: dayjs().format(),
  };
  doc.sessions.push(sess);
  persist(doc);
  return sess;
}

// 切换 active（数据层；flush 编排在 chat.js）
function switchTo(id) {
  const { doc } = ensure();
  const sess = find(id);
  if (!sess) throw new Error('找不到这个会话');
  if (doc.activeSessionId !== sess.id) {
    doc.activeSessionId = sess.id;
    persist(doc);
  }
  return sess;
}

function rename(id, { name, goal } = {}) {
  const sess = find(id);
  if (!sess) throw new Error('找不到这个会话');
  if (name !== undefined) sess.name = String(name).trim().slice(0, 24) || sess.name;
  if (goal !== undefined) sess.goal = String(goal).trim().slice(0, 120);
  persist(ensure().doc);
  return sess;
}

// 删除会话：主对话不可删；删的是活跃会话时 active 回落到主对话（不 flush——删除=显式丢弃）
function del(id) {
  const { doc } = ensure();
  const sess = find(id);
  if (!sess) throw new Error('找不到这个会话');
  if (sess.kind === 'main') throw new Error('主对话不能删除（它是角色扮演的常驻对话）');
  doc.sessions = doc.sessions.filter(s => s.id !== id);
  if (doc.activeSessionId === id) doc.activeSessionId = MAIN_ID;
  persist(doc);
  return { ok: true, activeSessionId: doc.activeSessionId };
}

// 会话消息变动后刷新时间戳（saveHistory 用）
function touch(sess) { sess.updatedAt = dayjs().format(); }

module.exports = { KEY, MAIN_ID, ensure, persist, active, list, find, create, switchTo, rename, del, touch };
