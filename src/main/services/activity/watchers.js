// 窗口监测（koffi FFI）：1s 前台窗口轮询 + 5s 空闲轮询（GetLastInputInfo）
// 与 ActivityWatch 相同的 API 轮询方案，无全局钩子
const koffi = require('koffi');
const store = require('../store');
const tracker = require('./tracker');
const logger = require('../../logger');

let user32 = null, kernel32 = null;
let fns = null;
let winTimer = null, idleTimer = null;
let lastIdleMs = 0;
let running = false;

function loadDlls() {
  user32 = koffi.load('user32.dll');
  kernel32 = koffi.load('kernel32.dll');
  fns = {
    GetForegroundWindow: user32.func('intptr_t GetForegroundWindow()'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t, void *, int)'),
    GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t, void *)'),
    GetLastInputInfo: user32.func('int __stdcall GetLastInputInfo(void *)'),
    GetTickCount: kernel32.func('uint32_t GetTickCount()'),
    OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32_t, int, uint32_t)'),
    QueryFullProcessImageNameW: kernel32.func('int __stdcall QueryFullProcessImageNameW(intptr_t, uint32_t, void *, void *)'),
    CloseHandle: kernel32.func('int __stdcall CloseHandle(intptr_t)'),
  };
}

function readWStr(buf) {
  const s = buf.toString('utf16le');
  const i = s.indexOf('\0');
  return i === -1 ? s : s.slice(0, i);
}

// 当前前台窗口信息 { pid, exePath, exeName, title }，失败返回 null
function foregroundWindow() {
  const hwnd = fns.GetForegroundWindow();
  if (!hwnd) return null;
  const titleBuf = Buffer.alloc(1024);
  fns.GetWindowTextW(hwnd, titleBuf, 512);
  const title = readWStr(titleBuf).trim();
  if (!title) return null; // 桌面等无标题窗口忽略

  const pidBuf = Buffer.alloc(4);
  fns.GetWindowThreadProcessId(hwnd, pidBuf);
  const pid = pidBuf.readUInt32LE(0);
  if (!pid) return null;

  let exePath = '', exeName = '';
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const h = fns.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (h) {
    const nameBuf = Buffer.alloc(2048);
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32LE(1024, 0);
    if (fns.QueryFullProcessImageNameW(h, 0, nameBuf, sizeBuf)) {
      exePath = readWStr(nameBuf);
      if (exePath) {
        const m = exePath.split(/[\\/]/);
        exeName = m[m.length - 1] || '';
      }
    }
    fns.CloseHandle(h);
  }
  if (!exeName) return null;
  return { pid, exePath, exeName, title };
}

// 距上次输入的毫秒数
function idleMilliseconds() {
  const info = Buffer.alloc(8);
  info.writeUInt32LE(8, 0); // cbSize
  if (!fns.GetLastInputInfo(info)) return 0;
  const last = info.readUInt32LE(4);
  const now = fns.GetTickCount();
  return ((now - last) + 0x100000000) % 0x100000000; // 32 位回绕
}

function pollWindow() {
  try {
    const w = foregroundWindow();
    if (w) tracker.onWindowSample(w);
  } catch (e) { logger.warn('窗口轮询失败: ' + e.message); }
}

function pollIdle() {
  try {
    const cfg = store.get('settings').activity;
    const thresholdMs = Math.max(30, cfg.idleThresholdSec || 180) * 1000;
    const idleMs = idleMilliseconds();
    const now = Date.now();
    if (lastIdleMs < thresholdMs && idleMs >= thresholdMs) {
      // 活跃 → 空闲：afk 开始时刻 = 最后输入时刻
      tracker.onIdleStart(now - idleMs);
    } else if (lastIdleMs >= thresholdMs && idleMs < thresholdMs) {
      // 空闲 → 活跃：idle-end 时机，可能触发标注询问
      tracker.onIdleEnd(now);
    }
    lastIdleMs = idleMs;
  } catch (e) { logger.warn('空闲轮询失败: ' + e.message); }
}

function startTimers() {
  const cfg = store.get('settings').activity;
  winTimer = setInterval(pollWindow, Math.max(250, cfg.windowPollMs || 1000));
  idleTimer = setInterval(pollIdle, Math.max(1000, cfg.idlePollMs || 5000));
  pollWindow(); pollIdle();
}

function stopTimers() {
  if (winTimer) clearInterval(winTimer);
  if (idleTimer) clearInterval(idleTimer);
  winTimer = idleTimer = null;
}

function start() {
  if (running) return;
  try {
    loadDlls();
  } catch (e) {
    logger.error(e);
    logger.warn('koffi/user32 不可用，时间监测停用');
    return;
  }
  running = true;
  tracker.start();
  if (!store.get('settings').activity.paused) startTimers();
}

function stop() {
  running = false;
  stopTimers();
  tracker.flush();
}

function setPaused(paused) {
  store.set('settings', { activity: { paused: !!paused } });
  if (!running) return;
  if (paused) { stopTimers(); tracker.flush(); }
  else startTimers();
}

function isRunning() { return running && !!winTimer; }

module.exports = { start, stop, setPaused, isRunning, foregroundWindow, idleMilliseconds };
