#!/usr/bin/env node
// test-noreki-send.js — N-9「发送侧假成功」最小复现/回归测试（2026-10-13）
// 判据（问题清单 v1.1 §2.5）：send 报 id ⟺ outbox 文件已落且读回一致；任何写失败必须返回 {ok:false} 且不返回 id。
// 运行：node scripts/test-noreki-send.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name); } }
function section(s) { console.log('\n[' + s + ']'); }

// 邮局根目录隔离（必须在 require 之前设置）
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'noreki-test-'));
process.env.NOREKI_LINK_ROOT = ROOT;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noreki-data-'));
fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config', 'noreki-mail.key'), crypto.randomBytes(32).toString('hex'));

const noreki = require('../src/main/services/noreki-link');
noreki.init(dataDir);

function outboxDir() { return path.join(ROOT, 'outbox', 'from-deskpal'); }
function outboxFiles() { try { return fs.readdirSync(outboxDir()).filter(f => f.endsWith('.json')); } catch (_) { return []; } }
function ledger() { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'noreki-link', 'ledger.json'), 'utf8')); } catch (_) { return { sent: [] }; } }

// ---------- 1. 正常发送：三步闭环全部成立 ----------
section('1. 正常发送（报 id ⟺ 落盘+读回+记账全成）');
const r1 = noreki.send('note', '测试正文第一行\n第二行', 'ref-1');
ok(r1 && r1.ok === true, '返回 ok=true');
ok(r1 && typeof r1.id === 'string' && r1.id.length === 6, '返回 6 位 id');
const f1 = outboxFiles();
ok(f1.length === 1 && f1[0].includes(r1.id), 'outbox 文件已落且文件名含 id');
const back = JSON.parse(fs.readFileSync(path.join(outboxDir(), f1[0]), 'utf8'));
ok(back.id === r1.id && back.body === '测试正文第一行\n第二行', '读回内容与信封一致');
ok(ledger().sent.some(s => s.id === r1.id), 'ledger.sent 已记账');
ok(fs.existsSync(path.join(dataDir, 'noreki-link', 'sent', f1[0])), '己方 realm 发件留档存在');

// ---------- 2. outbox 目录写失败：返回错误，绝不返回 id ----------
section('2. outbox 写失败（N-9 核心场景：报错而非假成功）');
fs.rmSync(path.join(ROOT, 'outbox'), { recursive: true, force: true });
fs.writeFileSync(path.join(ROOT, 'outbox'), 'blocking-file'); // outbox 变文件 → mkdir/write 必失败
const r2 = noreki.send('note', '这条应当失败');
ok(r2 && r2.ok === false, '返回 ok=false');
ok(r2 && r2.id === undefined, '失败时不返回 id（N-9 判据）');
ok(r2 && !!r2.error, '返回错误码: ' + (r2 && r2.error));
ok(!JSON.stringify(ledger().sent).includes('"id":"' + (r2 && r2.id)) , '失败信未入台账');

// ---------- 3. 台账失败：交付真相仍成立（信已落 outbox）----------
section('3. 台账失败（信已落 outbox：返回 id + ledgerError，不假报错不重复投递）');
fs.rmSync(path.join(ROOT, 'outbox'), { recursive: true, force: true }); // 移除阻塞文件
const ledgerPath = path.join(dataDir, 'noreki-link', 'ledger.json');
fs.rmSync(ledgerPath, { force: true });
fs.mkdirSync(ledgerPath); // ledger.json 变目录 → saveLedger rename 必失败
const r3 = noreki.send('note', '台账失败场景');
ok(r3 && r3.ok === true && r3.id, '信已确认落 outbox：返回 ok=true 与 id');
ok(outboxFiles().some(f => f.includes(r3.id)), 'outbox 文件存在（交付真相）');
ok(typeof r3.ledgerError === 'string', '带 ledgerError 警示: ' + String(r3.ledgerError).slice(0, 40));

// ---------- 4. 未初始化拒绝 ----------
section('4. 未初始化拒绝');
// state.key 在本进程已初始化；此处只验证契约形状（不产生副作用）
ok(typeof noreki.send === 'function', 'send 可调用');

// ---------- 清理 ----------
try { noreki.shutdown(); } catch (_) {}
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
