// 视觉捕获：look_screen（桌面截屏）/ look_camera（摄像头一帧）的主进程实现。
// 方案借鉴 Amadeus System（github.com/Akatosh6DW/Amadeus，MIT）的 capture_screen.py / capture_camera.py：
// - 截屏前隐藏本应用自己的窗口（角色「看屏幕」时看不见自己，画面不被自身窗口遮挡）；
// - 黑帧校验（缩样 64×64 后算亮度均值/标准差，全黑帧 = 捕获失败，不喂给模型当真画面）；
// - 摄像头预热帧（首帧普遍曝光不足，连采多帧取最后一张）；
// - 前台窗口标题随截图回传（桌面识别的上下文锚点）；
// - 感知纪律（tool_architecture.infer_perception_need 的浏览器侧对应）：不默认开摄像头——
//   每次调用都须经用户授权卡（camera_sensitive），截屏遵循 web_search 同款双轨授权。
// 图像回填复用 read_image 协议：{text, imagePart, meta}，由 loop 以 user 消息注入视觉上下文。
// 纯 Node 单测下 electron 不可用：getElectron() 返回 null，捕获函数给出可测的类型化失败。
const path = require('path');
const store = require('../store');
const llm = require('../llm');
const permissions = require('./permissions');
const { MAX_DATAURL_CHARS, probeImage, toDataUrl } = require('./image-utils');

const HIDE_SETTLE_MS = 220;        // 隐藏自身窗口后的合成等待（Amadeus 用 DwmFlush+160ms，主进程拿不到 DwmFlush，用稍长睡眠代偿）
const SCREEN_BLACK_RETRY_MS = 200; // 黑帧重试间隔（隐藏窗口后首抓可能撞上合成中间态）
const CAMERA_TIMEOUT_MS = 20000;   // 摄像头采集整体超时（含授权与曝光预热）
const CAMERA_WARMUP_FRAMES = 10;   // 预热帧数（Amadeus 12 帧 @25ms；浏览器侧 45ms 间隔）
const CAMERA_DENY_COOLDOWN_MS = 60000; // 摄像头授权被拒后的冷却（防模型连续骚扰式弹卡）
const THUMB_MAX_SIDE = 2048;       // 截屏缩略图请求上限（超过部分反正会被 image-utils 缩样）

// 摄像头采集页绝对路径。__dirname = <root>/src/main/services/agent（打包后为 app.asar 下同构路径），
// 上跳三级到 <root>/src，再接 renderer/...。20261021 打包事故修复：旧写法上跳三级后又拼
// 'src'，产生 src/src/renderer/... 致 ERR_FILE_NOT_FOUND（只在真实 loadFile 时暴露，纯 Node
// 桩测试测不到）。改为模块级常量 + 回归测试断言（test-vision-capture.js ②½），双保险。
const CAPTURE_PAGE_PATH = path.join(__dirname, '..', '..', '..', 'renderer', 'camera', 'capture.html');

// electron 惰性获取（纯 Node 单测 / 打包外运行时为 null）
function getElectron() {
  try {
    const e = require('electron');
    return (e && typeof e === 'object' && e.desktopCapturer && e.nativeImage) ? e : null;
  } catch (_) { return null; }
}

// ---- 亮度统计（Amadeus validate_frame 的纯函数化）----
// buf：RGBA/BGRA 原始字节（通道序不影响黑白判定）；返回各通道均值与标准差
function statsFromRGBA(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const n = Math.floor(b.length / 4);
  if (!n) return { mean: [0, 0, 0], stddev: [0, 0, 0] };
  const sum = [0, 0, 0], sumsq = [0, 0, 0];
  for (let i = 0; i + 3 < b.length; i += 4) {
    for (let c = 0; c < 3; c++) { const v = b[i + c]; sum[c] += v; sumsq[c] += v * v; }
  }
  const mean = sum.map(s => s / n);
  const stddev = sumsq.map((s, c) => Math.sqrt(Math.max(0, s / n - mean[c] * mean[c])));
  return { mean: mean.map(v => Math.round(v * 1000) / 1000), stddev: stddev.map(v => Math.round(v * 1000) / 1000) };
}
// 全黑帧判定（阈值与 Amadeus 一致：stddev<0.8 且 mean<3.0——纯黑桌面/未点亮摄像头都会命中）
function isBlackFrame(stats) {
  return Math.max(...stats.stddev) < 0.8 && Math.max(...stats.mean) < 3.0;
}

