// hindsight — Hindsight 语义记忆的 LLM 消耗（retain 提取）。
// 数据源：过滤代理的 token 台账（D:\hindsight\proxy\logs\usage.jsonl，代理在 retain 响应里
// 抓 usage 追加）。每个 bank 一个「会话」，每次 retain 一个事件。
// 边界声明（评审 §6.1 条款三）：只读数字台账，不触记忆内容端点，不跨 bank 检索——
// 汇总给人看的运维面板，属「控制台可见全部 bank」的运维可见性范畴。
// 纯 Node、无 electron 依赖；服务未运行也能看历史台账。
const fs = require('fs');
const path = require('path');
const { anyToMs, isNum } = require('../util');

const USAGE_FILE_DEFAULT = path.join('D:', path.sep, 'hindsight', 'proxy', 'logs', 'usage.jsonl');
function usageFile() {
  // scan 时求值（勿在模块级固化）：测试用 HINDSIGHT_USAGE_LOG 指向夹具，env 后改须生效
  return process.env.HINDSIGHT_USAGE_LOG || USAGE_FILE_DEFAULT;
}
const ENV_FILE = path.join(require('os').homedir(), '.hindsight', 'hindsight.env');

function readModel() {
  // 模型名取自服务配置（retain 提取用的 LLM）；读不到就给个可读占位
  try {
    const line = fs.readFileSync(ENV_FILE, 'utf8').split('\n').find(l => /^HINDSIGHT_API_LLM_MODEL=/.test(l));
    const m = line && line.split('=')[1].trim();
    return m || 'hindsight-llm';
  } catch (_) { return 'hindsight-llm'; }
}

module.exports = {
  id: 'hindsight',
  name: 'Hindsight 记忆',
  // 台账在本机固定路径（D:\hindsight），不随设备根走——同 deskpal：只随本机扫一次，
  // 否则会对每个设备根重复累计（test-tokenboard PC-2 设备维度测试逮过这个错）
  usesDataDir: true,
  scan() {
    const USAGE_FILE = usageFile();
    if (!fs.existsSync(USAGE_FILE)) {
      return { status: 'missing', statusNote: '代理尚无 token 台账（服务未部署或部署后无 retain）', sessions: [] };
    }
    const model = readModel();
    const byBank = new Map(); // bank → events
    try {
      const lines = fs.readFileSync(USAGE_FILE, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        let o; try { o = JSON.parse(line); } catch (_) { continue; }
        const ts = anyToMs(o.ts);
        if (!ts) continue;
        const bank = String(o.bank || 'unknown');
        if (!byBank.has(bank)) byBank.set(bank, []);
        byBank.get(bank).push({
          ts, model,
          input: isNum(o.input) ? +o.input : 0,
          output: isNum(o.output) ? +o.output : 0,
          cacheRead: isNum(o.cached) ? +o.cached : 0,
          cacheWrite: 0,
          reasoning: 0,
          requests: isNum(o.requests) ? +o.requests : 1,
        });
      }
    } catch (_) {}

    const sessions = [];
    let lastAt = 0;
    for (const [bank, events] of byBank) {
      events.sort((a, b) => a.ts - b.ts);
      for (const ev of events) if (ev.ts > lastAt) lastAt = ev.ts;
      sessions.push({
        id: 'hindsight:' + bank,
        label: bank,
        lastAt: events[events.length - 1].ts,
        events,
      });
    }
    if (!sessions.length) return { status: 'missing', statusNote: '台账为空', sessions: [] };
    sessions.sort((a, b) => b.lastAt - a.lastAt);
    const totalReq = sessions.reduce((n, s) => n + s.events.length, 0);
    return {
      status: 'ok',
      statusNote: `${sessions.length} bank · ${totalReq} 次 retain 提取`,
      meta: { detail: 'retain LLM 提取消耗（经 8890 过滤代理记账）' },
      sessions,
    };
  },
};
