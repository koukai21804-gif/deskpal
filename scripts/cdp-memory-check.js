// CDP 验证：驱动 dev 实例真实 GUI 走「/deep memory forcing → 面板查看/添加/删除 → 无感知」全链
// 前置：dev 实例已带 --remote-debugging-port=9222 启动（建议隔离 profile + 预置种子记忆）
// 用法：node scripts/cdp-memory-check.js
const CDP_PORT = 9222;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.error('  ✗ ' + n); } };

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
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).slice(0, 400));
    return r.result && r.result.value;
  } finally { c.close(); }
}

(async () => {
  let all = null;
  for (let i = 0; i < 20; i++) {
    try { all = await pages(); break; } catch (_) { await sleep(1000); }
  }
  if (!all) { console.error('CDP 未就绪'); process.exit(1); }

  if (!all.some(p => p.url.includes('renderer/chat'))) {
    const pet = all.find(p => p.url.includes('renderer/pet'));
    if (!pet) { console.error('pet 页面也未找到'); process.exit(1); }
    await evalIn(pet, `window.deskpal.openWindow('chat')`);
    await sleep(2500);
    all = await pages();
  }
  const chat = all.find(p => p.url.includes('renderer/chat'));
  if (!chat) { console.error('聊天窗未打开'); process.exit(1); }

  // 基线：历史条数与提取计数（无感知不变量的对照）
  const histBefore = await evalIn(chat, `window.deskpal.chatHistory('roleplay').then(m => m.length)`, true);
  const cntBefore = await evalIn(chat, `window.deskpal.storeGet('chats/roleplay').then(d => d.userCountSince || 0)`, true);
  console.log(`基线：history=${histBefore} userCountSince=${cntBefore}`);

  // 1. 输入斜杠命令 → 面板打开，不入史
  await evalIn(chat, `(() => { const i = document.querySelector('#input'); i.value = '/ deep memory forcing'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  await sleep(900);
  ok(await evalIn(chat, `!!document.querySelector('.dp-modal .mem-add')`) === true, '面板打开（.mem-add 存在）');
  ok(await evalIn(chat, `document.querySelector('#input').value === ''`) === true, '输入框已清空');
  ok(await evalIn(chat, `document.querySelectorAll('.mem-item').length`) === 2, '种子记忆 2 条展示');

  // 2. 添加记忆（含旧条目 id 归一化后的真实存储）
  await evalIn(chat, `(() => { document.querySelector('#memType').value = 'preference'; document.querySelector('#memImp').value = '5'; document.querySelector('#memContent').value = 'CDP验证记忆条目'; document.querySelector('#memAddBtn').click(); return true; })()`);
  await sleep(900);
  const added = await evalIn(chat, `window.deskpal.memoryList().then(l => JSON.stringify(l.find(x => x.content === 'CDP验证记忆条目') || null))`, true);
  const addedObj = JSON.parse(added);
  ok(!!addedObj, '添加后落盘');
  ok(!!addedObj && addedObj.id.startsWith('mem_') && addedObj.importance === 5 && addedObj.type === 'preference', 'id/importance/type 归一化正确');
  ok(await evalIn(chat, `document.querySelectorAll('.mem-item').length`) === 3, '面板实时刷新为 3 条');

  // 3. 删除「种子记忆A」（确认框二次确认）
  await evalIn(chat, `(() => { const item = [...document.querySelectorAll('.mem-item')].find(x => x.querySelector('.mem-content').textContent.includes('种子记忆A')); item.querySelector('[data-del]').click(); return true; })()`);
  await sleep(500);
  ok(await evalIn(chat, `!![...document.querySelectorAll('.dp-modal-mask')].find(m => m.querySelector('[data-act=yes]'))`) === true, '删除确认框弹出');
  await evalIn(chat, `(() => { const masks = [...document.querySelectorAll('.dp-modal-mask')]; masks[masks.length - 1].querySelector('[data-act=yes]').click(); return true; })()`);
  await sleep(900);
  const afterDel = await evalIn(chat, `window.deskpal.memoryList().then(l => JSON.stringify(l.map(x => x.content)))`, true);
  ok(JSON.parse(afterDel).length === 2, '删除后余 2 条');
  ok(!JSON.parse(afterDel).some(c => c.includes('种子记忆A')), '目标记忆已消失');

  // 4. 主进程兜底守卫：直接 chatSend 命令 → 不入史不计数
  const guard = await evalIn(chat, `window.deskpal.chatSend('roleplay', '/deep memory forcing').then(r => JSON.stringify(r))`, true);
  ok(guard === '{"memoryCommand":true}', 'chatSend 返回 memoryCommand 标记');
  await sleep(600);

  // 5. 无感知不变量：历史/计数全程未变
  const histAfter = await evalIn(chat, `window.deskpal.chatHistory('roleplay').then(m => m.length)`, true);
  const cntAfter = await evalIn(chat, `window.deskpal.storeGet('chats/roleplay').then(d => d.userCountSince || 0)`, true);
  ok(histAfter === histBefore, `聊天历史未变（${histBefore} → ${histAfter}）`);
  ok(cntAfter === cntBefore, `提取计数未变（${cntBefore} → ${cntAfter}）`);
  ok(await evalIn(chat, `window.deskpal.chatHistory('roleplay').then(m => !m.some(x => (x.content || '').includes('deep memory forcing')))`, true) === true, '历史中无命令文本残留');

  console.log(`\n========== CDP 记忆面板验证：${passed} 通过 / ${failed} 失败 ==========`);
  process.exit(failed ? 1 : 0);
})();
