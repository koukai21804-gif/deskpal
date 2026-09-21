// agent/runs.jsonl 轻量台账：追加式记录每个 run 的全过程（llm 轮/工具/权限/进展/变更）。
// 写记录的只有主进程（模型输出只是步骤素材，无伪造面）。
// 启动恢复：status:'running' → 标 'interrupted' 并原子重写；只对账，永不自动重跑。
const fs = require('fs');
const path = require('path');
const store = require('../store');
const logger = require('../../logger');

const MAX_RUNS = 500; // 台账保留上限（启动重写时裁剪最旧的）
let seq = 0;

function runsFile() { return path.join(store.getDataDir(), 'agent', 'runs.jsonl'); }

function newRunId() { return 'run_' + Date.now().toString(36) + '_' + (++seq); }

// 追加一行（record 须已含 id）
function append(record) {
  try {
    fs.mkdirSync(path.dirname(runsFile()), { recursive: true });
    fs.appendFileSync(runsFile(), JSON.stringify(record) + '\n', 'utf8');
  } catch (e) { logger.error(e); }
}

function readAll() {
  const out = [];
  try {
    const text = fs.readFileSync(runsFile(), 'utf8');
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch (_) { /* 跳过坏行 */ }
    }
  } catch (_) { /* 文件不存在 */ }
  return out;
}

// 查询（倒序，默认 20）
function query({ limit = 20 } = {}) {
  const all = readAll();
  return { runs: all.slice(-Math.max(1, limit)).reverse() };
}

// 收尾：按 id 替换该 run 的记录行（追加式台账的收尾重写，原子落盘）
function update(record) {
  const all = readAll();
  const i = all.findIndex(r => r && r.id === record.id);
  if (i >= 0) all[i] = record; else all.push(record);
  try {
    fs.mkdirSync(path.dirname(runsFile()), { recursive: true });
    const tmp = runsFile() + '.rewrite.tmp';
    fs.writeFileSync(tmp, all.map(r => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, runsFile());
  } catch (e) { logger.error(e); }
}

// 启动恢复：running → interrupted；顺带裁剪超限旧记录
function markInterruptedOnBoot() {
  let runs = readAll();
  let newlyInterrupted = 0;
  runs = runs.map(r => {
    if (r && r.status === 'running') { newlyInterrupted++; return { ...r, status: 'interrupted' }; }
    return r;
  });
  if (runs.length > MAX_RUNS) { runs = runs.slice(runs.length - MAX_RUNS); }
  if (!newlyInterrupted && runs.length <= MAX_RUNS) return { interrupted: 0 };
  try {
    fs.mkdirSync(path.dirname(runsFile()), { recursive: true });
    const tmp = runsFile() + '.tmp';
    fs.writeFileSync(tmp, runs.map(r => JSON.stringify(r)).join('\n') + (runs.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, runsFile());
  } catch (e) { logger.error(e); return { interrupted: 0 }; }
  return { interrupted: newlyInterrupted };
}

module.exports = { newRunId, append, update, query, markInterruptedOnBoot };
