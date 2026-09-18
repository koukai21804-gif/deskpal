// 启动器：指令匹配（纯本地）与启动分发
const { shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const logger = require('../logger');

// 「打开X / 启动X / 运行X / 开启X / 开一下X」
const OPEN_RE = /^(打开|启动|运行|开启|开一下)(一下)?\s*(.{1,24})[。!！]?$/;

function list() {
  const cmds = store.get('commands').commands || [];
  return cmds.map(c => ({ ...c, missing: !fs.existsSync(c.path) }));
}

// 返回 {hit:true, id, label} 或 {hit:false}
function match(text) {
  const t = String(text || '').trim();
  const m = t.match(OPEN_RE);
  if (!m) return { hit: false };
  const target = m[3].trim();
  if (!target) return { hit: false };
  const cmds = store.get('commands').commands || [];
  let best = null;
  for (const c of cmds) {
    const p = String(c.phrase || '').trim();
    if (!p) continue;
    const pNoPrefix = p.replace(/^(打开|启动|运行|开启|开一下)(一下)?\s*/, '').trim();
    if (p === target || pNoPrefix === target || p.includes(target) || target.includes(pNoPrefix)) {
      // 取最长命中的指令词
      if (!best || p.length > String(best.phrase).length) best = c;
    }
  }
  if (!best) return { hit: false };
  return { hit: true, id: best.id, label: best.phrase, phrase: target };
}

function friendlyError(msg) { const e = new Error(msg); e.userMsg = msg; return e; }

async function runByCommand(cmd) {
  if (!fs.existsSync(cmd.path)) throw friendlyError(`找不到「${cmd.phrase}」对应的文件：${cmd.path}，请到 设置→指令 更新路径`);
  const ext = path.extname(cmd.path).toLowerCase();
  const args = String(cmd.args || '').trim();
  const argList = args ? args.split(/\s+/) : [];
  try {
    if (ext === '.exe' || ext === '.com') {
      spawn(cmd.path, argList, { detached: true, stdio: 'ignore', shell: false }).unref();
    } else if (ext === '.bat' || ext === '.cmd') {
      spawn('cmd.exe', ['/c', cmd.path, ...argList], { detached: true, stdio: 'ignore' }).unref();
    } else if (ext === '.html' || ext === '.htm' || ext === '.url' || /^https?:\/\//i.test(cmd.path)) {
      if (/^https?:\/\//i.test(cmd.path)) await shell.openExternal(cmd.path);
      else await shell.openPath(cmd.path);
    } else {
      await shell.openPath(cmd.path);
    }
    logger.info('启动器: ' + cmd.phrase + ' → ' + cmd.path);
  } catch (e) {
    logger.error(e);
    throw friendlyError('启动失败：' + (e.message || e));
  }
}

function runById(id) {
  const c = (store.get('commands').commands || []).find(x => x.id === id);
  if (!c) throw friendlyError('指令不存在，可能已被删除');
  return runByCommand(c);
}

function save(commands) {
  const clean = (commands || []).map((c, i) => ({
    id: c.id || 'cmd_' + Date.now().toString(36) + '_' + i,
    phrase: String(c.phrase || '').trim().slice(0, 40),
    path: String(c.path || ''),
    args: String(c.args || '').slice(0, 200),
  })).filter(c => c.phrase && c.path);
  store.replace('commands', { commands: clean });
  return list();
}

module.exports = { list, match, runByCommand, runById, save };
