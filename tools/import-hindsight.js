#!/usr/bin/env node
// import-hindsight.js — deskpal 存量记忆导入 Hindsight（M2，执行案 v1.4 §5.3）
// 规则：
//   · memory/roleplay.json：working/ephemeral/archive 全量 retain；core 条目【结构性跳过】
//     ——评审 v1.3 §6.2 物理隔离（canon 不可变/注入主权/污染不可逆），不是「入库但标注」；
//   · user/profile.json：P1/P2/P2b/P3 非空键值 retain；P0 层【一并不导入】（修正 #2）；
//   · 幂等：tools/.hindsight-import-state.json 记录已导入 id/键，重复执行自动跳过；
//   · 限速 100ms/条；--dry-run 只打印计划不写库。
// 用法：node tools/import-hindsight.js [--dry-run]
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DRY = process.argv.includes('--dry-run');
const APPDATA = path.join(os.homedir(), 'AppData', 'Roaming', 'deskpal');
const STATE_FILE = path.join(__dirname, '.hindsight-import-state.json');

// 与 hindsight-bridge 同款默认（读 config/hindsight.json 以便改端口）
function loadCfg() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(APPDATA, 'config', 'hindsight.json'), 'utf8'));
    return { apiUrl: 'http://127.0.0.1:8890', bank: 'deskpal-tito', ...cfg };
  } catch (_) { return { apiUrl: 'http://127.0.0.1:8890', bank: 'deskpal-tito' }; }
}
const CFG = loadCfg();

let state = { done: [] };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
const doneSet = new Set(state.done || []);

const plan = [];
let skippedCore = 0, skippedP0 = 0, skippedDone = 0;

// ---- roleplay 记忆 ----
try {
  const rp = JSON.parse(fs.readFileSync(path.join(APPDATA, 'memory', 'roleplay.json'), 'utf8'));
  for (const it of rp.items || []) {
    if (it.scope === 'core') { skippedCore++; continue; } // 物理隔离（硬约束）
    const key = 'mem:' + (it.id || it.content);
    if (doneSet.has(key)) { skippedDone++; continue; }
    plan.push({
      key,
      content: it.content,
      context: 'deskpal 记忆库存量（' + it.type + '）',
      metadata: { scope: it.scope, type: it.type, importance: String(it.importance || ''), createdAt: it.createdAt || '', attribution: 'user', source: 'import-roleplay' },
      timestamp: it.createdAt || undefined,
    });
  }
  for (const it of rp.archive || []) {
    if (it.scope === 'core') { skippedCore++; continue; }
    const key = 'arch:' + (it.id || it.content);
    if (doneSet.has(key)) { skippedDone++; continue; }
    plan.push({
      key,
      content: it.content,
      context: 'deskpal 记忆库存档（' + it.type + '）',
      metadata: { scope: 'archive', type: it.type, createdAt: it.createdAt || '', attribution: 'user', source: 'import-archive' },
      timestamp: it.createdAt || undefined,
    });
  }
} catch (e) { console.error('roleplay.json 读取失败:', e.message); }

// ---- user profile（P1–P3；P0 跳过）----
try {
  const prof = JSON.parse(fs.readFileSync(path.join(APPDATA, 'user', 'profile.json'), 'utf8'));
  for (const layer of ['P1', 'P2', 'P2b', 'P3']) {
    const kv = prof[layer];
    if (!kv || typeof kv !== 'object') continue;
    for (const [k, v] of Object.entries(kv)) {
      const text = typeof v === 'string' ? v.trim() : JSON.stringify(v);
      if (!text) continue;
      const key = 'prof:' + layer + ':' + k;
      if (doneSet.has(key)) { skippedDone++; continue; }
      plan.push({
        key,
        content: `【${layer}·${k}】${text}`,
        context: 'deskpal 用户档案 ' + layer + ' 层',
        metadata: { layer, key: k, attribution: 'user', source: 'import-profile' },
      });
    }
  }
  skippedP0 = 1; // P0 整层跳过（结构性，非逐条）
} catch (e) { console.error('profile.json 读取失败:', e.message); }

console.log(`计划导入 ${plan.length} 条；跳过 core ${skippedCore} 条（物理隔离）、P0 整层（物理隔离）、已完成 ${skippedDone} 条${DRY ? '（dry-run，不写库）' : ''}`);

async function main() {
  if (DRY) {
    for (const p of plan.slice(0, 10)) console.log('  [DRY] ' + p.key + ' :: ' + String(p.content).slice(0, 50));
    console.log(`  …… 共 ${plan.length} 条`);
    return;
  }
  // 健康探测
  try {
    const h = await fetch(CFG.apiUrl + '/__proxy/health', { signal: AbortSignal.timeout(1500) });
    const j = await h.json();
    if (!j.upstream) throw new Error('上游 hindsight-api 未就绪');
    console.log('代理健康: proxy=ok upstream=ok l2=' + j.l2);
  } catch (e) { console.error('代理不可达（' + CFG.apiUrl + '）: ' + e.message + '。先运行 D:\\hindsight\\hindsight-service.bat start'); process.exit(1); }

  let okCnt = 0, failCnt = 0;
  for (const p of plan) {
    try {
      const r = await fetch(`${CFG.apiUrl}/v1/default/banks/${CFG.bank}/memories`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ content: p.content, context: p.context, metadata: p.metadata, timestamp: p.timestamp }], async: false }),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 100));
      okCnt++;
      doneSet.add(p.key);
      if (okCnt % 10 === 0) {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ done: [...doneSet] }, null, 1));
        console.log(`  进度 ${okCnt + failCnt}/${plan.length}`);
      }
    } catch (e) { failCnt++; console.error('  失败 ' + p.key + ': ' + e.message); }
    await new Promise(r => setTimeout(r, 100)); // 限速
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify({ done: [...doneSet] }, null, 1));
  console.log(`完成：成功 ${okCnt}，失败 ${failCnt}（state 已存 ${doneSet.size} 条）`);
  process.exit(failCnt ? 1 : 0);
}
main();