// NativeImage 的缩样统计（截屏/摄像头主进程侧校验共用）
function nativeImageStats(img) {
  try {
    const small = img.resize({ width: 64, height: 64, quality: 'good' });
    return statsFromRGBA(small.toBitmap());
  } catch (_) { return { mean: [255, 255, 255], stddev: [255, 255, 255] }; } // 解码异常不拦图（宁漏勿滥）
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- 前台窗口标题（Amadeus foreground_window_title 的 koffi 移植）----
let _user32 = null;
function getUser32() {
  if (process.platform !== 'win32') return null;
  if (_user32 !== null) return _user32 || null;
  try {
    const koffi = require('koffi');
    const u = koffi.load('user32.dll');
    _user32 = {
      getForeground: u.func('intptr_t GetForegroundWindow()'),
      getText: u.func('int GetWindowTextW(intptr_t hWnd, char16_t *lpString, int nMaxCount)'),
      buf: koffi.alloc('char16_t[512]'),
    };
  } catch (_) { _user32 = false; }
  return _user32 || null;
}
function foregroundWindowTitle() {
  const u = getUser32();
  if (!u) return '';
  try {
    const hwnd = u.getForeground();
    if (!hwnd) return '';
    const len = u.getText(hwnd, u.buf, 511);
    if (len <= 0) return '';
    const koffi = require('koffi');
    const arr = koffi.decode(u.buf, 'char16_t[512]', 0, len);
    return Array.from(arr, ch => String.fromCharCode(ch)).join('');
  } catch (_) { return ''; }
}

// ---- 自身窗口排除（Amadeus hide_amadeus_windows 的 Electron 版）----
// 只隐藏「当前可见且未最小化」的窗口，restore 交回原样（hide/show 保留最大化状态）
function hideSelfWindows() {
  const hidden = [];
  const failures = [];
  try {
    const windows = require('../../windows');
    for (const name of Object.keys(windows.WIN_DEFS || {})) {
      try {
        const w = windows.getWindow(name);
        if (!w) continue;
        if (!w.isVisible() || w.isMinimized()) continue;
        w.hide();
        hidden.push({ name, win: w });
      } catch (e) { failures.push(`${name}: ${e.message}`); }
    }
  } catch (e) { failures.push(`windows: ${e.message}`); }
  return { hidden, failures };
}
function restoreSelfWindows(hidden, failures) {
  for (const item of hidden || []) {
    try { if (!item.win.isDestroyed()) item.win.show(); } catch (e) { failures.push(`${item.name}: ${e.message}`); }
  }
}

// ---- 桌面截屏 ----
// 返回 {ok, buf(经 probeImage 缩样), mime, width, height, resized, screens, index, isPrimary,
//        foreground, selfExcluded, warnings, stats}
async function captureScreen({ index } = {}) {
  const electron = getElectron();
  if (!electron || !electron.screen) {
    const e = new Error('桌面截屏需要在 deskpal 应用内运行（当前环境无 Electron 桌面捕获接口）');
    e.userMsg = e.message;
    throw e;
  }
  const { desktopCapturer, screen: escreen } = electron;
  const displays = escreen.getAllDisplays().slice();
  const primaryId = escreen.getPrimaryDisplay().id;
  displays.sort((a, b) => (a.id === primaryId ? -1 : b.id === primaryId ? 1 : 0));
  const idx = Number.isFinite(+index) && +index >= 0 ? Math.round(+index) : 0;
  if (idx >= displays.length) {
    return { ok: false, error: `屏幕序号超出范围：本机共 ${displays.length} 块屏（序号 0–${displays.length - 1}，0 为主屏）` };
  }
  const target = displays[idx];
  const sf = target.scaleFactor || 1;
  // 缩略图按目标屏物理像素请求（上限 2048：vision 模型按贴片计费，超清纯浪费，image-utils 也会再缩）
  const pw = Math.round(target.size.width * sf), ph = Math.round(target.size.height * sf);
  const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(pw, ph));
  const thumbSize = { width: Math.max(1, Math.round(pw * scale)), height: Math.max(1, Math.round(ph * scale)) };

  // 先隐藏自身窗口 → 等合成 → 再抓（thumbnail 在 getSources 调用瞬间成像）
  const warnings = [];
  const { hidden, failures } = hideSelfWindows();
  warnings.push(...failures);
  let img = null, fgTitle = '', stats = null;
  try {
    await sleep(HIDE_SETTLE_MS);
    fgTitle = foregroundWindowTitle(); // 隐藏自身后读，标题即截图里真正可见的前台窗口
    for (let attempt = 0; attempt < 2; attempt++) {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumbSize });
      const src = sources.find(s => String(s.display_id) === String(target.id)) || sources[idx] || sources[0];
      if (!src || src.thumbnail.isEmpty()) throw new Error('desktopCapturer 未返回可用的屏幕画面');
      stats = nativeImageStats(src.thumbnail);
      if (!isBlackFrame(stats)) { img = src.thumbnail; break; }
      if (attempt === 0) await sleep(SCREEN_BLACK_RETRY_MS); // 首抓撞上合成中间态：稍候重抓一次
    }
  } finally {
    const restoreFailures = [];
    restoreSelfWindows(hidden, restoreFailures);
    warnings.push(...restoreFailures);
  }
  if (!img) {
    return { ok: false, error: '截屏校验失败：画面为全黑帧（屏幕可能已锁定/休眠，或捕获接口异常），未把黑图当真画面送识别' };
  }
  const buf = img.toPNG();
  const probe = probeImage(buf, 'image/png');
  const size = img.getSize();
  return {
    ok: true,
    buf: probe.buf, mime: probe.mime, width: probe.width || size.width, height: probe.height || size.height, resized: !!probe.resized,
    screens: displays.length, index: idx, isPrimary: target.id === primaryId,
    foreground: fgTitle, selfExcluded: hidden.length, warnings, stats,
  };
}

