#!/usr/bin/env node
// logq（P1-7，借鉴 Cortico scripts/logq.ts 的台账检索思路）：agent/runs.jsonl 只读检索 CLI。
// 用法：
//   node scripts/logq.js runs [--limit 20] [--file <runs.jsonl>]   run 清单（倒序）
//   node scripts/logq.js turn <runId> [--full]                     单 run 完整回放（步骤断言按序）
//   node scripts/logq.js bundle <runId> [--out <file.md>] [--full] 脱敏导出（报障用）
// 默认数据文件：%APPDATA%/deskpal/agent/runs.jsonl（Electron userData），可用 --file 或
// 环境变量 DESKPAL_RUNS 覆盖。--full 显示全文；默认脱敏——正文/指令截断、密钥类字符串打码。
// 只读，永不写台账；bundle 写出的是新文件（默认当前目录 deskpal-runbundle-<runId>.md）。
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const hasFlag = (name) => args.includes(name);
const FULL = hasFlag('--full');

function runsFile() {
  if (hasFlag('--file')) return flag('--file');
  if (process.env.DESKPAL_RUNS) return process.env.DESKPAL_RUNS;
  const appData = process.env.APPDATA || (process.env.HOME ? path.join(process.env.HOME, 'AppData', 'Roaming') : '.');
  return path.join(appData, 'deskpal', 'agent', 'runs.jsonl');
}

function readAll(file) {
  const out = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* 坏行跳过 */ }
  }
  return out;
}

// 脱敏：密钥类字符串打码；长文本截断（--full 时不截）
const SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
function scrub(s, cap) {
  let t = String(s ?? '').replace(SECRET_RE, m => m.slice(0, 6) + '***');
  if (!FULL && Number.isFinite(cap) && t.length > cap) t = t.slice(0, cap) + `…（共 ${String(s).length} 字符，--full 看全文）`;
  return t;
}

function findRun(all, runId) {
  return all.find(r => r && (r.id === runId || r.id === 'run_' + runId || String(r.id).endsWith(runId)));
}

function stepLine(s) {
  if (!s || !s.kind) return '';
  const base = `  [${s.kind}]`;
  if (s.kind === 'llm') return `${base} 第 ${s.round} 轮 finishReason=${s.finishReason}`;
  if (s.kind === 'tool') return `${base} ${s.tool} ${s.summary || ''} ${s.ok ? '✓' : '✗'}`;
  if (s.kind === 'permission') return `${base} 权限卡 ${s.tool || ''} → ${s.decision}`;
  if (s.kind === 'progress') return `${base} [进展:${s.phase}] ${scrub(s.text, 60)}`;
  if (s.kind === 'notice') {
    const ev = s.evidence ? `｜evidence: ${s.evidence.map(x => scrub(x, 60)).join(' / ')}` : '';
    return `${base} ${s.notice}：${scrub(s.text, 100)}${ev}`;
  }
  return `${base} ${JSON.stringify(s).slice(0, 120)}`;
}

function renderRun(r, { full }) {
  const L = [];
  L.push(`# deskpal run ${r.id}`);
  L.push('');
  L.push(`- 时间：${r.at || '?'}　通道：${r.channel || '?'}　模式：${r.mode || '?'}　状态：${r.status || '?'}`);
  if (r.usage && (r.usage.input != null || r.usage.output != null)) {
    const u = r.usage;
    const reply = u.reasoning != null && u.output != null ? `${u.output - u.reasoning}（另思考 ${u.reasoning}）` : u.output;
    L.push(`- 本轮消耗：输入 ${u.input ?? '?'}${u.cacheHit != null ? `（命中 ${u.cacheHit}）` : ''}｜回复 ${reply ?? '?'}｜${u.requests} 次调用`);
  }
  if (r.retries) L.push(`- 假完成/声称守卫重试：${r.retries}`);
  if (r.lengthRetries) L.push(`- 截断/断流重试：${r.lengthRetries}`);
  if (r.error) L.push(`- 错误：${scrub(r.error, 200)}`);
  L.push(`- 指令：${scrub(r.instruction, full ? undefined : 200)}`);
  L.push('');
  L.push('## 步骤回放');
  for (const s of r.steps || []) L.push(stepLine(s));
  if (r.wipedRounds && r.wipedRounds.length) {
    L.push('');
    L.push(`## 被顶替轮全文留档（wipedRounds ×${r.wipedRounds.length}，守卫误判校准用）`);
    for (const w of r.wipedRounds) L.push(`- [${w.at}][${w.kind}] ${scrub(w.content, full ? undefined : 300)}`);
  }
  if (r.changed && r.changed.length) {
    L.push('');
    L.push('## 实际产生的变更');
    for (const c of r.changed) L.push(`- ${c.kind}/${c.origin} ${c.path}`);
  }
  L.push('');
  L.push('## 最终回复');
  L.push(scrub(r.finalReply, full ? undefined : 800));
  return L.join('\n');
}

function usage() {
  console.log([
    'logq：agent 台账只读检索（P1-7）',
    '',
    '  node scripts/logq.js runs [--limit 20] [--file <runs.jsonl>]',
    '  node scripts/logq.js turn <runId> [--full]',
    '  node scripts/logq.js bundle <runId> [--out <file.md>] [--full]',
    '',
    '默认台账：%%APPDATA%%\\deskpal\\agent\\runs.jsonl（--file / DESKPAL_RUNS 可覆盖）',
    '误判排查：看 notice 步骤的 evidence 字段（命中原句）；内容丢失查 wipedRounds。',
  ].join('\n'));
}

function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') return usage();
  let all;
  try {
    all = readAll(runsFile());
  } catch (e) {
    console.error('读不到台账文件：' + runsFile() + '\n' + e.message + '\n（用 --file <路径> 指定，或设置 DESKPAL_RUNS）');
    process.exit(2);
  }

  if (cmd === 'runs') {
    const limit = Math.max(1, parseInt(flag('--limit', '20'), 10) || 20);
    const rows = all.slice(-limit).reverse();
    if (!rows.length) return console.log('（台账为空）');
    console.log('时间\t\t\tid\t\t通道\t状态\t重试\t指令（截断）');
    for (const r of rows) {
      console.log([
        String(r.at || '?').slice(0, 19).replace('T', ' '),
        r.id,
        r.channel || '-',
        r.status || '-',
        (r.retries ? `守卫${r.retries}` : '') + (r.lengthRetries ? `截断${r.lengthRetries}` : '') || '-',
        scrub(r.instruction, 40),
      ].join('\t'));
    }
    return;
  }

  const runId = args[1];
  if (!runId) { usage(); process.exit(2); }
  const r = findRun(all, runId);
  if (!r) { console.error('找不到 run：' + runId); process.exit(2); }

  if (cmd === 'turn') {
    console.log(renderRun(r, { full: FULL }));
    return;
  }
  if (cmd === 'bundle') {
    const md = renderRun(r, { full: FULL }) + '\n\n---\n（由 logq 导出' + (FULL ? '' : '，已脱敏截断；--full 可含全文') + '：' + new Date().toISOString() + '）\n';
    const out = flag('--out', path.join(process.cwd(), `deskpal-runbundle-${r.id}.md`));
    fs.writeFileSync(out, md, 'utf8');
    console.log('已导出：' + out + (FULL ? '' : '（脱敏版）'));
    return;
  }
  usage();
  process.exit(2);
}

main();
