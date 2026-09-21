// 写操作差分归因：「模型改了什么」由前后快照实测，不靠模型自述。
// 快照区 = fs-guard 写白名单的工具可达区：temp/ 全部 + userData 根层文件 + config/
// （排除 logs/books/activity/chats/library/schedule/memory/sprites 等非写工具目标区）。
// 每文件记 {size, mtimeMs}（不哈希）；diff 靠读取内容（写前内容在写入前捕获）。
const fs = require('fs');
const path = require('path');
const guard = require('../fs-guard');

const MAX_DIFF_LINES = 200;      // 每文件差异行上限，超出截断标注
const MAX_LCS_LINES = 1500;      // LCS 单侧行数上限（超出降级为整体替换视图）
const MAX_READ_BYTES = 256 * 1024; // 超过此大小的文件不读内容，只记元数据

function createTracer() {
  let baseline = null;                 // Map<path, {size, mtimeMs}>
  const toolWrites = new Map();        // path -> change 条目（origin:'tool'）
  const beforeContents = new Map();    // path -> string|null（写前内容；null=当时不存在）

  function listZoneFiles(dir, recursive) {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return out; }
    for (const name of names) {
      if (name.endsWith('.tmp')) continue; // 原子写临时文件，跳过
      const full = path.join(dir, name);
      let st = null;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.isDirectory()) {
        if (recursive) out.push(...listZoneFiles(full, true));
      } else {
        out.push(full);
      }
    }
    return out;
  }

  // 快照区文件全集（相对 include 列表，其余子目录天然排除）
  function walkZones() {
    const root = guard.getUserDataDir();
    if (!root) return [];
    const files = [];
    for (const f of listZoneFiles(root, false)) files.push(f);           // 根层文件
    for (const f of listZoneFiles(path.join(root, 'config'), false)) files.push(f);
    for (const f of listZoneFiles(path.join(root, 'temp'), true)) files.push(f);
    return files;
  }

  function statOf(p) {
    try { return fs.statSync(p); } catch (_) { return null; }
  }

  function readContent(p) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MAX_READ_BYTES) return undefined; // undefined = 过大/不可读
      return fs.readFileSync(p, 'utf8');
    } catch (_) { return undefined; }
  }

  // run 开始（首次工具调用时）建立基线
  function captureBaseline() {
    baseline = new Map();
    for (const p of walkZones()) {
      const st = statOf(p);
      if (st) baseline.set(p, { size: st.size, mtimeMs: st.mtimeMs });
    }
  }

  // 写工具 invoke 前捕获单文件 before 内容
  function captureBeforeWrite(p) {
    beforeContents.set(p, readContent(p));
  }

  // 写工具 invoke 后记录单文件变更（before/after + 行级 diff）
  function recordToolWrite(p) {
    const existed = baseline && baseline.has(p);
    const before = beforeContents.has(p) ? beforeContents.get(p) : readContent(p);
    const after = readContent(p);
    const st = statOf(p) || { size: 0, mtimeMs: 0 };
    const entry = {
      path: p,
      kind: existed ? 'overwrite' : 'create',
      origin: 'tool',
      before: existed ? baseline.get(p) : { size: 0, mtimeMs: 0 },
      after: { size: st.size, mtimeMs: st.mtimeMs },
      ...buildHunks(before, after),
    };
    if (existed && before === undefined) entry.note = '原文件过大或不可读，仅展示写入后内容';
    toolWrites.set(p, entry);
  }

  // 收尾：全量对比基线 → 变更列表；不在工具结果里的变更标 ambiguous
  function finalizeRun() {
    const changed = [...toolWrites.values()];
    if (baseline) {
      const now = new Map();
      for (const p of walkZones()) {
        const st = statOf(p);
        if (st) now.set(p, { size: st.size, mtimeMs: st.mtimeMs });
      }
      for (const [p, cur] of now) {
        if (toolWrites.has(p)) continue;
        const base = baseline.get(p);
        const isNew = !base;
        const modified = base && (base.size !== cur.size || base.mtimeMs !== cur.mtimeMs);
        if (!isNew && !modified) continue;
        // 基线时已不在（或元数据相同却出现）且无工具认领 → 来源不明，不认领
        changed.push({
          path: p,
          kind: isNew ? 'create' : 'overwrite',
          origin: 'ambiguous',
          before: base || { size: 0, mtimeMs: 0 },
          after: cur,
          ...buildHunks(undefined, readContent(p)),
        });
      }
    }
    return { changed, hasAmbiguous: changed.some(c => c.origin === 'ambiguous') };
  }

  return { captureBaseline, captureBeforeWrite, recordToolWrite, finalizeRun };
}

// ---- 行级 diff（自实现 LCS，不引第三方库）----
function buildHunks(before, after) {
  if (after === undefined) return { hunks: [], truncated: false, note: '文件过大或不可读，未生成内容 diff' };
  const a = typeof before === 'string' ? before.split('\n') : [];
  const b = String(after).split('\n');
  if (before === after) return { hunks: [], truncated: false };

  let ops; // 编辑脚本：[-,aLine] / [+,bLine] / [=,line]
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    // 超出 LCS 规模：降级为整体替换（截断展示）
    ops = [];
    for (const l of a.slice(0, MAX_DIFF_LINES)) ops.push(['-', l]);
    for (const l of b.slice(0, MAX_DIFF_LINES)) ops.push(['+', l]);
    return groupHunks(ops, true);
  }

  // LCS DP（滚动数组回溯用完整表，规模已受限）
  const n = a.length, m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push(['=', a[i]]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) { ops.push(['-', a[i]]); i++; }
  while (j < m) { ops.push(['+', b[j]]); j++; }
  return groupHunks(ops, false);
}

// 编辑脚本 → 连续变更块；差异行数超上限截断
function groupHunks(ops, forceTruncated) {
  const hunks = [];
  let ai = 0, bi = 0;          // 当前 a/b 行号（0 起）
  let cur = null;              // 进行中的 hunk
  let diffLines = 0, truncated = !!forceTruncated;
  const flush = () => { if (cur && (cur.aLines.length || cur.bLines.length)) hunks.push(cur); cur = null; };
  for (const [op, line] of ops) {
    if (op === '=') { flush(); ai++; bi++; continue; }
    if (diffLines >= MAX_DIFF_LINES) { truncated = true; break; }
    if (!cur) cur = { aStart: ai, aLines: [], bStart: bi, bLines: [] };
    if (op === '-') { cur.aLines.push(line); ai++; } else { cur.bLines.push(line); bi++; }
    diffLines++;
  }
  flush();
  return { hunks, truncated };
}

module.exports = { createTracer, diffLines: buildHunks };