// ---- 摄像头一帧 ----
// 隐藏 BrowserWindow（独立 partition + media 白名单）加载采集页，executeJavaScript 回传 dataURL。
// 采集页见 src/renderer/camera/capture.html（纯浏览器 API：getUserMedia + canvas）。
async function captureCamera({ index } = {}) {
  const electron = getElectron();
  if (!electron || !electron.BrowserWindow) {
    const e = new Error('摄像头采集需要在 deskpal 应用内运行（当前环境无 Electron 窗口接口）');
    e.userMsg = e.message;
    throw e;
  }
  const { BrowserWindow } = electron;
  const idx = Number.isFinite(+index) && +index >= 0 ? Math.round(+index) : 0;
  const win = new BrowserWindow({
    show: false, skipTaskbar: true, frame: false, width: 480, height: 360,
    webPreferences: {
      sandbox: true, nodeIntegration: false, contextIsolation: true,
      partition: 'dp-camera-capture', // 独立会话：media 权限白名单不影响聊天窗等默认会话
    },
  });
  // 仅本会话放行摄像头权限（拍完销毁窗口，会话随之废弃）
  try {
    win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media');
    });
    win.webContents.session.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  } catch (_) { /* 老接口缺失时依赖默认放行 */ }
  try {
    await win.loadFile(CAPTURE_PAGE_PATH);
    const js = `window.__dpCamCapture(${JSON.stringify({ index: idx, warmup: CAMERA_WARMUP_FRAMES })})`;
    let result;
    try {
      result = await Promise.race([
        win.webContents.executeJavaScript(js, true),
        sleep(CAMERA_TIMEOUT_MS).then(() => null),
      ]);
    } catch (e) {
      const msg = /NotAllowedError|Permission denied/i.test(String(e && e.message)) ? '摄像头权限被系统或浏览器拒绝' : `摄像头采集失败：${(e && e.message) || e}`;
      const err = new Error(msg); err.userMsg = msg; throw err;
    }
    if (!result) { const err = new Error(`摄像头采集超时（${CAMERA_TIMEOUT_MS / 1000}s 内未取到画面）`); err.userMsg = err.message; throw err; }
    if (!result.ok) { const err = new Error(String(result.error || '摄像头采集失败')); err.userMsg = err.message; throw err; }
    // 主进程侧再验一次黑帧（采集页只负责拍，判定统一在主进程）
    const b64 = String(result.dataUrl || '').split(',')[1] || '';
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new Error('摄像头回传了空画面');
    const stats = nativeImageStats(electron.nativeImage.createFromBuffer(buf));
    if (isBlackFrame(stats)) {
      return { ok: false, error: '摄像头画面为全黑帧（镜头可能被遮挡或未点亮），未把黑图当真画面送识别' };
    }
    const probe = probeImage(buf, 'image/jpeg');
    return {
      ok: true,
      buf: probe.buf, mime: probe.mime, width: probe.width || result.width, height: probe.height || result.height,
      resized: !!probe.resized, deviceLabel: String(result.deviceLabel || ''), deviceCount: +result.deviceCount || 0,
      index: idx, stats,
    };
  } finally {
    try { win.destroy(); } catch (_) {} // 销毁窗口即确保流停止/灯灭
  }
}

