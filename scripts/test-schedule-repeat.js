// 日程 repeat 功能离线测试：nextOccurrence 规则 / 创建即顺延 / tick 滚动续期 /
// 工作日跨周末 / 超补报窗口 missed 后续期 / updateEvent 改重复 / 持久化 /
// add_reminder 工具（创建・同名软去重・格式校验）/ parser repeat 透传。
// 用法：node scripts/test-schedule-repeat.js（纯 Node，无 Electron 依赖）
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SVC = p => path.join(ROOT, 'src/main/services', p);

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function section(t) { console.log('\n## ' + t); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpal-repeat-test-'));
const store = require(SVC('store'));
store.init(TMP);
// 关系统通知与提示音：fire() 在纯 Node 下无 Notification，短路掉才算安全触达
store.set('settings', { schedule: { systemNotification: false, sound: false } });

// electron 依赖面打桩（scheduler → windows/emotion）
const emotion = require(SVC('emotion'));
emotion.broadcastEmotion = () => {};
const windows = require(path.join(ROOT, 'src/main/windows'));
windows.broadcastAll = () => {};

const dayjs = require('dayjs');
const scheduler = require(SVC('schedule/scheduler'));
scheduler.start(); // 加载事件库
scheduler.stop();  // 测试自控 tick，不留定时器

// ============ 1. nextOccurrence 基础规则 ============
section('nextOccurrence 规则');
{
  const anchor = dayjs('2026-10-01 09:00'); // 周四
  eq_(scheduler.nextOccurrence(anchor, 'daily', anchor).format('YYYY-MM-DD HH:mm'), '2026-10-02 09:00', 'daily → 次日同时刻');
  eq_(scheduler.nextOccurrence(anchor, 'weekly', anchor).format('YYYY-MM-DD HH:mm'), '2026-10-08 09:00', 'weekly → +7 天');
  const friday = dayjs('2026-10-02 09:00'); // 周五
  eq_(scheduler.nextOccurrence(friday, 'weekdays', friday).format('YYYY-MM-DD HH:mm'), '2026-10-05 09:00', 'weekdays 周五 → 下周一（跨周末）');
  eq_(scheduler.nextOccurrence(anchor, 'none', anchor), null, 'none → 无下一次');
  ok(scheduler.nextOccurrence(anchor, 'daily', dayjs('2026-10-03 10:00')).isAfter(dayjs('2026-10-03 10:00')), 'after 晚于锚 → 严格晚于 after');
  // 远 past 锚快进：多年前的同刻 → 循环不拖爆、结果仍严格晚于 after 且保持时钟点
  const farNext = scheduler.nextOccurrence(dayjs('2020-01-01 09:00'), 'daily', dayjs());
  ok(farNext && farNext.isAfter(dayjs()) && farNext.hour() === 9 && farNext.minute() === 0, '远 past 锚快进后保持时钟点');
}
function eq_(a, b, name) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  ok(ja === jb, `${name}${ja === jb ? '' : `（got ${ja}, want ${jb}）`}`);
}

// ============ 2. newEvent repeat 字段 ============
section('newEvent repeat 校验');
{
  const ev = scheduler.newEvent({ kind: 'event', title: 'x1', start: dayjs().add(1, 'day'), remindPreset: 'start', repeat: 'daily' });
  eq_(ev.repeat, 'daily', '合法 repeat 保留');
  const ev2 = scheduler.newEvent({ kind: 'event', title: 'x2', start: dayjs().add(1, 'day'), repeat: '每个月' });
  eq_(ev2.repeat, 'none', '非法 repeat 归 none');
}

// ============ 3. 未来时刻创建：不滚动 ============
section('未来时刻创建不滚动');
{
  const start = dayjs().add(2, 'hour');
  const ev = scheduler.addEvent(scheduler.newEvent({ kind: 'event', title: '未来会', start, remindPreset: 'start', repeat: 'daily' }));
  ok(dayjs(ev.start).isSame(start, 'second'), 'start 保持不变');
  ok(ev.reminders.some(r => r.status === 'pending'), '提醒已物化 pending');
}

