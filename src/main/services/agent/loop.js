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
const markers = require('./markers');
const { createUsageMeter } = require('../token-est');
const { makeStreamPipeline } = require('../stream-pipeline');
const { compactTurns, estTurns } = require('./ctx-compact');

const CAP_MSG = '已达执行轮次上限。请不要再调用工具，基于现有结果直接给出最终答复。';
// 共识条款（dev.4）：纠正指令只修正「伪造」，绝不覆盖用户否决权——实测事故：用户拒绝后纠正指令
// 命令模型「立即实际调用 list_dir/read_file」，模型服从注入扫了 14 个目录。误判场景下必须收工具。
const CONSENT_NOTE = '\n补充判定：若用户本轮消息其实是在拒绝或暂缓该操作（如「还是不了」「不用了」「先不用」），或只是引用既往轮次的成果，那么所谓「声称」是引用而非伪造——此时请立即停止：不要再调用任何工具（包括以「验证/盘点/顺手确认」为名的读取），直接给出符合角色设定的自然最终答复。';
const FAKE_DONE_MSG = '上一轮你没有调用任何工具就声称完成了任务。若任务确需读写文件，请调用工具执行；若确实无需工具，直接给出最终答复。' + CONSENT_NOTE;
const DENY_BREAK_MSG = '用户已两次拒绝同一写入目标，停止再次尝试该目标。';
const LENGTH_MSG = '上一轮输出因达到 max_tokens 上限被截断，末尾的工具调用没有执行、任务未完成。请重新来：正文从简（≤100字），直接调用工具；写入大文件必须分段——先 write_file 写第一段（≤3000字），后续各段用参数 append:"true" 追加。';
const CLAIM_MSG = '上一轮你声称已写入文件，但本次任务没有任何成功的 write_file 调用，该文件实际并不存在。请立即实际调用 write_file 完成写入（大文件分段：先写第一段，再以 append:"true" 逐段追加）；若确实无法写入，必须如实告知用户并说明原因，绝不允许声称已写入未写入的文件。' + CONSENT_NOTE;
const READ_CLAIM_MSG = '上一轮你声称已读取了文件内容，但本次任务没有任何成功的 read_file 调用，那些「读到的内容」全部是编造的。请立即实际调用 list_dir 列目录、再逐份调用 read_file 读取（多文件就多轮调用，不要用「继续读」等叙述代替实际调用，大文件带 offset 逐段读完）；确实无法读取时如实说明，绝不允许编造读取结果。' + CONSENT_NOTE;
const SEARCH_CLAIM_MSG = '上一轮你声称已完成联网检索（如「我查了/网上的资料说/检索结果显示」），但本次任务没有任何成功的 web_search 调用，那些内容全部是编造的。请实际调用 web_search 执行检索（联网搜索未开启时，用户明确要求的检索首次调用会弹授权卡）；确实无法检索时如实说明原因，绝不允许编造检索结果或来源。' + CONSENT_NOTE;
const PROG_COUNT_RE = /\[进展[:：]\s*(?:设计|发现|能力|验证)/g;

// 「声称已写入」检测：完成态标记（已/已经/…了）+ 写入动词（含「落盘/写完/交付」——
// 实测模型会用「笔录落盘了」「交付完成」汇报未发生的写入），且上下文有文件线索。
// 文件线索可挡掉角色扮演剧情里的虚构表述（如「把信写好了」）误触发。
// 「已/已经」到动词之间的桥不允许跨逗号/顿号/冒号（冒号同属子句边界，dev.5+3 补）、
// 桥内出现否定措辞即断（dev.5+1 事故
// run_mul91laf_3：角色声明「已归档，不进任何交付物……不写任何文件」，旧桥跨逗号把
// 「已归档，不进任何交付物」读成「已…交付」→ 遵守纪律反被判伪造）。否定在动词之后
// 不影响真声明命中（「已写入，不会保留副本」仍抓）。
// 职责边界（P0-1 回执化后收窄）：传输层事实（截断/断开/未执行的半截调用）已由
// markers.js 的显式回执陈述——本词表只兜内容层：拦「对用户的口头谎称」（说了
// 「写好了」而全 run 零成功写入），不再承担传输层事实的推断。
const CLAIM_GAP_NEG = '(?:(?!(?:不会?|没有?|未|无法|无需|无须|不必|绝不?|禁止|不许|不可以|不能|不得|不要))[^，。！？：:，、\\n])';
const WRITE_CLAIM_RE = new RegExp('(已经|已)' + CLAIM_GAP_NEG + '{0,16}(写入|写好|保存|建好|创建|生成|写进|存进|存到|写到|落盘|写完|交付)|(写入|写好|保存|建好|创建|生成|落盘|写完|交付)了|(写入|保存|落盘|写完|交付|创建|生成)完成');
const FILE_HINT_RE = /\.(md|txt|json|csv|log|ya?ml|html?|js|ts|py|docx?|xlsx?|pptx?)\b|写入|文件|文档|数据目录|路径|[a-z]:[/\\]/i;

// 「声称已读取」检测（实测 run19/21：模型零工具调用却叙述「先列目录…继续读×6…我读完了」）。
// 线索闸比写入宽：回复或用户指令里出现 文件/记录/报告/笔记/目录/路径 即可——
// 角色扮演里「读完」的虚构对象通常是信/书等，线索闸兜住误报。桥规则与写入侧同。
const READ_CLAIM_RE = new RegExp('读完|看完|读过了|看过了|通读|读取完成|浏览了|(已经|已)' + CLAIM_GAP_NEG + '{0,10}(读|看|浏览|检索|核对|查看)');
const FILE_CTX_RE = /\.(md|txt|json|csv|log|ya?ml|html?|js|ts|py|docx?|xlsx?|pptx?)\b|文件|文档|记录|报告|笔记|目录|文件夹|数据目录|路径|[a-z]:[/\\]/i;

// 「声称已检索」检测（spec §14 SEARCH_CLAIM 守卫，v0.3.5 虚假读取守卫的同构扩展）：
// 完成态/来源引用措辞 + 用户指令含检索意图（意图闸挡掉角色扮演剧情里随口提到「网上」的误触发），
// 且本 run 零成功 web_search → 有界重试 + 兜底注记。词表上线前须按 v0.3.5 实测校准法回灌验证。
const SEARCH_CLAIM_RE = /搜过了|查过了|查了一下|检索完毕|网上的(资料|说法|信息)|根据(网络)?检索|搜索结果(显示|表明|来看)|我刚查了|查了下?资料/;
const SEARCH_INTENT_RE = /查|搜|检索|搜索|网上|网络|新闻|最新|最近.{0,6}(消息|进展|动态)|官方(文档|说明)/;

// ---- 戏内/戏外通道协议（dev.5 系列五起误判后的机制级收口，用户决策 2026-09-29）----
// 词表式守卫只能认「第一人称+肯定完成态」一种语用，引用/拒绝/约束/否定/第三者转述都会
// 误判（五起事故同根：从措辞推断语用是开放集合）。收口：通道由显式标记划分，不再推断——
// 用户消息行首打标 /order、/指令：、/命令： = 戏外工作轮（工具全量下发、claim 守卫武装）；
// 未打标一律视为戏内角色扮演：文件类工具不下发（结构性不触发动作），守卫无条件放行，
// 仅保留 web_search（授权卡照旧）与 save_memory（角色自身认知通道）。
// 标记只认用户消息行首：正文/工具结果/历史里出现的 /order 一律是普通文本（防内容注入）。
const WORK_CHANNEL_RE = /^\s*\/(?:order|指令|命令)\s*[:：]?/i;
function channelOf(instruction) {
  return WORK_CHANNEL_RE.test(String(instruction || '')) ? 'work' : 'roleplay';
}
// 戏内轮仅存的工具：web_search（授权卡照旧）+ save_memory（角色自身认知通道）
const ROLEPLAY_TOOLS = ['web_search', 'save_memory'];

// ---- 跨轮引用豁免（v0.4.0-dev.3 事故修正：任务完成后的闲聊轮被守卫误判 → 角色无法回戏）----
// 实测事故链：对话历史只存 clean 回复、不存工具凭据 → 用户表扬轮里角色引用上一轮真实成果
// → 守卫只看本轮计数（executedXxx===0）误判「全部是编造的」→ 模型相信自己的真实记忆是幻觉
// → 反复重查重做、每条新消息再次引用再次误判 → 自我审计死循环。
// 三层闸（全部满足才判伪造）：
//   ① 任务性：本轮指令确实布置了任务（能力名词如「MCP搜索能力」先剥离——谈论工具≠布置任务）；
//   ② 完成态句不带过去指涉（「上一轮/刚才/那份报告」= 对既往 run 真实成果的引用，结构性零执行）；
//   ③ 既有词表与文件/意图线索闸不变。
//
// v0.4.0-dev.4 加固（实测事故：用户明确拒绝「还是不了……阅读整个项目并不适合你」，守卫仍开火，
// 纠正指令命令模型「立即实际调用 list_dir/read_file」→ 模型服从注入、违背用户否决权，扫了 14 个目录）：
//   ④ 任务性正则收紧——裸字动词（读/写/查）与泛化动词（整理/生成/总结/列出）从判定中移除，
//     只认 请求帧（帮我/请/给我 + 动词）、复合动词（写入/读取/创建/保存/检索…）与 文件锚（路径/扩展名/数据目录）；
//   ⑤ 拒绝闸——指令含明确拒绝/暂缓措辞（还是不了/不用了/先不用/不适合你…）时一律不算任务
//     （宁漏勿滥：漏判的代价只是少一次重试，误判的代价是守卫命令模型违背用户意愿）；
//   ⑥ 引号内提及不算声明——「档案记『已落盘』」是对台账的转述，剥离引号内容后再做完成态核对。
// 能力名词剥离（dev.3）：谈论工具≠布置任务。dev.5+2 扩展：读取/写入/读写 + 权限也是
// 能力名词（实测 run_mulmo919_2「你们拥有同样的本地文件读取权限」——叙述权限面≠布置读任务）
const CAPABILITY_MENTION_RE = /(搜索|检索|查询|联网|读取|写入|读写)(能力|功能|水平|接口|模块|通道|权限)/g;
const TASK_REQ_RE = new RegExp([
  '帮我.{0,12}(读|写出?|写入|查|搜|找|看|弄|做|整理|列出?|建|保存|总结|翻译|提取|统计|生成|回读|核验|校验|检索|落盘)',
  '请[^，。！？]{0,10}(读|写|建|保存|整理|列出?|搜索|检索|查|总结|翻译|校验|核验)',
  '给我(读|写|列出?|整理|总结|检索|生成|找|看)',
  '(写入|写进|存进|存到|写到|落盘|追加|覆盖|读取|列出|列目录|建一个|新建|创建|回读|核验|校验|保存|看一下|看下|看一眼|总结一下|整理一下|核对一下|归纳一下|浏览一下)',
  '(查一下|查下|查查|搜一下|搜下|搜搜|搜索|检索)',
  '(数据目录|文件夹|目录|[a-z]:[\\\\/]|\\.(md|txt|json|csv|log|ya?ml|html?|js|ts|py|docx?|xlsx?|pptx)\\b)',
].join('|'), 'i');
// 拒绝/暂缓措辞：命中即不算任务（守卫与纠正指令一并失效——被拒绝的操作不存在「伪造未做」）
const REFUSAL_RE = /还是不(要|用|行)?了|不用了|不要了|先不用|暂时不(用|要)|不必了?|就算了|算了吧|别读|别扫|不适合你|并不适合|就先不/;
const PAST_REF_RE = /上一?[轮流次条步骤回]|刚才|刚刚|此前|之前|上次|先前|早些|那份|那次|那条报告/;
// 禁止帧剥离（dev.5 实测事故 run_muig591s_1）：画像任务附带约束「不可以读取本地文件」，
// TASK_REQ_RE 命中禁句里的复合动词「读取」→ 纯内部任务被判成文件任务；角色自述「已检索的
// 记忆档案」——真话，记忆/user profile 本就注入在上下文里，无需读盘——随即被 READ_CLAIM
// 误判，守卫强迫角色自证清白，纠错答辩顶替画像成为最终回复。禁句是约束不是布置：
// 判任务性与文件/意图线索前先剥掉禁句（连同本句内尾注）；约束与真任务并存时真任务保留
// （帮我…写入，但不可以读 X）。「不能」排除「能不能/是不能」，「不得」排除「不得不」；
// 「别」因「特别/识别」类词误剥风险不收（别读/别扫已由拒绝闸兜住）。
function stripProhibitions(inst) {
  return String(inst || '').replace(
    /(?:(?<![能是])不能|不可以|不许|不允许|(?<![得])不得|禁止|不要)[^，。！？；\n]{0,16}/g,
    '',
  );
}
function instructionIsTask(instruction) {
  const inst = String(instruction || '');
  if (REFUSAL_RE.test(inst)) return false; // 拒绝闸优先于一切任务信号（dev.4 ⑥）
  return TASK_REQ_RE.test(stripProhibitions(inst).replace(CAPABILITY_MENTION_RE, ''));
}
// 第三者叙述豁免（dev.5+2 实测事故 run_mulmo919_2）：句子在描述他人/竞品的工作方式
// （「它是后验打法：读完所有代码」），完成态动词的主语是第三者——描述≠本轮自述。
// 逐逗号/冒号子句追踪主语：命中子句继承最近的显式主语；主语为第三者且其间无第一人称
// 介入 → 该命中放行；同句混入第一人称自述（「它是后验打法，我已读完台账」）仍命中。
const THIRD_SUBJ_RE = /^\s*(?:它|他|她|它们|他们|对方|对手|那位|那个代理|这个代理|该代理|Zcode|编程代理)/;
const THIRD_IS_RE = /(?:它是|他是|她是|它们是|对方是|对手是)/;
const FIRST_PERSON_RE = /我|咱|俺|本人/;
function thirdPersonContext(sentence, matchIndex) {
  const bounds = [];
  let last = 0;
  for (const m of sentence.matchAll(/[，,、：:]/g)) { bounds.push([last, m.index]); last = m.index + 1; }
  bounds.push([last, sentence.length]);
  let subj = null;
  for (const [a, b] of bounds) {
    if (a > matchIndex) break;
    const c = sentence.slice(a, b);
    if (FIRST_PERSON_RE.test(c)) subj = 'first';
    else if (subj === null && (THIRD_SUBJ_RE.test(c) || THIRD_IS_RE.test(c))) subj = 'third';
    if (matchIndex < b) break;
  }
  return subj === 'third';
}
// 完成态词素按句核对：只要存在「无过去指涉的完成态句」即视为本轮伪造声明；
// 全部带过去指涉 = 对既往工作的引用，放行。引号内内容先剥离（提及≠声明，dev.4）；
// 全部命中落在第三者语境的句子放行（dev.5+2）。
// claimSentences 同时供台账留痕（dev.5）：误判事后校准需要命中原句
function claimSentences(text, claimRe) {
  return String(text || '').split(/[\n。！？；]/).filter(s => {
    // 引号字形族全收（dev.5+3 实测事故 run_muohkej9_5，首个工作轮误判）：dev.4 引号豁免只认
    // 直角「」，角色实测会用英文 "分卷交付"——引号内「交付」被桥接成写入声称，答辩轮顶替
    // 了整段女娲讨论。提及≠声明与字形无关：直角/弯双/弯单/直双四族统一剥离。
    const bare = s.replace(/[「『][^」』]*[」』]|“[^”]*”|‘[^’]*’|"[^"]*"/g, '');
    if (!claimRe.test(bare) || PAST_REF_RE.test(s)) return false;
    const gre = new RegExp(claimRe.source, 'g');
    let m;
    while ((m = gre.exec(bare))) {
      if (!thirdPersonContext(bare, m.index)) return true; // 存在非第三者语境的完成态命中 → 声明
    }
    return false; // 全部命中都是第三者叙述 → 放行
  }).map(s => s.slice(0, 160));
}
function hasUnanchoredClaim(text, claimRe) {
  return claimSentences(text, claimRe).length > 0;
}
function claimsWrite(text, instruction) {
  const t = String(text || '');
  return instructionIsTask(instruction) && WRITE_CLAIM_RE.test(t)
    && FILE_HINT_RE.test(t + '\n' + stripProhibitions(instruction))
    && hasUnanchoredClaim(t, WRITE_CLAIM_RE);
}
function claimsRead(text, instruction) {
  const t = String(text || '');
  return instructionIsTask(instruction) && READ_CLAIM_RE.test(t)
    && FILE_CTX_RE.test(t + '\n' + stripProhibitions(instruction))
    && hasUnanchoredClaim(t, READ_CLAIM_RE);
}
function claimsSearch(text, instruction) {
  const t = String(text || '');
  return instructionIsTask(instruction) && SEARCH_CLAIM_RE.test(t)
    && SEARCH_INTENT_RE.test(stripProhibitions(instruction))
    && hasUnanchoredClaim(t, SEARCH_CLAIM_RE);
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
//   onFinal(fl, x)  —— 最终回复（管线 flush 结果），chat.js 存史/广播/记忆；x.usage=本轮 API 消耗合计；返回 llm:done 附加载荷（如 msgId）
//   onDone(payload) —— 发 llm:done（payload 含 fl + runId + changes + usage）
//   onAborted(x)    —— 发 llm:done aborted
//   onError(e)      —— 发 llm:error
//   onUsage(u)      —— 首个基础轮（无 toolTurns）的上游用量回调（chat.js 锚点法计量落锚，P0-2）
//   onContextOverflow() —— 上下文溢出压缩前的记忆固化钩子（chat.js flushMemory，P0-4）
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
  // 通道（戏内/戏外）：见 channelOf。戏内轮结构性收权——文件类工具不下发，只有 web_search + save_memory
  const channel = channelOf(o.instruction);
  let schemas = tools.openAiSchemas().filter(s => !(mode === 'read' && s.function.name === 'write_file'));
  if (channel !== 'work') schemas = schemas.filter(s => ROLEPLAY_TOOLS.includes(s.function.name));

  const runId = runs.newRunId();
  const record = {
    id: runId, reqId: o.reqId, at: new Date().toISOString(),
    instruction: o.instruction, mode, channel, steps: [], changed: [],
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
  let executedTools = 0, executedWrites = 0, executedReads = 0, executedSearches = 0, writeDenials = 0, progressSeen = 0;
  let firstRoundRequestedTools = false, retries = 0, lengthRetries = 0;
  const denyStreak = new Map(); // 归一化路径 -> 连续拒绝次数
  const toolTurns = []; // 本 run 累积的中间轮消息（不进对话历史；pushTruncatedTurn 也要写它）
  // 工具轮滚动压缩（平方税）：预算从 settings.agent.toolCtxTokenBudget 读（est-token 口径）；
  // receipts/meta 用 WeakSet/WeakMap 承载——标记不进消息体，发往 API 的字段零污染
  const toolCtxBudget = clampNum(agentCfg.toolCtxTokenBudget, 8000, 150000, 40000);
  const compReceipts = new WeakSet();
  const toolMeta = new WeakMap();
  let compactNoted = false;
  const compactOldTurns = () => {
    // watermark：最后一个带 tool_calls 的 assistant 起不压缩——那是最新一轮，模型正基于它工作
    let watermark = toolTurns.length;
    for (let i = toolTurns.length - 1; i >= 0; i--) {
      if (toolTurns[i].role === 'assistant' && Array.isArray(toolTurns[i].tool_calls)) { watermark = i; break; }
    }
    const n = compactTurns(toolTurns, {
      budget: toolCtxBudget, watermark,
      isReceipt: (m) => compReceipts.has(m),
      markReceipt: (m) => compReceipts.add(m),
      metaOf: (m) => toolMeta.get(m),
    });
    if (n > 0 && !compactNoted) {
      compactNoted = true;
      step({ kind: 'notice', notice: 'ctx_compact', text: `工具上下文超出预算（${toolCtxBudget} est-token），最老的工具结果已压缩为回执（需要时可重读）` });
    }
    return n;
  };

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
  // captureUsage：仅首个基础轮（rounds===1 且 toolTurns 空）为真——该轮请求恰为
  // baseMessages 本体，其 prompt_tokens 才能作为 chat.js 锚点（混入 toolTurns 的
  // 用量会把工具上下文计入锚点，导致下轮容量高估）。
  // turnMeter：每一次请求的用量都进聚合器（本轮 API 消耗外显用，与锚点口径分离）
  const turnMeter = createUsageMeter();
  async function callLLM(msgs, { noTools, captureUsage }) {
    const onDelta = (d) => { if (!isStale() && d) pipeline.onDelta(d); };
    const onUsage = (u) => {
      try { turnMeter.add(u); } catch (_) {}
      if (captureUsage && o.onUsage) { try { o.onUsage(u); } catch (_) {} }
    };
    // 思考期反馈：思考模式被服务商强制开启后，决策轮开头可能长时间只有推理流、
    // 上屏零输出——宠物此刻切思考表情，避免「没反应」的卡死观感（每轮至多一次）
    let thinkingNoted = false;
    const onReasoning = () => {
      if (!thinkingNoted && !isStale()) { thinkingNoted = true; emotion.broadcastEmotion('thinking', { source: 'agent' }); }
    };
    if (noTools) {
      // 收尾轮同样全程思考（v0.3.7 用户决策）：历史中带 tool_calls 的 assistant 消息
      // 已按 v0.3.6 回传 reasoning_content，思考模式下服务端校验可过
      const text = await llm.streamChat({ messages: msgs, reqId: o.reqId, onChunk: onDelta, onReasoning, onUsage });
      return { content: text, toolCalls: [], finishReason: 'stop', reasoning: '' };
    }
    if (!llm.isToolsStreamBroken()) {
      try {
        return await llm.streamChat({
          messages: msgs, reqId: o.reqId, withTools: true,
          overrides: { tools: schemas, max_tokens: toolMaxTokens }, onChunk: onDelta, onReasoning, onUsage,
        });
      } catch (e) {
        if (!e.toolsStreamBroken) throw e; // 400 已判定：本 run 起决策轮走非流式
        logger.info('接口不支持 stream+tools，决策轮降级为非流式');
      }
    }
    const res = await llm.genericCompletion(msgs, { tools: schemas, maxTokens: toolMaxTokens, onUsage });
    if (res.content) onDelta(res.content);
    return res;
  }

  // DeepSeek 思考模式协议约束（v0.3.6 实测 + 20261002 run_mupxfru8_1 二次实测）：
  // 请求中「最后一条 user 之后」的 assistant 消息缺失 reasoning_content → 接口 400。
  // 流中断/首响应超时产生的半截轮 res.reasoning 可能为空——deepseek 端点垫一个
  // 非空白占位符（服务端只验存在性；Cortico 对同类端点约束用 SYNTHETIC_REASONING_TEXT
  // '-' 的通用解），非 deepseek 端点不垫（避免向其他供应商发送多余字段）。
  function reasoningPassback(res) {
    if (res && res.reasoning && String(res.reasoning).trim()) return res.reasoning;
    try { return llm.isDeepseek((llm.getConfig() || {}).model) ? '-' : ''; } catch (_) { return ''; }
  }
  // 半截轮是否「零字节」：什么都没生成（无正文/无思考/无调用）——没有可保留的东西，
  // 推一条空 assistant 反而制造协议非法消息（思考模式 400 根因）
  function isZeroByteTurn(res) {
    return !String((res && res.content) || '').trim()
      && !String((res && res.reasoning) || '').trim()
      && !(Array.isArray(res && res.toolCalls) && res.toolCalls.length > 0);
  }

  // 半截轮的诚实回填（P0-1，借鉴 Cortico NOT_EXECUTED_* 家族）：assistant 原样进
  // 历史（含半截 tool_calls），每个未执行调用配一条 markers.notExecutedReceipt 的
  // tool 回执——配对永不悬空，模型看得见「发过但没执行、参数不可信」，不再靠
  // 猜。用于 streamCut 续跑与 length 截断重试两条路径。
  // 零字节轮只推续跑指令不推 assistant（无物可留）；半截调用中名字未流出的整条
  // 丢弃（空 name 的 tool_call 同样过不了服务端校验）。
  function pushTruncatedTurn(res, kind, sysMsg) {
    if (!isZeroByteTurn(res)) {
      const validCalls = (res.toolCalls || [])
        .map((tc, i) => ({ tc, id: tc.id || `call_${runId}_t${i}` }))
        .filter(x => String(x.tc.name || '').trim());
      toolTurns.push({
        role: 'assistant',
        content: res.content || '',
        ...(reasoningPassback(res) ? { reasoning_content: reasoningPassback(res) } : {}),
        ...(validCalls.length ? {
          tool_calls: validCalls.map(({ tc, id }) => ({
            id, type: 'function',
            function: { name: tc.name, arguments: tc.argsRaw || '{}' },
          })),
        } : {}),
      });
      for (const { tc, id } of validCalls) {
        toolTurns.push({ role: 'tool', tool_call_id: id, content: markers.notExecutedReceipt(kind) });
      }
    }
    toolTurns.push({ role: 'system', content: sysMsg });
  }

  // 执行单个工具调用（权限闸在 invoke 前，由 loop 统一拦截 write；handler 内 fs-guard 保留双保险）
  async function runTool(tc) {
    let args = null;
    try { args = JSON.parse(tc.argsRaw || '{}'); } catch (_) { args = null; }
    const tool = tools.get(tc.name);
    if (!tool) return { ok: false, content: jstr({ ok: false, error: '未知工具: ' + tc.name }) };
    if (!tool.enabled) return { ok: false, content: jstr({ ok: false, error: `工具「${tc.name}」当前处于禁用状态` }) };
    // 通道闸执行层兜底：戏内轮不下发 schema 是第一道；服务商异常/注入返回越权工具调用时，
    // 这里第二道拒绝执行——结构性收权不依赖模型自觉
    if (channel !== 'work' && !ROLEPLAY_TOOLS.includes(tc.name)) {
      step({ kind: 'tool', tool: tc.name, summary: (args && args.path ? args.path + ' ' : '') + '（戏内轮通道收权）', ok: false });
      return { ok: false, content: jstr({ ok: false, error: '本轮为戏内角色扮演（消息未以 /order、/指令：或 /命令： 打标），文件类工具不可用；工作指令请打标后下达' }) };
    }
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
      // ctx：web_search 出口层需要 runId/reqId 关联台账、instruction 做轨道存疑启发式、
      // step 发「已开启/达日限」notice、permTimeout 授权卡超时（spec D3/§5.2）
      result = await tools.invoke(tc.name, args, { runId, reqId: o.reqId, instruction: o.instruction, permTimeoutSec: permTimeout, step });
      if (tool.permission === 'write') { tracer.recordToolWrite(args.path); executedWrites++; }
      executedTools++;
    } catch (e) {
      ok = false;
      result = { ok: false, error: e.userMsg || e.message };
      logger.warn('agent 工具执行失败: ' + tc.name + ' → ' + (e.userMsg || e.message));
    }
    if (ok && tc.name === 'read_file') executedReads++;
    // 成功检索 = handler 正常返回且业务 ok（被拦/被拒/失败的调用不算「查过」）
    if (ok && tc.name === 'web_search' && result && result.ok !== false) executedSearches++;
    const summary = tool.permission === 'write'
      ? `${args.path}（${Buffer.byteLength(String(args.content ?? ''), 'utf8')}B）`
      : tc.name === 'web_search'
        ? `${String(args.query || '').slice(0, 40)}（${args.track === 'autonomous' ? '自主轨' : '指定轨'}）`
        : String(args.path || Object.values(args).find(v => typeof v === 'string' && v.trim()) || tc.name).slice(0, 60);
    step({ kind: 'tool', tool: tc.name, summary, ok });
    return { ok, content: jstr(result, tools.RESULT_CAPS[tc.name] || 4000) };
  }

  // 正常收尾：差分归因 → 最终回复存史 → run 记录 → llm:done
  // suffix：诚实收尾附加注记（如断流半截的「可能不完整」），挂在 flush 结果之后
  async function finishRun(finalContent, { suffix = '' } = {}) {
    const fl = pipeline.flush(); // {clean, beats, emotion, schedule}
    if (suffix) fl.clean = fl.clean ? fl.clean + '\n\n' + suffix : suffix;
    record.usage = turnMeter.snapshot(); // 本轮 API 消耗（外显 + 台账）
    let changes = [];
    if (tracer) {
      const r = tracer.finalizeRun();
      changes = r.changed;
      record.changed = changes;
      pushArtifact(changes);
    }
    // 幻觉兜底：重试预算耗尽后正文仍声称已写入/已读取/已检索，而本 run 实际零成功写入/零 read_file/
    // 零成功 web_search → 附加系统核实说明一起存史/送达，绝不让「假完成」单独流向用户
    if (mode !== 'read' && executedWrites === 0 && changes.length === 0 && claimsWrite(fl.clean, o.instruction)) {
      fl.clean += '\n\n（系统核实：本次任务没有实际写入任何文件，上文关于已写入的表述与事实不符。）';
    } else if (executedReads === 0 && claimsRead(fl.clean, o.instruction)) {
      fl.clean += '\n\n（系统核实：本次任务没有实际读取任何文件，上文对所谓文件内容的转述与事实不符，不可采信。）';
    } else if (executedSearches === 0 && claimsSearch(fl.clean, o.instruction)) {
      fl.clean += '\n\n（系统核实：本次对话没有执行任何联网检索，上文关于网络资料/检索结果的表述与事实不符，不可采信。）';
    }
    const extra = await o.onFinal(fl, { usage: record.usage });
    record.finalReply = fl.clean;
    // 全部写尝试均被拒且无任何成功写入 → denied；否则 done
    record.status = (writeDenials > 0 && executedWrites === 0 && changes.length === 0) ? 'denied' : 'done';
    runs.update(record);
    push('agent:done', { tab: 'roleplay', reqId: o.reqId, runId, aborted: false, changes });
    o.onDone({ ...fl, runId, changes, usage: record.usage, ...extra });
  }

  try {
    let rounds = 0, capNoted = false, overflowStage = 0;

    while (true) {
      if (isStale()) return;
      rounds++;
      const overCap = rounds > maxRounds;
      if (overCap && !capNoted) { capNoted = true; toolTurns.push({ role: 'system', content: CAP_MSG }); }

      let res;
      try {
        compactOldTurns(); // 每轮请求前滚动压缩（预算内零动作；超出时最老工具结果→一行回执）
        res = await callLLM([...o.baseMessages, ...toolTurns], {
          noTools: overCap,
          captureUsage: rounds === 1 && toolTurns.length === 0,
        });
      } catch (e) {
        if (isStale()) return;
        // 溢出→交接（P0-4，借鉴 Cortico「溢出不重试、触发交接」）：长会话撞窗口不再
        // 报错死亡。两级压缩：①压 baseMessages（保 system+末轮问答）；②连工具轮上下文
        // 一并清空。压缩前经 onContextOverflow 固化记忆（chat.js flushMemory）。
        if (e && e.contextOverflow && overflowStage < 2) {
          overflowStage++;
          let flushed = false;
          try { if (o.onContextOverflow) { await o.onContextOverflow(); flushed = true; } } catch (_) {}
          step({ kind: 'notice', notice: 'context_overflow', text: `上下文超出模型窗口，第 ${overflowStage} 级压缩后续跑${flushed ? '（已先固化记忆）' : ''}` });
          const base = Array.isArray(o.baseMessages) ? o.baseMessages : [];
          if (overflowStage === 1) {
            o.baseMessages = [
              ...base.slice(0, 1),
              { role: 'system', content: markers.compactedHistoryNote({ memoryFlushed: flushed }) },
              ...base.slice(-2),
            ];
          } else {
            // 二级：工具轮上下文也清空（read_file 大结果撑爆窗口的典型场景）
            toolTurns.length = 0;
          }
          continue;
        }
        throw e;
      }
      if (isStale()) return;

      step({ kind: 'llm', round: rounds, finishReason: res.finishReason });
      progressSeen += ((res.content || '').match(PROG_COUNT_RE) || []).length;

      const wantsTools = res.finishReason === 'tool_calls' && Array.isArray(res.toolCalls) && res.toolCalls.length > 0;
      if (rounds === 1 && wantsTools) firstRoundRequestedTools = true;

      // 断流处理优先于工具执行（P0-3）：streamCut 时 finishReason 是「有无调用」推断
      // 出来的——半截工具调用不可信，不得进入执行分支。
      // committed 判定（借鉴 Cortico「已外化不可重试」）：正文 delta 已推给用户的，
      // 重试=用户看到重复半截、reset=用户看到内容凭空消失（dev.5+3 教训），只能
      // 如实收尾 + 诚实注记；未外化的才有界续跑（与截断重试共享预算）。
      if (res.streamCut) {
        if (!res.committed && !overCap && lengthRetries < 2) {
          lengthRetries++;
          record.lengthRetries = lengthRetries;
          step({ kind: 'notice', notice: 'stream_cut_retry', text: `响应流中途断开，继续任务（${lengthRetries}/2）` });
          pipeline.reset();
          // 零字节轮（首响应超时/连接未及出字）：没有可保留的输出，只推续跑指令——
          // 推空 assistant 会让思考模式 400（run_mupxfru8_1 实测）
          pushTruncatedTurn(res, 'stream_cut', isZeroByteTurn(res)
            ? '上一次请求在输出开始前被中断（未产生任何内容，也没有发起任何工具调用）。请继续执行先前的任务：读文件就调用 read_file（大文件带 offset 续段）、写文件就调用 write_file，完成后给出完整最终答复。'
            : '上一轮的输出在传输中途被断开（内容戛然而止，那不是完整回复）。请继续先前的任务：读文件就继续调用 read_file（大文件带 offset 续段）、写文件就继续 write_file，完成后给出完整最终答复。');
          continue;
        }
        const layer = res.streamError ? res.streamError.layer : 'stream';
        step({ kind: 'notice', notice: 'stream_cut_partial', text: `响应流中途断开且正文已送达（${layer}），如实收尾` });
        return await finishRun(res.content, { suffix: markers.streamPartialNote() });
      }

      if (!wantsTools) {
        // 截断轮：工具仍可用时 finishReason=length = 输出被 max_tokens 腰斩（工具调用多半只发了一半）。
        // 这轮正文是任务中途叙述而非最终答复（实测出现过「我把文档写进数据目录根」后调用作废、
        // 用户被误导以为已写入）——丢弃重出，有界 2 次。半截调用经 pushTruncatedTurn
        // 留 [未执行] 显式回执（P0-1）：模型看得见发过什么、没执行什么。
        if (res.finishReason === 'length' && !overCap && lengthRetries < 2) {
          lengthRetries++;
          record.lengthRetries = lengthRetries;
          step({ kind: 'notice', notice: 'length_retry', text: `输出被 max_tokens 截断，工具调用未执行，重试（${lengthRetries}/2）` });
          pipeline.reset();
          pushTruncatedTurn(res, 'length', LENGTH_MSG);
          continue;
        }

        // 假完成检测：任务型判定（首轮请求过工具或正文含进展标记）却零工具执行 → 一次有界重试。
        // 声称已写入/已读取/已检索检测：正文用完成态汇报写入/读取/检索但实际零成功记录（实测 run19/21：
        // 模型不请求工具、不带进展标记，纯靠叙述「先列目录…继续读…我读完了/笔录落盘了」伪装执行）
        // → 共用同一次重试预算，分别注入针对性纠正指令。
        // 写入曾被用户拒绝的情况不算（用户已介入，模型知情），避免无意义重试。
        const taskLike = firstRoundRequestedTools || progressSeen > 0;
        // 通道闸：守卫只武装戏外工作轮。戏内轮 claim 检测不做、假完成不重试——
        // 无条件放行（伪造检测面收窄到工具真执行、计数有实际意义的轮次）
        const armed = channel === 'work';
        const writeClaim = armed && mode !== 'read' && executedWrites === 0 && claimsWrite(res.content, o.instruction);
        const readClaim = armed && executedReads === 0 && claimsRead(res.content, o.instruction);
        const searchClaim = armed && executedSearches === 0 && claimsSearch(res.content, o.instruction);
        const claimKind = writeClaim ? 'write' : readClaim ? 'read' : searchClaim ? 'search' : null;
        if (armed && ((taskLike && executedTools === 0) || claimKind) && writeDenials === 0 && retries === 0 && !overCap) {
          retries = 1; record.retries = 1;
          const noticeText = claimKind === 'write' ? '检测到声称已写入但没有成功写入记录，自动重试一轮（1/1）'
            : claimKind === 'read' ? '检测到声称已读取但没有任何成功的文件读取，自动重试一轮（1/1）'
            : claimKind === 'search' ? '检测到声称已检索但没有任何成功的联网检索，自动重试一轮（1/1）'
            : '检测到未执行工具即声称完成，自动重试一轮（1/1）';
          // 命中句留痕（dev.5）：台账不存中间轮原文，误判事后无法校准（本次画像事故
          // 就因缺第一轮原文而难以归因）——把命中的完成态原句（截断）写进 notice step
          const claimRe = claimKind === 'write' ? WRITE_CLAIM_RE : claimKind === 'read' ? READ_CLAIM_RE : SEARCH_CLAIM_RE;
          step({ kind: 'notice', notice: 'retry', text: noticeText,
            ...(claimKind ? { evidence: claimSentences(res.content, claimRe).slice(0, 3) } : {}) });
          // 被重试轮正文全量留档（dev.5+3）：管线 reset 会把已流出的正文从聊天里抹掉——
          // 实测女娲轮（run_muohkej9_5）被顶替的正是用户看过的工作讨论，且此前无任何落盘。
          // 全文进台账：误判可恢复、校准有原话、用户可调取。
          const wiped = record.wipedRounds || (record.wipedRounds = []);
          wiped.push({ at: new Date().toISOString(), kind: claimKind || 'fake_done', content: String(res.content || '').slice(0, 16000) });
          pipeline.reset(); // 管线与渲染层正文同步清空，重试轮从零开始
          const claimMsg = claimKind === 'write' ? CLAIM_MSG : claimKind === 'read' ? READ_CLAIM_MSG : claimKind === 'search' ? SEARCH_CLAIM_MSG : FAKE_DONE_MSG;
          toolTurns.push(
            { role: 'assistant', content: res.content || '', ...(reasoningPassback(res) ? { reasoning_content: reasoningPassback(res) } : {}) },
            { role: 'system', content: claimMsg },
          );
          continue;
        }
        return await finishRun(res.content);
      }

      // 工具轮：assistant tool_calls + 逐个执行回填 tool results（id 缺失时生成并两侧一致）。
      // 思考模式（DeepSeek 强制）：assistant 消息必须原样回传上一轮的 reasoning_content，
      // 否则接口 400「The reasoning_content in the thinking mode must be passed back」
      // （reasoning 异常缺失时垫非空白占位，见 reasoningPassback）
      const calls = res.toolCalls.map((tc, i) => ({ tc, id: tc.id || `call_${runId}_${i}` }));
      const asstMsg = {
        role: 'assistant',
        content: res.content || '',
        ...(reasoningPassback(res) ? { reasoning_content: reasoningPassback(res) } : {}),
        tool_calls: calls.map(({ tc, id }) => ({
          id, type: 'function',
          function: { name: tc.name, arguments: tc.argsRaw || '{}' },
        })),
      };
      toolTurns.push(asstMsg);
      let needBreakMsg = false;
      for (const { tc, id } of calls) {
        if (isStale()) return;
        const out = await runTool(tc);
        if (isStale()) return;
        const toolMsg = { role: 'tool', tool_call_id: id, content: out.content };
        // 压缩回执要能报出「哪个工具/哪个路径/原多少字符」——元数据走 WeakMap，不进消息体
        try {
          const a = JSON.parse(tc.argsRaw || '{}');
          toolMeta.set(toolMsg, { tool: tc.name, path: a.path, chars: (out.content || '').length });
        } catch (_) {}
        toolTurns.push(toolMsg);
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

// 测试钩子：SEARCH/WRITE/READ_CLAIM 词表与豁免逻辑校准回灌用（v0.3.5 实测校准法）
function _claimsSearch(text, instruction) { return claimsSearch(text, instruction); }
function _claimsWrite(text, instruction) { return claimsWrite(text, instruction); }
function _claimsRead(text, instruction) { return claimsRead(text, instruction); }
function _instructionIsTask(instruction) { return instructionIsTask(instruction); }

module.exports = { startRun, abortRun, hasRun, channelOf, _claimsSearch, _claimsWrite, _claimsRead, _instructionIsTask, _channelOf: channelOf };