// ---- 授权与工具出口 ----
function visionOffError() {
  const e = new Error('当前模型未开启图像识别：请到 设置→API→「图像识别」选「强制开启」（模型须支持图像输入），或更换多模态模型');
  e.userMsg = e.message;
  throw e;
}
function vcSettings() {
  return ((store.get('settings').agent || {}).visionCapture) || {};
}

let lastCamDenyAt = 0; // 摄像头授权被拒时间戳（冷却内直接拒，不再弹卡）

// look_screen 出口：视觉能力闸 → 双轨授权（未开启：designated 弹开启卡 / autonomous 直接拒；
// 已开启：designated 直行 / autonomous 逐次卡）→ 截屏 → read_image 同款回执
async function lookScreen(args, ctx) {
  if (!llm.isVisionCapable()) visionOffError();
  const track = args.track === 'autonomous' ? 'autonomous' : 'designated';
  const reason = String(args.reason || '').trim();
  if (!reason) return { ok: false, error: '缺少 reason 参数：请说明为什么需要看屏幕（≤60字）' };

  const enabled = !!vcSettings().screenEnabled;
  if (!enabled && track === 'autonomous') {
    // 与 web_search 同款防试探：未开启时自主轨不弹卡直接拒
    return { ok: false, error: '桌面查看未开启，仅用户明确要求的看屏可触发开启授权。' };
  }
  if (!enabled || track === 'autonomous') {
    const pr = await permissions.request({
      runId: ctx && ctx.runId, reqId: ctx && ctx.reqId, tool: 'look_screen',
      action: enabled ? '自主截取桌面' : '开启桌面查看（截屏识别）',
      scopePaths: [`screen:${String(args.screen ?? '0')}`],
      detail: enabled
        ? reason
        : '开启后可截取桌面画面交给你配置的模型服务商识别；可在 设置→API 关闭',
      reason,
      reversibility: enabled ? '仅截取一帧，不落盘' : '设置→API 一键关闭（关闭即时生效）',
      timeoutSec: (ctx && ctx.permTimeoutSec) || 120,
    });
    if (pr.decision !== 'allow_once') {
      return { ok: false, error: '用户没有批准这次截屏，本次不执行。请如实告知用户。' };
    }
    if (!enabled) {
      store.set('settings', { agent: { visionCapture: { screenEnabled: true } } });
      if (ctx && ctx.step) { try { ctx.step({ kind: 'notice', notice: 'screen_vision_enabled', text: '桌面查看已开启，可在 设置→API 关闭' }); } catch (_) {} }
    }
  }

  // 经 module.exports 取实现（测试可整体替换为桩；本文件尾部的整体赋值会弃用 exports 简写）
  const r = await module.exports.captureScreen({ index: args.screen });
  if (!r.ok) return { ok: false, error: r.error };
  const dataUrl = toDataUrl(r.mime, r.buf);
  if (dataUrl.length > MAX_DATAURL_CHARS) return { ok: false, error: '截屏编码后超出接口体积上限，请换更低的屏幕分辨率或稍后再试' };
  const dims = `${r.width}×${r.height}`;
  const parts = [
    `[look_screen] 桌面截图｜第 ${r.index} 块屏${r.isPrimary ? '（主屏）' : ''}${r.resized ? `（已自动缩放至 ${dims}）` : `｜${dims}`}`,
    r.screens > 1 ? `本机共 ${r.screens} 块屏` : '',
    `前台窗口「${r.foreground || '未知'}」`,
    r.selfExcluded ? `已排除自身窗口 ${r.selfExcluded} 个` : '',
  ].filter(Boolean).join('｜');
  return {
    ok: true,
    text: `${parts}｜图像已注入视觉上下文：基于画面实际内容作答，画面中没有的信息不要编造`,
    imagePart: { type: 'image_url', image_url: { url: dataUrl } },
    meta: { tool: 'look_screen', path: `screen:${r.index}`, bytes: r.buf.length, width: r.width, height: r.height, mime: r.mime, resized: r.resized, screens: r.screens, foreground: r.foreground },
  };
}