// ============ 4. 今日时刻已过创建：立刻顺延到下一次 ============
section('今日时刻已过 → 创建即顺延');
{
  const pastToday = dayjs().subtract(2, 'hour');
  const ev = scheduler.addEvent(scheduler.newEvent({ kind: 'event', title: '喝水', start: pastToday, remindPreset: 'only_start', repeat: 'daily' }));
  ok(dayjs(ev.start).isAfter(dayjs()), 'start 顺延到未来');
  ok(dayjs(ev.start).hour() === pastToday.hour() && dayjs(ev.start).minute() === pastToday.minute(), '顺延保持时钟点');
  ok(ev.reminders.some(r => r.status === 'pending'), '顺延后提醒已物化');
  ok(dayjs(ev.start).isSame(scheduler.nextOccurrence(pastToday, 'daily', dayjs()), 'second'), '顺延目标 = 下一次发生');
}

// ============ 5. tick 滚动续期：提醒出清 → 平移到下一次 ============
section('tick 滚动续期（fire 后）');
{
  const start = dayjs().add(1, 'hour');
  const ev = scheduler.addEvent(scheduler.newEvent({ kind: 'event', title: '滚动会', start, remindPreset: 'only_start', repeat: 'daily' }));
  const origStart = ev.start;
  // 模拟到点触发：把 pending 提醒的 at 拨到 10 秒前（补报窗口内）→ tick 真实 fire → 出清 → 滚动
  for (const r of ev.reminders) { r.at = dayjs().subtract(10, 'second').format(); }
  scheduler.tick();
  ok(ev.reminders.some(r => r.status === 'fired'), '旧提醒已 fire 留痕');
  const pending = ev.reminders.filter(r => r.status === 'pending');
  ok(pending.length > 0 && pending.every(r => dayjs(r.at).isAfter(dayjs())), '新一次的提醒全部在未来');
  ok(dayjs(ev.start).isAfter(dayjs(origStart)), 'start 已滚到下一次');
}

// ============ 6. 工作日跨周末滚动 ============
section('weekdays 跨周末');
{
  // 锚定最近一个已过去的周五同时刻，创建即应顺延到未来工作日
  const now = dayjs();
  const friday = now.day() >= 5 ? now.subtract(now.day() - 5, 'day') : now.subtract(now.day() + 2, 'day');
  const ev = scheduler.addEvent(scheduler.newEvent({ kind: 'event', title: '站会', start: friday, remindPreset: 'only_start', repeat: 'weekdays' }));
  ok(dayjs(ev.start).isAfter(now), '锚点已过 → 已顺延到未来');
  ok([1, 2, 3, 4, 5].includes(dayjs(ev.start).day()), '顺延目标落周一至周五');
  // 强制出清 → tick 再滚一步，仍不得落在周末
  for (const r of ev.reminders) r.status = 'fired';
  scheduler.tick();
  ok([1, 2, 3, 4, 5].includes(dayjs(ev.start).day()), '再滚一步仍是工作日');
  ok(dayjs(ev.start).isAfter(now), '再滚后仍在未来');
}

// ============ 7. 超补报窗口 missed → 静默标记并续期 ============
section('超补报窗口 missed 续期');
{
  const threeDaysAgo = dayjs().subtract(3, 'day');
  const ev = scheduler.addEvent(scheduler.newEvent({ kind: 'event', title: '陈年提醒', start: dayjs().add(1, 'hour'), remindPreset: 'only_start', repeat: 'daily' }));
  // 模拟「关机 3 天」：把已物化的提醒 at 全部拨到 3 天前 → 超出补报窗口
  const oldIds = ev.reminders.map(r => r.id);
  for (const r of ev.reminders) r.at = threeDaysAgo.format();
  scheduler.tick();
  ok(oldIds.length > 0 && oldIds.every(id => ev.reminders.find(r => r.id === id).status === 'missed'), '超窗口旧提醒全部标记 missed');
  ok(dayjs(ev.start).isAfter(dayjs()), 'start 续期到未来（不连锁丢多天）');
  ok(ev.reminders.some(r => r.status === 'pending' && dayjs(r.at).isAfter(dayjs())), 'missed 后新提醒已物化');
}

