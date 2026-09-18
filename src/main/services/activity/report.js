// AI 时间报告：聚合 JSON + 人设口吻 → LLM 流式 markdown（推送到时间页）
const store = require('../store');
const llm = require('../llm');
const prompts = require('../prompts');
const emotion = require('../emotion');
const statsMod = require('./stats');
const windows = require('../../windows');

// 返回 {reqId}，结果经 report:chunk / report:done 推送
async function generate(range) {
  const reqId = llm.newReqId('report');
  const s = statsMod.stats(range);
  const pet = store.get('persona').pet;
  // 精简 JSON 喂给 LLM
  const feed = {
    range: range === 'week' ? '本周（近7天）' : '今日',
    totalMin: s.totalMin,
    categories: s.categories.map(c => ({ name: c.name, min: c.min, pct: c.pct })),
    topApps: s.apps.slice(0, 12).map(a => ({ app: a.app, category: a.category, min: a.min, pct: a.pct })),
    busyHours: s.hours.map((m, h) => ({ h, m })).filter(x => x.m > 0).sort((a, b) => b.m - a.m).slice(0, 5),
  };
  (async () => {
    const win = windows.getWindow('time');
    try {
      const personaData = store.get('persona');
      const master = (personaData.user && String(personaData.user.name || '').trim()) || '主人';
      const raw = await llm.streamChat({
        messages: [{ role: 'system', content: prompts.timeReportPrompt(pet, master, JSON.stringify(feed, null, 1)) }],
        reqId,
        onChunk: (delta) => { if (win && !win.isDestroyed()) win.webContents.send('report:chunk', { reqId, delta }); },
      });
      const { clean, emotion: emo } = emotion.parseAndStrip(raw);
      if (emo) emotion.broadcastEmotion(emo, { source: 'chat', revertMs: 6000 });
      if (win && !win.isDestroyed()) win.webContents.send('report:done', { reqId, ok: true, markdown: clean });
    } catch (e) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('report:done', { reqId, ok: false, error: e.userMsg || e.message });
      }
    }
  })();
  return { reqId };
}

module.exports = { generate };
