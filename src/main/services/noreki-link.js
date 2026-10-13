// noreki-link.js — NOREKI-Mail v1.5（titor@deskpal 侧收发端点 + 状态账本）
// 协议：D:/NorekiLink/PROTOCOL.md。分离铁律：本模块只碰 D:/NorekiLink 与
// 己方 userData 的密钥文件；绝不读写 Hermes 的 profile/记忆库/状态库。
// v0.5.1 · 2026-10-11 · 作者：克莉奥（经父亲工作轮批准接入 deskpal）
// v1.5 变更（2026-10-11，父亲拍板方案A）：
//   · 状态账本 ledger.json（己方 userData）：unread/read/sent 三区，显式文件，LLM 不记账
//   · mailboxSummary()：给 prompts.js 注入信箱认知（未读数/最近已发）
//   · readUnread()：前辈「查看来信」→ 未读转已读 + 信文交聊天管线入史
//   · send() 写 sent 账本（含主题摘要）——「记得自己发过信」的字面实现
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../logger');
const windows = require('../windows');

// N-9 测试注：环境变量可覆写邮局根目录（仅测试用；默认路径不变）
const LINK_ROOT = process.env.NOREKI_LINK_ROOT || 'D:/NorekiLink';
const SELF_ID = 'titor@deskpal';
const PEER_ID = 'clio@hermes';
const OUTBOX_SUB = 'from-deskpal';   // 我写
const INBOX_SUB = 'from-hermes';     // 我收
const ARCHIVE_SUB = 'from-hermes';   // 收妥归档（协议 §1：收谁的信归谁的档）

// 密钥：签名钥在己方 userData；对端验签钥在中性邮局 keys/（建局时放置，只读）
function selfKeyPath(dataDir) { return path.join(dataDir, 'config', 'noreki-mail.key'); }
function peerVerifyKeyPath() { return path.join(LINK_ROOT, 'keys', 'clio.verify.key'); }

// ---------------- 协议核（与 clio 侧 noreki-mail.py 逐字节一致） ----------------

function canonical(env) {
  return [
    env.ver, env.id, env.from, env.to, env.kind, env.body,
    env.ref, env.sentAt, String(parseInt(env.ttlSec, 10)), env.nonce,
  ].join('\n');
}

function sign(keyHex, env) {
  return crypto.createHmac('sha256', Buffer.from(keyHex, 'hex'))
    .update(Buffer.from(canonical(env), 'utf8'))
    .digest('hex');
}

