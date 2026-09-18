// 拖拽端到端验证：隔离 userData + koffi SetCursorPos 程序化移动真实光标
// 坐标策略：物理像素全程以窗口本地为基准（GetWindowRect + GetCursorPos），
// 不使用 Electron 逻辑坐标做跨系换算 —— 多显示器/混合 DPI 下逻辑坐标系非全局线性，不可靠
const { app, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

app.setPath('userData', path.join(os.tmpdir(), 'deskpal-dragtest-' + Date.now()));
require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[drag-test] ${pass ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`);
}
function finish(code) {
  const text = results.map(r => `${r.pass ? 'PASS' : 'FAIL'} ${r.name} ${r.detail || ''}`).join('\n');
  try { fs.writeFileSync(path.join(os.tmpdir(), 'drag-test-result.txt'), text + '\n'); } catch (_) {}
  setTimeout(() => app.exit(code), 200);
}

app.whenReady().then(async () => {
  try {
    const windows = require('../src/main/windows');
    let win = null;
    for (let i = 0; i < 40 && !win; i++) { await sleep(200); win = windows.getWindow('pet'); }
    if (!win) { report('pet-window', false, 'pet 窗口未创建'); return finish(1); }
    await sleep(1200); // 等渲染层初始化完成

    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
    const GetCursorPos = user32.func('bool __stdcall GetCursorPos(void *pt)');
    const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, void *rect)');
    const readPt = (buf) => ({ x: buf.readInt32LE(0), y: buf.readInt32LE(4) });
    const readRect = (buf) => ({ left: buf.readInt32LE(0), top: buf.readInt32LE(4), right: buf.readInt32LE(8), bottom: buf.readInt32LE(12) });
    const getCursor = () => { const b = Buffer.alloc(8); GetCursorPos(b); return readPt(b); };

    // 窗口停在本显示器工作区内、四周留足余量（避开贴边吸附区）
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setPosition(wa.x + 320, wa.y + 260);
    await sleep(300);
    console.log(`[drag-test] 显示器 workArea=(${wa.x},${wa.y} ${wa.width}x${wa.height}) scale=${screen.getPrimaryDisplay().scaleFactor}`);

    // 窗口物理矩形与本地缩放比
    const hwndBuf = win.getNativeWindowHandle();
    const hwnd = hwndBuf.readUInt32LE(0); // HWND 实际只有 32 位有效
    const rb = Buffer.alloc(16);
    if (!GetWindowRect(hwnd, rb)) { report('window-rect', false, 'GetWindowRect 失败'); return finish(1); }
    const wrect = readRect(rb);
    const b = win.getBounds();
    const px = (wrect.right - wrect.left) / b.width; // 物理/逻辑 比（窗口所在显示器）
    const phys = (clientX, clientY) => ({ x: Math.round(wrect.left + clientX * px), y: Math.round(wrect.top + clientY * px) });
    console.log(`[drag-test] 窗口物理矩形=(${wrect.left},${wrect.top})-(${wrect.right},${wrect.bottom}) 逻辑=${b.width}x${b.height} 本地scale=${px.toFixed(3)}`);

    // 精灵中心（client 逻辑坐标）→ 物理光标位置
    const rect = await win.webContents.executeJavaScript(
      `(() => { const r = document.querySelector('.dp-sprite').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`
    );
    const centerClient = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const centerPhys = phys(centerClient.x, centerClient.y);
    SetCursorPos(centerPhys.x, centerPhys.y);
    await sleep(150);
    const curPhys = getCursor(); // 实际落点
    const curClient = { x: (curPhys.x - wrect.left) / px, y: (curPhys.y - wrect.top) / px };
    console.log(`[drag-test] 光标落点 physical=(${curPhys.x},${curPhys.y}) client=(${curClient.x.toFixed(0)},${curClient.y.toFixed(0)}) 目标client=(${centerClient.x.toFixed(0)},${centerClient.y.toFixed(0)})`);

    // 合成 pointerdown（与人手按下语义一致：client 坐标 = 光标真实位置）
    await win.webContents.executeJavaScript(
      `(function(){ const el = document.querySelector('.dp-sprite');
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, button: 0, buttons: 1, clientX: ${Math.round(curClient.x)}, clientY: ${Math.round(curClient.y)} })); return 1; })()`
    );
    await sleep(80);
    const before = win.getPosition();
    report('no-jump-on-down', Math.abs(before[0] - b.x) <= 2 && Math.abs(before[1] - b.y) <= 2,
      `down 前=(${b.x},${b.y}) down 后=(${before})`);

    // 分步移动真实光标（物理 +12px*scale,+4px*scale ×10 ≈ 逻辑 +120,+40），窗口应每步跟随
    const samples = [];
    let p = { ...curPhys };
    for (let i = 1; i <= 10; i++) {
      p = { x: curPhys.x + Math.round(i * 12 * px), y: curPhys.y + Math.round(i * 4 * px) };
      SetCursorPos(p.x, p.y);
      await sleep(45);
      samples.push(win.getPosition());
    }
    console.log('[drag-test] 采样轨迹: ' + samples.map(s => s.join(',')).join(' | '));
    const movedX = samples[9][0] - before[0], movedY = samples[9][1] - before[1];
    report('follow-cursor', Math.abs(movedX - 120) <= 12 && Math.abs(movedY - 40) <= 12,
      `光标移动(+120,+40) 窗口移动(${movedX > 0 ? '+' : ''}${movedX},${movedY > 0 ? '+' : ''}${movedY})`);

    // 光标停住 → 窗口应立刻停住（不漂移）
    const holdA = win.getPosition();
    await sleep(250);
    const holdB = win.getPosition();
    report('hold-still', Math.abs(holdA[0] - holdB[0]) <= 1 && Math.abs(holdA[1] - holdB[1]) <= 1,
      `停住前=(${holdA}) 250ms 后=(${holdB})`);

    // 轨迹单调前进（无明显回跳）
    let backtrack = 0;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i][0] < samples[i - 1][0] - 2 || samples[i][1] < samples[i - 1][1] - 2) backtrack++;
    }
    report('smooth-track', backtrack === 0, `回跳次数=${backtrack} 采样点=${samples.length}`);

    // 合成 pointerup → 拖拽结束；之后再动光标窗口不应再动
    await win.webContents.executeJavaScript(
      `(function(){ const el = document.querySelector('.dp-sprite');
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9, button: 0, clientX: ${Math.round(curClient.x) + 120}, clientY: ${Math.round(curClient.y) + 40} })); return 1; })()`
    );
    await sleep(120);
    const atEnd = win.getPosition();
    SetCursorPos(p.x + Math.round(60 * px), p.y + Math.round(20 * px));
    await sleep(250);
    const afterEnd = win.getPosition();
    report('stop-on-release', atEnd[0] === afterEnd[0] && atEnd[1] === afterEnd[1],
      `松手时=(${atEnd}) 之后=(${afterEnd})`);

    // 单击（位移<阈值）不应移动窗口
    const back = phys(centerClient.x, centerClient.y);
    SetCursorPos(back.x, back.y); await sleep(150);
    const cur3 = getCursor();
    const c3 = { x: Math.round((cur3.x - wrect.left) / px), y: Math.round((cur3.y - wrect.top) / px) };
    await win.webContents.executeJavaScript(
      `(function(){ const el = document.querySelector('.dp-sprite');
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 8, button: 0, buttons: 1, clientX: ${c3.x}, clientY: ${c3.y} }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 8, button: 0, clientX: ${c3.x + 2}, clientY: ${c3.y + 1} })); return 1; })()`
    );
    await sleep(120);
    const clickPos = win.getPosition();
    report('click-no-move', Math.abs(clickPos[0] - afterEnd[0]) <= 6 && Math.abs(clickPos[1] - afterEnd[1]) <= 6,
      `点击后=(${clickPos}) 期望≈(${afterEnd})`);

    // 快速甩动：光标瞬移 +400px，窗口应限速平滑追赶（单步 ≤ MAX_STEP），最终抓取点不漂移
    // （合成事件无法 setPointerCapture，光标出窗后事件不再送达 → 先在窗内小步触发 start 再瞬移）
    SetCursorPos(back.x, back.y); await sleep(150);
    const cur4 = getCursor();
    const c4 = { x: Math.round((cur4.x - wrect.left) / px), y: Math.round((cur4.y - wrect.top) / px) };
    await win.webContents.executeJavaScript(
      `(function(){ const el = document.querySelector('.dp-sprite');
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, button: 0, buttons: 1, clientX: ${c4.x}, clientY: ${c4.y} })); return 1; })()`
    );
    await sleep(60);
    const yankAnchor = win.getPosition(); // 触发 start 前的锚点（期望终点 = anchor + 400）
    SetCursorPos(cur4.x + Math.round(20 * px), cur4.y); // 窗内小步 → 真实 pointermove 越过阈值触发 start
    await sleep(120);
    SetCursorPos(cur4.x + Math.round(400 * px), cur4.y); // 瞬移，主进程定时器会自行追赶到新光标位置
    const yankStart = win.getPosition();
    let maxJump = 0, prev = yankStart;
    for (let i = 0; i < 6; i++) {
      await sleep(25);
      const p = win.getPosition();
      maxJump = Math.max(maxJump, Math.abs(p[0] - prev[0]), Math.abs(p[1] - prev[1]));
      prev = p;
    }
    await sleep(700); // 等追赶完成
    const yankEnd = win.getPosition();
    await win.webContents.executeJavaScript(
      `(function(){ const el = document.querySelector('.dp-sprite');
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, button: 0, clientX: ${c4.x + 400}, clientY: ${c4.y} })); return 1; })()`
    );
    await sleep(120);
    // 干扰免疫断言：无论期间真实手部是否移动光标，窗口必收敛到「光标 - 抓取点」
    const cur5 = getCursor();
    const expectX = cur5.x - c4.x, expectY = cur5.y - c4.y;
    report('yank-no-jump', maxJump <= 60, `甩动 400px 单次采样最大位移=${maxJump.toFixed(0)}px (起始=${yankStart})`);
    report('yank-catchup', Math.abs(yankEnd[0] - expectX) <= 12 && Math.abs(yankEnd[1] - expectY) <= 12,
      `终点=(${yankEnd}) 光标-抓取点=(${expectX},${expectY})`);

    SetCursorPos(back.x, back.y + Math.round(200 * px)); // 光标挪离窗口，避免误触
    const allPass = results.every(r => r.pass);
    finish(allPass ? 0 : 1);
  } catch (e) {
    console.error('[drag-test] EXCEPTION', e);
    report('exception', false, e.message);
    finish(1);
  }
});
