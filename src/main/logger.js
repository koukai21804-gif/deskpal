// 简单日志：console + userData/logs/main.log，1MB × 2 轮转
const fs = require('fs');
const path = require('path');

let logDir = null, logFile = null, MAX = 1024 * 1024;

function init(dir) {
  logDir = dir;
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'main.log');
  rotateIfNeeded();
}

function rotateIfNeeded() {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX) {
      const f2 = logFile + '.2', f1 = logFile + '.1';
      if (fs.existsSync(f1)) fs.renameSync(f1, f2);
      fs.renameSync(logFile, f1);
    }
  } catch (_) { /* 轮转失败不影响运行 */ }
}

function ts() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function write(level, msg) {
  const line = `${ts()} [${level}] ${typeof msg === 'string' ? msg : (msg && msg.message ? msg.message : require('util').inspect(msg))}`;
  if (level === 'ERROR') console.error(line); else if (level === 'WARN') console.warn(line); else console.log(line);
  if (!logFile) return;
  try {
    rotateIfNeeded();
    fs.appendFileSync(logFile, line + '\n' + (level === 'ERROR' && msg && msg.stack ? msg.stack + '\n' : ''));
  } catch (_) { /* 磁盘满等极端情况忽略 */ }
}

module.exports = {
  init,
  info: m => write('INFO', m),
  warn: m => write('WARN', m),
  error: m => write('ERROR', m),
};