function verify(keyHex, env) {
  const want = sign(keyHex, env);
  const got = String(env.sig || '');
  if (want.length !== got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

function newId(n = 6) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
}

function nowIso() {
  // +08:00 固定时区，与 clio 侧 datetime.isoformat(timespec='ms') 对齐
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace('Z', '').replace(/\.(\d{3})$/, '.$1') + '+08:00';
}

// ---------------- 状态账本（v1.5：显式文件，三区：unread/read/sent） ----------------
// 账本在己方 realm（<dataDir>/noreki-link/ledger.json），不进中性邮局。
// 主题摘要 = 正文首行截 48 字符——账本给人看、给 prompt 引用，不存全文。

function ledgerFile() { return path.join(state.dataDir, 'noreki-link', 'ledger.json'); }

function subjectOf(body) {
  const first = String(body || '').split('\n').find(l => l.trim()) || '';
  return first.trim().slice(0, 48) + (first.trim().length > 48 ? '…' : '');
}

function loadLedger() {
  const def = { ver: 1, unread: [], read: [], sent: [], lastSyncAt: null };
  try {
    const d = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'));
    return { ...def, ...d, unread: Array.isArray(d.unread) ? d.unread : [], read: Array.isArray(d.read) ? d.read : [], sent: Array.isArray(d.sent) ? d.sent : [] };
  } catch (_) { return def; }
}

function saveLedger(doc) {
  fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
  doc.lastSyncAt = nowIso();
  atomicWriteJson(ledgerFile(), doc);
}

function ledgerAddUnread(env) {
  const doc = loadLedger();
  if (doc.unread.some(m => m.id === env.id) || doc.read.some(m => m.id === env.id)) return;
  doc.unread.push({ id: env.id, kind: env.kind, from: env.from, subject: subjectOf(env.body), sentAt: env.sentAt, fetchedAt: nowIso(), ref: env.ref || '' });
  doc.unread = doc.unread.slice(-50); // 防膨胀：未读最多 50 封（正常 flow 不积压）
  saveLedger(doc);
}

function ledgerAddSent(id, kind, body) {
  const doc = loadLedger();
  doc.sent.push({ id, kind, subject: subjectOf(body), sentAt: nowIso(), status: 'pending' });
  doc.sent = doc.sent.slice(-100);
  saveLedger(doc);
}

// 对账：sent 里 pending 的信，若已从我方 outbox 消失（被 clio 领走）→ delivered
function reconcileSent() {
  const doc = loadLedger();
  let outboxNames = [];
  try { outboxNames = fs.readdirSync(path.join(LINK_ROOT, 'outbox', OUTBOX_SUB)); } catch (_) {}
  const pendingIds = new Set(outboxNames.map(n => (n.match(/_([A-Z0-9]+)\.json$/) || [])[1]).filter(Boolean));
  let changed = false;
  for (const s of doc.sent) {
    if (s.status === 'pending' && !pendingIds.has(s.id)) { s.status = 'delivered'; s.deliveredAt = nowIso(); changed = true; }
  }
  if (changed) saveLedger(doc);
  return changed;
}

// 信箱认知摘要：给 system prompt 注入（她「知道信箱」的字面实现）
function mailboxSummary() {
  reconcileSent();
  const doc = loadLedger();
  const recentSent = doc.sent.slice(-3).map(s => `${s.subject}（${s.status === 'delivered' ? '对方已收' : '已投递待领'}）`);
  return {
    unreadCount: doc.unread.length,
    unread: doc.unread.slice(-5).map(m => ({ id: m.id, kind: m.kind, subject: m.subject, sentAt: m.sentAt })),
    sentCount: doc.sent.length,
    recentSent,
  };
}

// 查看来信：unread → read，返回完整信文（聊天管线据此入史）
function readUnread() {
  const doc = loadLedger();
  if (!doc.unread.length) return [];
  const mails = doc.unread.map(m => {
    // 从收件归档读回全文（信件正文永不进账本，账本只存摘要）
    let body = null;
    try {
      const archDir = path.join(LINK_ROOT, 'archive', ARCHIVE_SUB);
      const hit = fs.readdirSync(archDir).find(f => f.endsWith('_' + m.id + '.json'));
      if (hit) body = JSON.parse(fs.readFileSync(path.join(archDir, hit), 'utf8')).body;
    } catch (_) {}
    return { ...m, body: body != null ? body : '(信文已不可读)', readAt: nowIso() };
  });
  doc.read.push(...mails.map(({ body, ...meta }) => ({ ...meta, bodyLen: body ? body.length : 0 })));
  doc.unread = [];
  saveLedger(doc);
  return mails;
}

function unreadCount() { return loadLedger().unread.length; }

// ---------------- 信封与投递 ----------------

function makeEnvelope(kind, body, ref = '') {
  const env = {
    ver: 'noreki-mail/1',
    id: newId(),
    from: SELF_ID,
    to: PEER_ID,
    kind,
    body: String(body || ''),
    ref: ref || '',
    sentAt: nowIso(),
    ttlSec: 86400,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  env.sig = sign(state.key, env);
  return env;
}

let state = { key: null, watcher: null, seen: new Set(), dataDir: null, poll: null };

function ensureDirs() {
  for (const sub of ['outbox/from-hermes', 'outbox/from-deskpal', 'archive/from-hermes/rejected', 'archive/from-deskpal/rejected', 'logs']) {
    fs.mkdirSync(path.join(LINK_ROOT, sub), { recursive: true });
  }
}

function atomicWriteJson(dest, obj) {
  const tmp = path.join(path.dirname(dest), '.tmp-' + path.basename(dest));
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, dest);
}

// 文件名时间戳：20261011T200008128（本地 +08:00）
function stampName() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${d.getUTCMilliseconds().toString().padStart(3, '0')}`;
}

// N-9 修复（2026-10-13，问题清单 v1.1 §2.5）：发送三步闭环——「写 outbox → 读回校验 → 记账 sent」
// 全部成功才返回 id；报 id = 已确认落 outbox 的硬保证。根因：原实现不调 ensureDirs，outbox 目录
// 缺失时 atomicWriteJson 抛异常（信封 id 已生成、日志未落），向上变成悬空的「假成功」。
// 台账失败若发生在信已落 outbox 之后：重试一次，仍失败则如实返回 ok+ledgerError（不回滚不假报错，
// 也不让调用方重发造成重复投递——交付真相以 outbox 读回为准，台账缺口进日志供巡检）。
function send(kind, body, ref = '') {
  try {
    if (!state.key) return { ok: false, error: 'not-initialized' };
    const env = makeEnvelope(kind, body, ref);
    try { ensureDirs(); } catch (e) {
      log('send', env.id, 'error', 'ensure-dirs: ' + e.message);
      return { ok: false, error: 'outbox-prepare-failed', detail: e.message };
    }
    const outbox = path.join(LINK_ROOT, 'outbox', OUTBOX_SUB);
    const dest = path.join(outbox, stampName() + '_' + env.id + '.json');
    // 步骤 1：原子写 outbox
    try { atomicWriteJson(dest, env); } catch (e) {
      log('send', env.id, 'error', 'outbox-write: ' + e.message);
      return { ok: false, error: 'outbox-write-failed', detail: e.message };
    }
    // 步骤 2：读回校验（信封完整性与 id 一致）
    try {
      const back = JSON.parse(fs.readFileSync(dest, 'utf8'));
      if (back.id !== env.id || back.body !== env.body) throw new Error('readback-mismatch');
    } catch (e) {
      try { fs.unlinkSync(dest); } catch (_) {}
      log('send', env.id, 'error', 'readback: ' + e.message);
      return { ok: false, error: 'outbox-readback-failed', detail: e.message };
    }
    // 步骤 3：sent 台账（重试一次）
    let ledgerError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { ledgerAddSent(env.id, env.kind, env.body); ledgerError = null; break; }
      catch (e) { ledgerError = e.message; log('ledger', env.id, 'error', `attempt${attempt + 1}: ` + e.message); }
    }
    log('send', env.id, 'ok', path.basename(dest));
    // 已发留档 → 己方 realm（协议 §1：中性 archive 只属于收件方；发件存根不入邮局，
    // 否则与收件方的 archive/from-deskpal 语义相撞——20261011 实测踩雷修正）。非关键路径，失败仅告警。
    try {
      const sentArch = path.join(state.dataDir, 'noreki-link', 'sent');
      fs.mkdirSync(sentArch, { recursive: true });
      fs.copyFileSync(dest, path.join(sentArch, path.basename(dest)));
    } catch (e) { log('sent-archive', env.id, 'error', e.message); }
    const result = { ok: true, id: env.id, file: dest, subject: subjectOf(env.body) };
    if (ledgerError) { result.ledgerError = ledgerError; log('send', env.id, 'warn', 'ledger-write-failed: ' + ledgerError); }
    return result;
  } catch (e) {
    // 兜底：send 永不向上抛异常（异常会绕过返回值契约，造成调用方拿不到确定结果）
    return { ok: false, error: 'send-exception', detail: e.message };
  }
}

// ---------------- 接收 ----------------

function seenFile() { return path.join(LINK_ROOT, 'logs', 'deskpal-seen.json'); }

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(seenFile(), 'utf8'))); } catch (_) { return new Set(); }
}

function saveSeen(seen) {
  try { fs.writeFileSync(seenFile(), JSON.stringify([...seen].sort()), 'utf8'); } catch (_) {}
}

function log(action, mid, result, detail = '') {
  try {
    const line = JSON.stringify({ at: nowIso(), by: SELF_ID, action, id: mid, result, detail });
    fs.appendFileSync(path.join(LINK_ROOT, 'logs', 'delivery.jsonl'), line + '\n', 'utf8');
  } catch (_) {}
}

// 领信：验签→验收件人→验 TTL→去重→归档→通知 UI
function fetchOnce() {
  if (!state.key) return;
  const inbox = path.join(LINK_ROOT, 'outbox', INBOX_SUB);
  const arch = path.join(LINK_ROOT, 'archive', ARCHIVE_SUB);
  const rej = path.join(arch, 'rejected');
  let peerKey = null;
  try { peerKey = fs.readFileSync(peerVerifyKeyPath(), 'utf8').trim(); } catch (_) {
    log('fetch', '-', 'no-peer-key', peerVerifyKeyPath());
    return;
  }
  ensureDirs();
  const seen = loadSeen();
  let files = [];
  try { files = fs.readdirSync(inbox).filter(f => f.endsWith('.json')).sort(); } catch (_) { return; }
  let got = 0;
  for (const name of files) {
    const full = path.join(inbox, name);
    let env = null;
    try { env = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) {
      try { fs.renameSync(full, path.join(rej, name + '.parse-error')); } catch (_) {}
      log('fetch', name, 'rejected', 'parse-error');
      continue;
    }
    const reject = (reason) => {
      try { fs.renameSync(full, path.join(rej, name + '.' + reason)); } catch (_) {}
      log('fetch', (env && env.id) || name, 'rejected', reason);
    };
    if (!env || env.ver !== 'noreki-mail/1') { reject('ver-mismatch'); continue; }
    if (env.to !== SELF_ID) { reject('not-addressed-to-me'); continue; }
    let okSig = false;
    try { okSig = verify(peerKey, env); } catch (_) {}
    if (!okSig) { reject('bad-signature'); continue; }
    const sentMs = Date.parse(env.sentAt);
    if (Number.isFinite(sentMs) && Date.now() > sentMs + (parseInt(env.ttlSec, 10) || 0) * 1000) { reject('expired'); continue; }
    if (seen.has(env.id)) { reject('duplicate'); continue; }
    // 投递 = 领走
    try { fs.renameSync(full, path.join(arch, name)); } catch (_) { continue; }
    seen.add(env.id);
    got++;
    log('fetch', env.id, 'delivered', name);
    // v1.5：未读入账本（感知锚点——prompt 注入与未读提醒都从账本读）
    try { ledgerAddUnread(env); } catch (e) { log('ledger', env.id, 'error', e.message); }
    // UI 通知：宠物气泡 + 聊天窗未读刷新
    try {
      windows.broadcastAll('pet:bubble', {
        kind: 'link-msg',
        text: `收到 ${env.from} 的信（${env.kind}）：${subjectOf(env.body)}`,
        mailId: env.id,
      });
      windows.broadcastAll('noreki:mail', { env, unread: unreadCount() });
    } catch (_) {}
  }
  if (got) saveSeen(seen);
  return got;
}

// ---------------- 初始化 ----------------

function init(dataDir) {
  state.dataDir = dataDir;
  ensureDirs();
  try { state.key = fs.readFileSync(selfKeyPath(dataDir), 'utf8').trim(); } catch (_) {
    log('init', '-', 'no-self-key', selfKeyPath(dataDir));
    return { ok: false, reason: 'no-self-key' };
  }
  // 启动全扫 + watch
  try { fetchOnce(); } catch (e) { log('fetch', '-', 'error', e.message); }
  try {
    state.watcher = fs.watch(path.join(LINK_ROOT, 'outbox', INBOX_SUB), { persistent: false }, () => {
      clearTimeout(state._deb);
      state._deb = setTimeout(() => { try { fetchOnce(); } catch (e) { log('fetch', '-', 'error', e.message); } }, 300);
    });
  } catch (e) { log('init', '-', 'watch-failed', e.message); }
  // 兜底轮询（watch 在 Windows 网络盘/某些 FS 上不可靠）
  state.poll = setInterval(() => { try { fetchOnce(); } catch (_) {} }, 15000);
  if (state.poll.unref) state.poll.unref();
  log('init', '-', 'ok', 'noreki-link ready');
  return { ok: true };
}

function shutdown() {
  try { if (state.watcher) state.watcher.close(); } catch (_) {}
  try { if (state.poll) clearInterval(state.poll); } catch (_) {}
}

module.exports = { init, shutdown, send, fetchOnce, mailboxSummary, readUnread, unreadCount, LINK_ROOT, SELF_ID, PEER_ID };
