// 聚合：按应用/类别/小时的时长统计；未知应用清单（供标注）
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const store = require('../store');
const classifier = require('./classifier');

function readDay(d) {
  const file = path.join(store.getDataDir(), 'activity', d.format('YYYY-MM-DD') + '.jsonl');
  const out = [];
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) {}
    }
  } catch (_) {}
  return out;
}

function daysOf(range) {
  const n = range === 'week' ? 7 : 1;
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push(dayjs().subtract(i, 'day'));
  return days;
}

// 聚合指定范围。range: 'today' | 'week'
function stats(range) {
  const days = daysOf(range);
  const byApp = new Map();  // exe -> { app, exe, category, ms, titles:Set }
  const byCategory = new Map();
  const byHour = new Array(24).fill(0);
  let totalMs = 0, afkMs = 0;
  const unknown = new Map();

  for (const d of days) {
    for (const ev of readDay(d)) {
      if (ev.type === 'afk') { afkMs += ev.dur || 0; continue; }
      if (ev.type !== 'app') continue;
      const dur = Math.max(0, ev.dur || 0);
      const exe = String(ev.exe || '').split(/[\\/]/).pop().toLowerCase() || String(ev.app || '').toLowerCase();
      const cls = classifier.classify(exe, ev.title);
      if (cls.ignore) continue;
      const cat = cls.category || null;

      totalMs += dur;
      const h = dayjs(ev.start).hour();
      byHour[h] += dur;

      if (!byApp.has(exe)) byApp.set(exe, { app: exe, exe: ev.exe || '', category: cat, ms: 0, titles: new Set() });
      const a = byApp.get(exe);
      a.ms += dur;
      if (ev.title) a.titles.add(ev.title.slice(0, 60));
      if (cat) {
        byCategory.set(cat, (byCategory.get(cat) || 0) + dur);
        a.category = cat;
      } else {
        a.category = null;
        if (!unknown.has(exe)) unknown.set(exe, { app: exe, ms: 0, titles: [] });
        const u = unknown.get(exe);
        u.ms += dur;
        if (ev.title && u.titles.length < 5) u.titles.push(ev.title.slice(0, 60));
      }
    }
  }

  const apps = [...byApp.values()].map(a => ({
    app: a.app, exe: a.exe, category: a.category,
    min: Math.round(a.ms / 60000), ms: a.ms,
    pct: totalMs ? Math.round((a.ms / totalMs) * 100) : 0,
    topTitle: [...a.titles][0] || '',
    titles: [...a.titles].slice(0, 5),
  })).sort((x, y) => y.ms - x.ms);

  const categories = [...byCategory.entries()].map(([name, ms]) => ({
    name, min: Math.round(ms / 60000), ms, pct: totalMs ? Math.round((ms / totalMs) * 100) : 0,
  })).sort((x, y) => y.ms - x.ms);

  const hours = byHour.map(ms => Math.round(ms / 60000));

  return {
    range, days: days.map(d => d.format('YYYY-MM-DD')),
    totalMin: Math.round(totalMs / 60000), afkMin: Math.round(afkMs / 60000),
    apps: apps.slice(0, 30), categories, hours,
    unknownCount: unknown.size,
  };
}

// 未知应用清单（标注窗数据源）
function unknownApps(range = 'today') {
  const s = stats(range);
  return s.apps.filter(a => !a.category).map(a => ({ app: a.app, exe: a.exe, min: a.min, titles: a.titles }));
}

// 标注保存：[{app(exe), category}] → categories.appLabels + 可选自定义类别
function saveLabels(labels) {
  const cfg = store.get('categories');
  const appLabels = { ...(cfg.appLabels || {}) };
  let cats = [...(cfg.categories || [])];
  for (const l of labels || []) {
    const exe = String(l.app || '').toLowerCase();
    if (!exe || !l.category) continue;
    appLabels[exe] = l.category;
    if (!cats.includes(l.category)) cats.push(l.category);
  }
  store.replace('categories', { ...cfg, appLabels, categories: cats });
  // 触发统计刷新
  require('../../windows').broadcastAll('time:changed', {});
  return appLabels;
}

module.exports = { stats, unknownApps, saveLabels };