// look_camera 出口：每次调用都弹授权卡（camera_sensitive，借鉴 Amadeus 感知纪律：
// 不默认开摄像头）；被拒后 60s 冷却内不再弹卡直接拒
async function lookCamera(args, ctx) {
  if (!llm.isVisionCapable()) visionOffError();
  const reason = String(args.reason || '').trim();
  if (!reason) return { ok: false, error: '缺少 reason 参数：请说明为什么需要开摄像头（≤60字）' };

  if (Date.now() - lastCamDenyAt < CAMERA_DENY_COOLDOWN_MS) {
    return { ok: false, error: `用户刚拒绝过开启摄像头（${Math.ceil(CAMERA_DENY_COOLDOWN_MS / 1000)}s 内不会再弹授权卡）。请先与用户确认意愿，不要反复请求。` };
  }
  const pr = await permissions.request({
    runId: ctx && ctx.runId, reqId: ctx && ctx.reqId, tool: 'look_camera',
    action: '开启摄像头拍一帧',
    scopePaths: [`camera:${String(args.camera ?? '0')}`],
    detail: '开启摄像头拍摄一帧当前实景，交给你配置的模型服务商识别；拍完立即关闭摄像头，不留任何影像',
    reason,
    reversibility: '拍完即关（画面不落盘），不拍摄即无任何采集',
    timeoutSec: (ctx && ctx.permTimeoutSec) || 120,
  });
  if (pr.decision !== 'allow_once') {
    lastCamDenyAt = Date.now();
    return { ok: false, error: '用户没有批准开启摄像头，本次不执行。请如实告知用户，不要连续请求。' };
  }
  lastCamDenyAt = 0; // 批准后清冷却（连续合法使用不受影响）

  const r = await module.exports.captureCamera({ index: args.camera });
  if (!r.ok) return { ok: false, error: r.error };
  const dataUrl = toDataUrl(r.mime, r.buf);
  if (dataUrl.length > MAX_DATAURL_CHARS) return { ok: false, error: '摄像头画面超出接口体积上限' };
  const dims = `${r.width}×${r.height}`;
  return {
    ok: true,
    text: `[look_camera] 摄像头一帧｜设备${r.deviceLabel ? `「${r.deviceLabel}」` : `#${r.index}`}${r.resized ? `（已自动缩放至 ${dims}）` : `｜${dims}`}｜摄像头已关闭｜图像已注入视觉上下文：基于画面实际内容作答，画面中没有的信息不要编造`,
    imagePart: { type: 'image_url', image_url: { url: dataUrl } },
    meta: { tool: 'look_camera', path: `camera:${r.index}`, bytes: r.buf.length, width: r.width, height: r.height, mime: r.mime, resized: r.resized, deviceLabel: r.deviceLabel },
  };
}

module.exports = {
  lookScreen, lookCamera,
  captureScreen, captureCamera,
  statsFromRGBA, isBlackFrame, foregroundWindowTitle,
  CAPTURE_PAGE_PATH,
  CAMERA_DENY_COOLDOWN_MS, HIDE_SETTLE_MS, CAMERA_WARMUP_FRAMES, THUMB_MAX_SIDE,
  _resetForTest() { lastCamDenyAt = 0; _user32 = null; },
};
