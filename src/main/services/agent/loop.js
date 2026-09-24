// Agent 执行循环：tool-call 循环 + runEpoch 打断 + 轮次上限 + 假完成重试。
// 接入点在 chat.js send() 的后台协程内（不为 agent 单开 IPC 入口）。
// 中间工具轮不写入对话历史：chats/roleplay 只存用户消息与最终 clean 回复，
// run 全过程（工具/权限/进展/变更）落 agent/runs.jsonl。
const fs = require('fs');
const path = require('path');
const llm = require('../llm');
const store = require('../store');
const logger = require('../../logger');
const windows = require('../../windows');
const emotion = require('../emotion');
const guard = require('../fs-guard');
const tools = require('./builtin'); // 注册表（require 即注册内置工具）
const permissions = require('./permissions');
const traceMod = require('./trace');
const runs = require('./runs');
const { makeStreamPipeline } = require('../stream-pipeline');

const CAP_MSG = '已达执行轮次上限。请不要再调用工具，基于现有结果直接给出最终答复。';
const FAKE_DONE_MSG = '上一轮你没有调用任何工具就声称完成了任务。若任务确需读写文件，请调用工具执行；若确实无需工具，直接给出最终答复。';
const DENY_BREAK_MSG = '用户已两次拒绝同一写入目标，停止再次尝试该目标。';
const LENGTH_MSG = '上一轮输出因达到 max_tokens 上限被截断，末尾的工具调用没有执行、任务未完成。请重新来：正文从简（≤100字），直接调用工具；写入大文件必须分段——先 write_file 写第一段（≤3000字），后续各段用参数 append:"true" 追加。';
const CLAIM_MSG = '上一轮你声称已写入文件，但本次任务没有任何成功的 write_file 调用，该文件实际并不存在。请立即实际调用 write_file 完成写入（大文件分段：先写第一段，再以 append:"true" 逐段追加）；若确实无法写入，必须如实告知用户并说明原因，绝不允许声称已写入未写入的文件。';
const PROG_COUNT_RE = /\[进展[:：]\s*(?:设计|发现|能力|验证)/g;

// 「声称已写入」检测：完成态标记（已/已经/…了）+ 写入动词，且上下文有文件线索（扩展名/文件/文档/写入/数据目录）。
// 文件线索可挡掉角色扮演剧情里的虚构表述（如「把信写好了」）误触发。
const WRITE_CLAIM_RE = /(已经|已)[^\n。！？]{0,16}(写入|写好|保存|建好|创建|生成|写进|存进|存到|写到)|(写入|写好|保存|建好|创建|生成)了[^\n。！？]{0,8}(文件|文档|\.md|\.txt|\.json)/;
const FILE_HINT_RE = /\.(md|txt|json|csv|log|ya?ml|html?|js|ts|py|docx?|xlsx?|pptx?)\b|写入|文件|文档|数据目录/;
function claimsWrite(text) {
  const t = String(text || '');
  return WRITE_CLAIM_RE.test(t) && FILE_HINT_RE.test(t);
}

const activeRuns = new Map(); // reqId -> abort()

function push(channel, data) {
  const win = windows.getWindow('chat');
  if (win) { try { win.webContents.send(channel, data); } catch (_) {} }
}

function clampNum(v, min, max, dflt) {
  const n = Math.round(+v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

// 工具结果回填上限按工具名取（builtin.RESULT_CAPS）：read_file 分段自截可放宽，
// 其余工具保持 4000 保护性截断，防止 list_dir 等意外大结果撑爆决策轮上下文
function jstr(v, limit = 4000) { return JSON.stringify(v).slice(0, limit); }

// opts：
//   reqId / instruction / baseMessages（chat.js 的 system+历史上下文）
//   onFinal(fl)     —— 最终回复（管线 flush 结果），chat.js 存史/广播/记忆；返回 llm:done 附加载荷（如 msgId）
//   onDone(payload) —— 发 llm:done（payload 含 fl + runId + changes）
//   onAborted(x)    —— 发 llm:done aborted
//   onError(e)      —— 发 llm:error
async function startRun(opts) {
  const o = opts;
  const agentCfg = store.get('settings').agent || {};
  const maxRounds = clampNum(agentCfg.maxRounds, 4, 16, 8);
  const permTimeout = clampNum(agentCfg.permissionTimeoutSec, 60, 300, 120);
  // 工具轮输出上限：write_file 的参数内嵌整个文件内容，远超普通聊天回复，
  // 沿用聊天 max_tokens 会在工具参数中途截断（finishReason=length、调用作废）
  const toolMaxTokens = clampNum(agentCfg.toolMaxTokens, 2048, 65536, 8192);
  // ★权限模式（聊天窗/设置页三档）：read=只读（write 工具不下发）；userData=数据目录内直写；full=大范围+逐次权限卡
  const mode = ['read', 'userData', 'full'].includes(agentCfg.permissionMode) ? agentCfg.permissionMode : 'read';
  guard.setWriteMode(mode);
  const schemas = tools.openAiSchemas().filter(s => !(mode === 'read' && s.function.name === 'write_file'));

  const runId = runs.newRunId();
  const record = {
    id: runId, reqId: o.reqId, at: new Date().toISOString(),
    instruction: o.instruction, mode, steps: [], changed: [],
    finalReply: null, retries: 0, status: 'running',
  };
  runs.append(record);

  let runEpoch = 0;
  const isStale = () => runEpoch !== 0;

  // 流式管线（节拍+进展剥离）；[进展:] 行进 run 台账并推 agent:step
  const pipeline = makeStreamPipeline('roleplay', o.reqId, {
    withProgress: true,
    onProgress: (item) => step({ kind: 'progress', phase: item.phase, text: item.text }),
  });

  let tracer = null;
  let executedTools = 0, executedWrites = 0, writeDenials = 0, progressSeen = 0;
  let firstRoundRequestedTools = false, retries = 0, lengthRetries = 0;
  const denyStreak = new Map(); // 归一化路径 -> 连续拒绝次数

  const pushArtifact = (changed) => push('agent:artifact', { tab: 'roleplay', reqId: o.reqId, changed });
  const step = (s) => {
    if (isStale()) return;
    record.steps.push(s);
    push('agent:step', { tab: 'roleplay', reqId: o.reqId, ...s });
  };

  // 打断：固定顺序——先停源头、再排干下游（顺序颠倒会让旧流在排干后继续入队）
  const abort = () => {
    if (runEpoch !== 0) return;
    llm.stop(o.reqId);             // 1. 中止当前 LLM 流
    runEpoch = 1;                  // 2. 世代号+1：此后一切异步回调结果作废
    permissions.denyAllStopped();  // 3. 未决权限请求全部按 deny 结束（卡片转「已停止」）
    let changes = [];              // 4. 诚实收尾：停止前已实际发生的写入如实列出
    if (tracer) {
      const r = tracer.finalizeRun();
      changes = r.changed;
      record.changed = changes;
      pushArtifact(changes);
    }
    record.status = 'aborted';     // 5. run 收尾广播
    runs.update(record);
    push('agent:done', { tab: 'roleplay', reqId: o.reqId, runId, aborted: true, changes });
    o.onAborted({ runId, changes });
    activeRuns.delete(o.reqId);
  };
  activeRuns.set(o.reqId, abort);

  // 单轮 LLM 调用：决策轮（stream+tools，400 时降级非流式）；收尾轮（超上限）不带工具纯流式
  async function callLLM(msgs, { noTools }) {
    const onDelta = (d) => { if (!isStale() && d) pipeline.onDelta(d); };
    if (noTools) {
      const text = await llm.streamChat({ messages: msgs, reqId: o.reqId, onChunk: onDelta });
      return { content: text, toolCalls: [], finishReason: 'stop' };
    }
    if (!llm.isToolsStreamBroken()) {
      try {
        return await llm.streamChat({
          messages: msgs, reqId: o.reqId, withTools: true,
          overrides: { tools: schemas, max_tokens: toolMaxTokens }, onChunk: onDelta,
        });
      } catch (e) {
        if (!e.toolsStreamBroken) throw e; // 400 已判定：本 run 起决策轮走非流式
        logger.info('接口不支持 stream+tools，决策轮降级为非流式');
      }
    }
    const res = await llm.genericCompletion(msgs, { tools: schemas, maxTokens: toolMaxTokens });
    if (res.content) onDelta(res.content);
    return res;
  }

  // 执行单个工具调用（权限闸在 invoke 前，由 loop 统一拦截 write；handler 内 fs-guard 保留双保险）
  async function runTool(tc) {
    let args = null;
    try { args = JSON.parse(tc.argsRaw || '{}'); } catch (_) { args = null; }
    const tool = tools.get(tc.name);
    if (!tool) return { ok: false, content: jstr({ ok: false, error: '未知工具: ' + tc.name }) };
    if (!tool.enabled) return { ok: false, content: jstr({ ok: false, error: `工具「${tc.name}」当前处于禁用状态` }) };
    if (!args || typeof args !== 'object') return { ok: false, content: jstr({ ok: false, error: '工具调用格式错误：arguments 不是合法的 JSON 对象' }) };
    // path 仅是文件类工具的必填参数；save_memory 等无 path 工具不受此校验
    if (tool.params && tool.params.path && !String(args.path || '').trim()) return { ok: false, content: jstr({ ok: false, error: '缺少必填参数 path（绝对路径）' }) };

    // run 内首个工具调用：建写区快照基线（纯聊天不快照），宠物转思考表情
    if (!tracer) {
      tracer = traceMod.createTracer();
      tracer.captureBaseline();
      emotion.broadcastEmotion('thinking', { source: 'agent' });
    }

    if (tool.permission === 'write') {
      // 只读模式兜底（正常情况下 write 工具未下发给模型，模型幻觉调用时在这里拦下）
      if (mode === 'read') {
        step({ kind: 'tool', tool: tc.name, summary: args.path + '（只读模式）', ok: false });
        return { ok: false, content: jstr({ ok: false, error: '当前权限模式为只读，写入功能未开启。请告知用户可在聊天窗底部把权限切换为「可编辑」或「完全编辑」。' }) };
      }
      const norm = guard.normalize(args.path);
      // 熔断：同一目标已被连续拒绝 2 次，不再发权限卡
      if ((denyStreak.get(norm) || 0) >= 2) {
        step({ kind: 'tool', tool: tc.name, summary: args.path + '（熔断）', ok: false });
        return { ok: false, content: jstr({ ok: false, error: DENY_BREAK_MSG }) };
      }
      // full 模式才走逐次权限卡；userData 模式 = 用户已通过模式选择授权数据目录内写入
      if (mode === 'full') {
        const bytes = Buffer.byteLength(String(args.content ?? ''), 'utf8');
        const isAppend = args.append === true || String(args.append).toLowerCase() === 'true';
        let exists = false;
        try { exists = fs.existsSync(args.path); } catch (_) {}
        const pr = await permissions.request({
          runId, reqId: o.reqId, tool: tc.name,
          action: exists ? (isAppend ? '追加文件' : '覆盖文件') : '新建文件',
          scopePaths: [args.path],
          detail: `${path.basename(String(args.path))}，${bytes} 字节，${exists ? (isAppend ? '追加到已有文件末尾' : '覆盖已有文件') : '新建'}`,
          reason: args.reason,
          reversibility: exists ? (isAppend ? '在已有文件末尾追加（diff 卡可见）' : '覆盖已有文件（原内容不自动保留，diff 卡可见）') : 'temp 内新建（可删）',
          timeoutSec: permTimeout,
        });
        if (isStale()) return { ok: false, content: '' }; // abort 路径已收尾，上层检查后静默退出
        step({ kind: 'permission', requestId: pr.id, decision: pr.decision });
        if (pr.decision !== 'allow_once') {
          writeDenials++;
          denyStreak.set(norm, (denyStreak.get(norm) || 0) + 1);
          const why = pr.decision === 'timeout' ? '权限卡超时未响应，按拒绝处理' : pr.decision === 'stopped' ? '任务被停止' : '用户点击了拒绝';
          step({ kind: 'tool', tool: tc.name, summary: args.path + '（已拒绝）', ok: false });
          return { ok: false, content: jstr({ ok: false, error: `用户拒绝了这次写入（${why}）。请调整方案或向用户说明。` }), breakHint: (denyStreak.get(norm) || 0) >= 2 };
        }
        denyStreak.delete(norm); // 连续拒绝被打断，重新计数
      }
    }

    let result, ok = true;
    try {
      if (tool.permission === 'write') tracer.captureBeforeWrite(args.path);
      result = await tools.invoke(tc.name, args);
      if (tool.permission === 'write') { tracer.recordToolWrite(args.path); executedWrites++; }
      executedTools++;
    } catch (e) {
      ok = false;
      result = { ok: false, error: e.userMsg || e.message };
      logger.warn('agent 工具执行失败: ' + tc.name + ' → ' + (e.userMsg || e.message));
    }
    const summary = tool.permission === 'write'
      ? `${args.path}（${Buffer.byteLength(String(args.content ?? ''), 'utf8')}B）`
      : String(args.path || Object.values(args).find(v => typeof v === 'string' && v.trim()) || tc.name).slice(0, 60);
    step({ kind: 'tool', tool: tc.name, summary, ok });
    return { ok, content: jstr(result, tools.RESULT_CAPS[tc.name] || 4000) };
  }

  // 正常收尾：差分归因 → 最终回复存史 → run 记录 → llm:done
  async function finishRun(finalContent) {
    const fl = pipeline.flush(); // {clean, beats, emotion, schedule}
    let changes = [];
    if (tracer) {
      const r = tracer.finalizeRun();
      changes = r.changed;
      record.changed = changes;
      pushArtifact(changes);
    }
    // 幻觉兜底：重试预算耗尽后正文仍声称已写入，而本 run 零成功写入零变更 →
    // 附加系统核实说明一起存史/送达，绝不让「假完成」单独流向用户
    if (mode !== 'read' && executedWrites === 0 && changes.length === 0 && claimsWrite(fl.clean)) {
      fl.clean += '\n\n（系统核实：本次任务没有实际写入任何文件，上文关于已写入的表述与事实不符。）';
    }
    const extra = await o.onFinal(fl);
    record.finalReply = fl.clean;
    // 全部写尝试均被拒且无任何成功写入 → denied；否则 done
    record.status = (writeDenials > 0 && executedWrites === 0 && changes.length === 0) ? 'denied' : 'done';
    runs.update(record);
    push('agent:done', { tab: 'roleplay', reqId: o.reqId, runId, aborted: false, changes });
    o.onDone({ ...fl, runId, changes, ...extra });
  }

  try {
    const toolTurns = []; // 本 run 累积的中间轮消息（不进对话历史）
    let rounds = 0, capNoted = false;

    while (true) {
      if (isStale()) return;
      rounds++;
      const overCap = rounds > maxRounds;
      if (overCap && !capNoted) { capNoted = true; toolTurns.push({ role: 'system', content: CAP_MSG }); }

      const res = await callLLM([...o.baseMessages, ...toolTurns], { noTools: overCap });
      if (isStale()) return;

      step({ kind: 'llm', round: rounds, finishReason: res.finishReason });
      progressSeen += ((res.content || '').match(PROG_COUNT_RE) || []).length;

      const wantsTools = res.finishReason === 'tool_calls' && Array.isArray(res.toolCalls) && res.toolCalls.length > 0;
      if (rounds === 1 && wantsTools) firstRoundRequestedTools = true;

      if (!wantsTools) {
        // 截断轮：工具仍可用时 finishReason=length = 输出被 max_tokens 腰斩（工具调用多半只发了一半）。
        // 这轮正文是任务中途叙述而非最终答复（实测出现过「我把文档写进数据目录根」后调用作废、
        // 用户被误导以为已写入）——丢弃重出，有界 2 次。
        if (res.finishReason === 'length' && !overCap && lengthRetries < 2) {
          lengthRetries++;
          record.lengthRetries = lengthRetries;
          step({ kind: 'notice', notice: 'length_retry', text: `输出被 max_tokens 截断，工具调用未执行，重试（${lengthRetries}/2）` });
          pipeline.reset();
          toolTurns.push({ role: 'assistant', content: res.content || '' }, { role: 'system', content: LENGTH_MSG });
          continue;
        }

        // 假完成检测：任务型判定（首轮请求过工具或正文含进展标记）却零工具执行 → 一次有界重试。
        // 声称已写入检测：正文声称完成写入但零成功写入（含只跑过读工具的情况）→ 共用同一次重试预算。
        // 写入曾被用户拒绝的情况不算（用户已介入，模型知情），避免无意义重试。
        const taskLike = firstRoundRequestedTools || progressSeen > 0;
        const fakeClaim = mode !== 'read' && executedWrites === 0 && claimsWrite(res.content);
        if (((taskLike && executedTools === 0) || fakeClaim) && writeDenials === 0 && retries === 0 && !overCap) {
          retries = 1; record.retries = 1;
          step({ kind: 'notice', notice: 'retry', text: fakeClaim ? '检测到声称已写入但没有成功写入记录，自动重试一轮（1/1）' : '检测到未执行工具即声称完成，自动重试一轮（1/1）' });
          pipeline.reset(); // 管线与渲染层正文同步清空，重试轮从零开始
          toolTurns.push({ role: 'assistant', content: res.content || '' }, { role: 'system', content: fakeClaim ? CLAIM_MSG : FAKE_DONE_MSG });
          continue;
        }
        return await finishRun(res.content);
      }

      // 工具轮：assistant tool_calls + 逐个执行回填 tool results（id 缺失时生成并两侧一致）
      const calls = res.toolCalls.map((tc, i) => ({ tc, id: tc.id || `call_${runId}_${i}` }));
      toolTurns.push({
        role: 'assistant',
        content: res.content || '',
        tool_calls: calls.map(({ tc, id }) => ({
          id, type: 'function',
          function: { name: tc.name, arguments: tc.argsRaw || '{}' },
        })),
      });
      let needBreakMsg = false;
      for (const { tc, id } of calls) {
        if (isStale()) return;
        const out = await runTool(tc);
        if (isStale()) return;
        toolTurns.push({ role: 'tool', tool_call_id: id, content: out.content });
        if (out.breakHint) needBreakMsg = true;
      }
      if (needBreakMsg) toolTurns.push({ role: 'system', content: DENY_BREAK_MSG });
    }
  } catch (e) {
    if (isStale()) return; // abort 已收尾
    logger.error(e);
    record.status = 'error';
    record.error = e.userMsg || e.message;
    runs.update(record);
    o.onError(e);
  } finally {
    activeRuns.delete(o.reqId);
  }
}

function abortRun(reqId) {
  const abort = activeRuns.get(reqId);
  if (abort) abort();
}

function hasRun(reqId) { return activeRuns.has(reqId); }

module.exports = { startRun, abortRun, hasRun };
