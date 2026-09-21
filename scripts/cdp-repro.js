// CDP 复现：驱动 dev 实例渲染层完整走「发送→权限卡→点允许」链路（排查用，可保留）
// 前置：dev 实例已带 --remote-debugging-port=9222 启动
// 用法：node scripts/cdp-repro.js
const CDP_PORT = 9222;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pages() {
  return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter(t => t.type === 'page');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      eval: async (expression, awaitPromise = false) => {
        const id = ++seq;
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise, returnByValue: true } }));
        return new Promise((res, rej) => pending.set(id, { res, rej }));
      },
      close: () => ws.close(),
    });
    ws.onerror = () => reject(new Error('WS error'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
  });
}

async function evalIn(page, expression, awaitPromise = false) {
  const c = await connect(page.webSocketDebuggerUrl);
  try {
    const r = await c.eval(expression, awaitPromise);
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.description || r.exceptionDetails.text).slice(0, 300));
    return r.result && r.result.value;
  } finally { c.close(); }
}

(async () => {
  // 1. 等 CDP 就绪
  let all = null;
  for (let i = 0; i < 20; i++) {
    try { all = await pages(); break; } catch (_) { await sleep(1000); }
  }
  if (!all) { console.error('CDP 未就绪'); process.exit(1); }

  // 2. 打开聊天窗（若无）
  if (!all.some(p => p.url.includes('renderer/chat'))) {
    const pet = all.find(p => p.url.includes('renderer/pet'));
    if (!pet) { console.error('pet 页面也未找到'); process.exit(1); }
    await evalIn(pet, `window.deskpal.openWindow('chat')`);
    await sleep(2500);
    all = await pages();
  }
  const chat = all.find(p => p.url.includes('renderer/chat'));
  if (!chat) { console.error('聊天窗未打开'); process.exit(1); }

  // 2.5 设定权限模式（命令行 MODE=userData|full|read，默认 userData），走真实 store:set 链路
  const mode = (process.env.MODE || 'userData').trim();
  await evalIn(chat, `window.deskpal.storeSet('settings', { agent: { permissionMode: '${mode}' } }).then(()=>window.deskpal.storeGet('settings')).then(s=>JSON.stringify(s.agent && s.agent.permissionMode))`, true)
    .then(r => console.log('权限模式已设定:', r));
  // 重新加载页面让 UI 选择器同步显示；顺带清空旧会话（历史会带偏模型对任务的判断）
  await evalIn(chat, `window.deskpal.chatSaveHistory('roleplay', []).then(()=>location.reload())`, true).catch(() => {});
  await sleep(2500);
  const all2 = await pages();
  const chat2 = all2.find(p => p.url.includes('renderer/chat')) || chat;

  // 3. 真实 UI 路径发送
  const sent = await evalIn(chat2, `(() => {
    const input = document.querySelector('#input');
    const btn = document.querySelector('#sendBtn');
    if (!input || !btn) return 'NO-INPUT-OR-BTN';
    input.value = '帮我在数据目录的 temp 里建一个 todo.md';
    btn.click();
    return 'SENT';
  })()`);
  console.log('发送:', sent);
  if (sent !== 'SENT') process.exit(1);

  // 3.5 确认选择器 UI 显示的模式
  const sel = await evalIn(chat2, `document.querySelector('#permMode') ? document.querySelector('#permMode').value : 'NO-SELECT'`);
  console.log('聊天窗权限选择器显示:', sel);

  // 4. 轮询 3 分钟：每 3s 采样（卡片数/流式正文尾部/时间线步数）
  let cardSeen = null;
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const snap = await evalIn(chat2, `(() => {
      const cards = document.querySelectorAll('.perm-card');
      const bodies = [...document.querySelectorAll('.msg .body')];
      const last = bodies.length ? bodies[bodies.length-1].textContent.replace(/\\s+/g,' ').slice(-60) : '';
      const steps = document.querySelectorAll('.agent-steps .step').length;
      const finals = [...document.querySelectorAll('.perm-final')].map(f=>f.textContent);
      return JSON.stringify({ cards: cards.length, last, steps, finals });
    })()`);
    const s = JSON.parse(snap);
    if (i % 5 === 0 || s.cards > 0) console.log(`[${i*3}s] 卡片=${s.cards} 时间线步=${s.steps} 正文尾="${s.last}"`);
    if (s.cards > 0) { cardSeen = s; break; }
  }
  if (!cardSeen) { console.error('× 3 分钟内权限卡未挂载到 DOM——卡片渲染环节有 bug'); process.exit(2); }
  console.log('✓ 权限卡已挂载');

  // 5. 点「允许一次」
  const clickR = await evalIn(chat2, `(() => {
    const b = document.querySelector('.perm-card [data-d="allow_once"]');
    if (!b) return 'NO-BUTTON';
    const rid = b.closest('.perm-card').dataset.rid;
    b.click();
    return 'CLICKED rid=' + rid;
  })()`);
  console.log('点击:', clickR);
  await sleep(1500);
  const after = await evalIn(chat2, `JSON.stringify({
    final: ([...document.querySelectorAll('.perm-final')].map(f=>f.textContent)),
    disabled: [...document.querySelectorAll('.perm-card button')].map(b=>b.disabled)
  })`);
  console.log('点击后卡片状态:', after);

  // 6. 等 run 收尾（正文/文件）
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const done = await evalIn(chat2, `(() => {
      const bodies = [...document.querySelectorAll('.msg .body')];
      const last = bodies.length ? bodies[bodies.length-1].textContent.replace(/\\s+/g,' ').slice(-50) : '';
      const stop = document.querySelector('#stopBtn').style.display === 'none';
      return JSON.stringify({ last, streamingEnded: stop });
    })()`);
    const d = JSON.parse(done);
    if (d.streamingEnded) { console.log('✓ run 已收尾，正文尾="' + d.last + '"'); break; }
  }
  process.exit(0);
})();
