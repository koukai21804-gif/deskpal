// SQLite 只读访问：koffi 加载系统 winsqlite3.dll（Win10+ 自带），零新增原生依赖。
// 约束：只读打开（SQLITE_OPEN_READONLY=1）+ busy_timeout；被独占锁住的库（运行中的应用
// 以非 WAL 方式持有）复制到临时目录再开（Hermes DIPS 实测教训）。
// 返回行里：整数/浮点 → number，TEXT → string，BLOB → Buffer（utf8 JSON 场景由调用方 toString）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../../logger');

let lib = null, loadErr = null;
function load() {
  if (lib || loadErr) return lib;
  try {
    const koffi = require('koffi');
    const dll = koffi.load('winsqlite3.dll');
    lib = {
      open_v2: dll.func('int sqlite3_open_v2(const char*, _Out_ void**, int, const char*)'),
      prepare_v2: dll.func('int sqlite3_prepare_v2(void*, const char*, int, _Out_ void**, _Out_ void*)'),
      step: dll.func('int sqlite3_step(void*)'),
      column_count: dll.func('int sqlite3_column_count(void*)'),
      column_name: dll.func('const char* sqlite3_column_name(void*, int)'),
      column_type: dll.func('int sqlite3_column_type(void*, int)'),
      column_double: dll.func('double sqlite3_column_double(void*, int)'),
      column_text: dll.func('const char* sqlite3_column_text(void*, int)'),
      column_blob: dll.func('const void* sqlite3_column_blob(void*, int)'),
      column_bytes: dll.func('int sqlite3_column_bytes(void*, int)'),
      finalize: dll.func('int sqlite3_finalize(void*)'),
      close: dll.func('int sqlite3_close(void*)'),
      errmsg: dll.func('const char* sqlite3_errmsg(void*)'),
      busy_timeout: dll.func('int sqlite3_busy_timeout(void*, int)'),
    };
  } catch (e) { loadErr = e.message; logger.warn('winsqlite3 不可用：' + e.message); }
  return lib;
}

function available() { return !!load(); }

function openRaw(file) {
  const L = load();
  if (!L) return null;
  const p = [null];
  if (L.open_v2(file, p, 1, null) !== 0) return null;
  const db = p[0];
  try { L.busy_timeout(db, 1500); } catch (_) {}
  return db;
}

// 打开一个只读连接；原库被锁时复制（连同 -wal/-shm）到临时目录再开
function open(file) {
  let db = openRaw(file);
  if (db) return { db, tmp: null };
  const tmp = path.join(os.tmpdir(), 'dp-tb-' + Math.random().toString(36).slice(2) + '.db');
  try {
    fs.copyFileSync(file, tmp);
    for (const ext of ['-wal', '-shm']) { try { fs.copyFileSync(file + ext, tmp + ext); } catch (_) {} }
    db = openRaw(tmp);
    if (db) return { db, tmp };
    return null;
  } catch (_) { return null; }
}

function close(handle) {
  if (!handle) return;
  try { load().close(handle.db); } catch (_) {}
  if (handle.tmp) { for (const f of [handle.tmp, handle.tmp + '-wal', handle.tmp + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} } }
}

function readColumn(L, stmt, c) {
  const t = L.column_type(stmt, c);
  if (t === 5 || t === 0) return null; // NULL
  if (t === 1 || t === 2) return L.column_double(stmt, c);
  if (t === 3) { const p = L.column_text(stmt, c); return p ? p.toString() : ''; }
  if (t === 4) { // BLOB
    const n = L.column_bytes(stmt, c);
    const p = L.column_blob(stmt, c);
    if (!p || n <= 0) return Buffer.alloc(0);
    return Buffer.from(koffiDecode(p, n));
  }
  return null;
}
function koffiDecode(ptr, n) { // koffi 指针 → Buffer（惰性取 koffi，避免顶层依赖顺序问题）
  const koffi = require('koffi');
  return koffi.decode(ptr, 'uint8_t', n);
}

// 执行查询（无参数绑定；所有 SQL 由本模块调用方静态拼接，表名经 quoteIdent 转义）
function query(handle, sql, { maxRows = 100000 } = {}) {
  const L = load();
  if (!L || !handle) return [];
  const stmt = [null];
  if (L.prepare_v2(handle.db, sql, -1, stmt, null) !== 0) return [];
  const rows = [];
  try {
    const nCol = L.column_count(stmt[0]);
    while (rows.length < maxRows && L.step(stmt[0]) === 100) {
      const row = new Array(nCol);
      for (let c = 0; c < nCol; c++) row[c] = readColumn(L, stmt[0], c);
      rows.push(row);
    }
  } finally { try { L.finalize(stmt[0]); } catch (_) {} }
  return rows;
}

function quoteIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

// 列出用户表名（跳过 sqlite_ 内部表）
function listTables(handle) {
  return query(handle, "SELECT name FROM sqlite_master WHERE type='table'")
    .map(r => (r[0] && typeof r[0] === 'string') ? r[0] : null)
    .filter(n => n && !n.startsWith('sqlite_'));
}

module.exports = { available, open, close, query, quoteIdent, listTables };
