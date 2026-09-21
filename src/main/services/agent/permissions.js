// 写权限卡生命周期：request() 挂起 Promise → 渲染层 agent:permission-resolve 裁决
// fail-closed：超时 / 异常 / 停止 / 退出，一切非明确 allow_once 的路径都按拒绝结算。
const windows = require('../../windows');
const logger = require('../../logger');

const pending = new Map(); // requestId -> { req, resolve, timer }
let seq = 0;

function send(channel, data) {
  const win = windows.getWindow('chat');
  if (win) { try { win.webContents.send(channel, data); } catch (_) {} }
}

// 宠物气泡提醒（复用 pet:bubble；点击「去批准」聚焦聊天窗）
function notifyPet() {
  try { windows.broadcastAll('pet:bubble', { kind: 'perm-ask', text: '有个文件操作需要你批准' }); } catch (_) {}
}

// 发起权限请求；resolve 值为 {id, decision}，decision ∈ allow_once|deny|timeout|stopped（loop 只认 allow_once）
function request({ runId, reqId, tool, action, scopePaths, detail, reason, reversibility, timeoutSec }) {
  const id = 'perm_' + Date.now().toString(36) + '_' + (++seq);
  return new Promise((resolve) => {
    const req = {
      id, runId, reqId, tool,
      action, scopePaths, detail,
      reason: String(reason || '').slice(0, 120),
      reversibility,
      options: ['allow_once', 'deny'],
      createdAt: Date.now(),
      timeoutSec,
    };
    const settleFailClosed = () => settle(id, 'timeout', '已超时，按拒绝处理');
    let timer = null;
    try {
      timer = setTimeout(settleFailClosed, Math.max(10, timeoutSec) * 1000);
    } catch (e) {
      // 定时器异常：fail-closed，立即按超时拒绝
      resolve({ id, decision: 'timeout' });
      return;
    }
    pending.set(id, { req, resolve, timer });
    // 载荷顶层带 reqId（附录 C 契约）：渲染层用它与当前流式消息匹配，防止跨 run 串卡
    send('agent:permission', { tab: 'roleplay', reqId: req.reqId, request: req });
    logger.info(`[agent] 权限卡已发起 id=${id} reqId=${req.reqId || '-'} paths=${(scopePaths || []).join(',')} timeout=${timeoutSec}s`);
    notifyPet();
  });
}

// 终态结算：广播 agent:permission 终态，唤醒等待方（值为 {id, decision}）
function settle(id, decision, note) {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  // 一切非 allow_once 的 decision 都按拒绝语义处理；记录值原样透传（deny|timeout|stopped）
  p.resolve({ id, decision });
  send('agent:permission', { requestId: id, decision, final: true, note: note || null });
  logger.info(`[agent] 权限卡结算 id=${id} decision=${decision}${note ? ' (' + note + ')' : ''}`);
  return true;
}

// 用户点击卡片按钮
function resolveRequest(id, decision) {
  if (decision !== 'allow_once') decision = 'deny';
  return settle(id, decision);
}

// chat:stop / app 退出：全部按停止拒绝（UI 卡片转「已停止」）
function denyAllStopped() {
  for (const id of [...pending.keys()]) settle(id, 'stopped', '任务已停止');
}

function countPending() { return pending.size; }

module.exports = { request, resolveRequest, denyAllStopped, countPending };