// ============ 8. updateEvent 改 repeat ============
section('updateEvent 改重复');
{
  const ev = scheduler.addEvent(scheduler.newEvent({ kind: 'event', title: '改重复', start: dayjs().subtract(1, 'hour'), remindPreset: 'only_start', repeat: 'none' }));
  // 单次事件时刻已过、提醒物化为空 → 改 daily 后应顺延并物化
  scheduler.updateEvent({ id: ev.id, repeat: 'daily' });
  eq_(ev.repeat, 'daily', 'repeat 已更新');
  ok(dayjs(ev.start).isAfter(dayjs()), '改为 daily 后过去时刻顺延到下一次');
  ok(ev.reminders.some(r => r.status === 'pending'), '顺延后提醒已物化');
}

// ============ 9. 持久化 ============
section('持久化');
{
  const ev = scheduler.listEvents().find(e => e.title === '喝水' && e.repeat === 'daily');
  store.flushAll();
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'schedule', 'events.json'), 'utf8'));
  const saved = raw.events.find(e => e.id === ev.id);
  ok(saved && saved.repeat === 'daily' && dayjs(saved.start).isAfter(dayjs()), 'repeat 与顺延后的 start 落盘');
}

// ============ 10/11. 工具与 parser（异步） ============
(async () => {
  // ---- add_reminder 工具 handler 直调 ----
  section('add_reminder 工具（handler 直调）');
  const tools = require(SVC('agent/builtin')); // require 即注册内置工具
  const t = tools.get('add_reminder');
  ok(!!t && t.enabled, '工具已注册且启用');

  // 动态未来时间（原硬编码 2026-10-03 21:30 在当天该时刻过后必失败——repeat 顺延到次日）
  const futureStart = dayjs().add(2, 'hour').format('YYYY-MM-DD HH:mm');
  const r1 = String(await tools.invoke('add_reminder', { title: '冥想', start: futureStart, repeat: 'daily' }, {}));
  ok(r1.includes('已创建') && r1.includes(futureStart), `创建成功并回报首次提醒时间（无提前量噪音，start=${futureStart}）`);
  const evt = scheduler.listEvents().find(e => e.title === '冥想');
  ok(evt && evt.repeat === 'daily' && evt.source === 'chat' && evt.kind === 'event' && evt.remindPreset === 'only_start', '落库字段正确');

  const r2 = String(await tools.invoke('add_reminder', { title: '冥想', start: '2026-10-03 07:00', repeat: 'daily' }, {}));
  ok(r2.includes('未创建'), '同名每日提醒软去重拦截');
  ok(scheduler.listEvents().filter(e => e.title === '冥想').length === 1, '未产生第二条');

  let r3 = '';
  try { r3 = String(await tools.invoke('add_reminder', { title: '坏时间', start: '明天早上九点' }, {})); } catch (e) { r3 = e.userMsg || e.message; }
  ok(r3.includes('YYYY-MM-DD HH:mm'), '非格式时间 → 返回格式纠正指引');

  const r4 = String(await tools.invoke('add_reminder', { title: '单次提醒', start: dayjs().add(1, 'day').format('YYYY-MM-DD') + ' 08:00' }, {}));
  ok(r4.includes('已创建') && !r4.includes('重复'), '缺省 repeat=none 可创建单次提醒');

  // ---- parser repeat 透传（LLM 桩） ----
  section('parser repeat 透传（LLM 桩）');
  const llm = require(SVC('llm'));
  llm.genericCompletion = async () => JSON.stringify({ understood: true, kind: 'event', title: '喝水', start: dayjs().subtract(2, 'hour').format('YYYY-MM-DD HH:mm'), durationMin: null, deadline: null, remindPreset: 'only_start', repeat: 'daily' });
  const parser = require(SVC('schedule/parser'));
  const r1p = await parser.parseNL('每天九点提醒我喝水');
  ok(r1p.understood && r1p.draft.repeat === 'daily', 'repeat=daily 透传入 draft');
  ok(dayjs(r1p.draft.start).isAfter(dayjs()), '今日时刻已过 → draft 顺延展示');

  llm.genericCompletion = async () => JSON.stringify({ understood: true, kind: 'event', title: '单次会', start: dayjs().subtract(1, 'hour').format('YYYY-MM-DD HH:mm'), durationMin: null, deadline: null, remindPreset: 'start', repeat: 'none' });
  const r2p = await parser.parseNL('刚才开会');
  ok(!r2p.understood && /过去/.test(r2p.question || ''), '单次日程过去时刻仍拒绝');

  console.log(`\n========== repeat 测试结果：${passed} 通过 / ${failed} 失败 ==========`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
