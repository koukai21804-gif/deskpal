# 里程碑 H · Agent 执行管线与表情节拍（v0.3）

> 状态：**as-built**（2026-09-22 实现完成并通过自动化验证：`npm run test:agent` 58+37 项、`npm run test:fs-guard` 18 项、`DESKPAL_SMOKE=full` 冒烟 0 ERROR）。
> 前置：A–G 已完成；H 依赖 C 的聊天管线（`chat.js`/`llm.js`/`emotion.js`）与 G 的 agent stub（`agent/tools.js`/`builtin.js`）。
> 本文是执行级规格，未尽事项按总纲「全局约定」裁决。实现与规格的差异见文末「as-built 差异记录」。

## 0. 研究结论（Amadeus，执行时不必再读原项目）

参考项目：**Amadeus**（github.com/Lucas1479/Amadeus，实时多模态桌面 AI Agent，Python Host + Electron，**AGPL-3.0**）。
⚠️ **许可证红线：Amadeus 为 AGPL-3.0，本项目为 MIT。只借鉴其设计思想与协议形态，所有代码独立实现，禁止复制/改写其任何源码。** 下表引用仅作设计出处标注。

本里程碑移植其四个设计（编号对应调研结论的借鉴点 ①–④）：

| # | 借鉴点 | Amadeus 程序位置（`仓库根/` 起） | deskpal 对应物 |
|---|--------|--------------------------------|----------------|
| ① | 文本标记式流式进度协议：模型在输出里打 `[PROGRESS:DESIGN\|DIAGNOSTIC\|CAPABILITY\|VALIDATION] …` 单行，Host 在**任意字节边界**安全切分（保留可能是半截标记的尾巴），转为结构化里程碑事件并从用户可见文本剥离 | `agent_host/provider_progress.py:36-39`（四类标记契约）、`:153 split_progress_stream`（跨 chunk 切分/尾巴保留）、`:161`（传输可在任意字节截断注释）；事件分层见 `agent_host/provider_types.py:347`（`assistant.delta` 原始流 / `semantic.progress` 适配器分类事实） | `agent/progress.js`（`[进展:…]` 剥离器，流式 chunk 级）+ `agent:step` 推送 |
| ①′ | 假完成检测：任务报 done 但**零执行项**（只报了进度没干活）→ 触发一次有界恢复重试（ordinal 强制为 1） | `agent_host/provider_progress.py:225 is_progress_only_workspace_completion` | H1.6（零工具调用 + 声称完成 → 一次提醒重试） |
| ② | epoch 打断：打断时世代号 +1；各层（LLM 流 / 合成循环 / 播放写入）在每个安全点比对 `epoch != current → 丢弃`；**固定顺序：先停源头、再排干下游**（顺序颠倒会让旧流在排干后继续入队） | `server/interrupt_flow.py:48-97`（三步顺序及注释）、`tts/pipeline.py:70/224`（epoch 与检查点）、`tts/playback.py:372/400-403`（写前 `is_current` 检查）。其 `core/turn_coordinator.py` 中央账本属过度设计，**不移植**（本项目单进程用每 run 一个整数即可） | `agent/loop.js` 的 runEpoch + 安全点检查 |
| ③ | 权限卡：provider 中立结构（capability/action/scope/reversibility/options），选项折叠为 `allow_once / deny`，fail-closed（超时/异常一律拒绝） | `agent_host/work_ledger_types.py:391 PermissionRequestRecord`、`server/work_permission_service.py`（`resolve()` 三方身份校验）、`agent_host/adapters/pi.py:300`（外部 confirm 事件 → 中立结构映射） | `agent/permissions.js` + 聊天窗权限卡 |
| ③′ | 写操作差分归因：「模型改了什么」不靠模型自报，而是**执行前后快照对比**得出；不在本次执行血统内的变更标 `ambiguous_origin` 不认领 | `server/work_artifact_registry.py:35 capture_baseline`、`:117 finalize_attempt`、`:177 ambiguous_origin` | `agent/trace.js`（userData 快照 → 变更列表 + 行级 diff） |
| ③″ | 元数据防伪造 / 恢复不自作主张：进入执行请求的调用方元数据先剥离权威键；崩溃后 `unknown` 状态只对账、永不自动重发/重启执行 | `agent_host/provider_runtime.py:66 _CONTROL_PLANE_METADATA_KEYS`、`:185 scrub_untrusted_provider_metadata`、`:471 reconcile_submission`（只读五态对账） | run 记录只由主进程写入（模型无伪造面）；启动时把 `running` 记录标 `interrupted`，不自动重跑（H1.7） |
| ④ | 表情逐句节拍：LLM 内联 `[EMO xxx]` 标签 → 流式字符级解析（跨 chunk 状态、防半截标签泄漏）→ 绑定 sentence_id → **该句起播回调**才触发表情 → 回合结束/打断清空映射；多句合并音频时按字符语音权重分摊每句时间偏移 | `llm/prompts.py:24-40`（标签规则：第一句位置、长回复 1–2 个节拍、每句限 1 个）、`llm/stream_parser.py:24 StreamTagParser`、`core/chat_runtime.py:1916`（`register_sentence_actions` 按 sentence_id 挂载）、`vts/expression_controller.py:41/164`（起播触发 + 回合清理）；句偏移 `tts/playback.py:1085 _segment_speech_weight`、`:1135 _segment_offsets`、`:1166 _fire_segment_starts` | `emotion.js` 节拍协议 + 聊天窗按句触发（显示时刻对齐；TTS 起播对齐为 H2.5 预留） |

明确**不移植**的部分（调研结论）：Work Ledger 四层台账（Project/WorkItem/Operation/Attempt）、effect 幂等契约、多 Provider 注册路由、AUIP 应用会话、中央 epoch 账本、双份同构状态机——deskpal 用「一个 JS 循环 + 一个 JSONL 文件 + 每表几行结构」覆盖同一批不变量。

## H1. Agent 执行管线（F9）

### H1.0 目标与范围

- roleplay 聊天中，宠物可实际执行文件任务：读、列目录、写文件（写需用户批准）。
- 工具集维持 G 里程碑注册表三件：`read_file` / `list_dir` / `write_file`（`write_file` 由 `enabled:false` 升为可用，见 H1.4 权限闸）。全部经 fs-guard 仲裁，权限模型不变（读黑名单拒绝；写仅 `userData/` 与 `userData/temp/`）。
- quick（快问）标签页**不接入**工具；陪读/日程等内部 LLM 任务不接入。
- 单 run 上限：`maxRounds` 轮 LLM 调用（默认 8）+ 一次假完成重试。

### H1.1 总体流程（`agent/loop.js`）

接入点在 `chat.js` 的 `send()` 后台协程内（不为 agent 单开 IPC 入口，渲染层仍只调 `chat:send`/`chat:stop`）：

```
chat:send(roleplay, text)
 └─ llm.streamChat(messages, { withTools: settings.agent.enabled, reqId })
     ├─ 流式正文：先过 progress.js 剥离器 → 干净 delta 走 llm:chunk，
     │   [进展:…] 行转 agent:step{kind:'progress'} 推送
     └─ 返回 {content, toolCalls, finishReason}
         ├─ finishReason='stop'  → 最终回复：走既有 parseAndStrip → H2 节拍 → llm:done（不变）
         └─ finishReason='tool_calls'
             ├─ 逐个工具：
             │   ① permission==='write' → permissions.request()（权限卡，阻塞等待 allow_once/deny/超时）
             │   ② deny → 把拒绝原因作为该工具的 result 回给模型，继续下一轮（不中断 run）
             │   ③ allow/read → invoke（fs-guard 仲裁）→ trace 记录 → result 回填
             │   ④ 每步前后检查 runEpoch（H1.3），stale 则整体静默退出
             ├─ messages.push(assistant tool_calls + tool results) → 下一轮（epoch 检查）
             └─ 轮次 ≥ maxRounds → 追加 system「已达执行上限，请基于现有结果作答」收尾
最终回复落库前：trace.finalizeRun() → 变更列表 + diff → agent:artifact + run 记录收尾
```

关键取舍（与 Amadeus 差异）：**中间工具轮不写入对话历史**。`chats/roleplay` 仍只存用户消息与最终 clean 回复，run 全过程（含工具调用、权限、变更）存 `agent/runs.jsonl`（H1.7）——避免上下文膨胀，也避免 `buildMessages` 改动。

### H1.2 进度标记协议（`agent/progress.js`）

- **协议（给模型的契约，追加在 roleplay system prompt，见 H1.9）**：

```
执行任务的过程中，在正文里用单行进展标记汇报关键节点（读出来，不要念标记本身）：
[进展:设计] <决定了什么、为什么>      [进展:发现] <观察到什么意外事实、影响与对策>
[进展:能力] <现在完成了什么可交付的东西> [进展:验证] <检查了什么、结果、发现的问题>
每条 ≤40 字；普通聊天不使用；不要把标记写进工具参数。
```

- **剥离器 `createProgressSplitter()`**（Amadeus `split_progress_stream` 的独立实现）：输入流式 chunk，输出 `{cleanDelta, progress:[{phase,text}]}`。
  - 状态机持有 `buffer`；正则 `\[进展[:：]\s*(设计|发现|能力|验证)\s*\]\s*([^\n]{0,60})`；
  - **尾巴保留**：buffer 尾部自最后一个 `[` 起若不足一个完整标记（无 `]` 且长度 < 12），该片段留在 buffer 等下一 chunk——半截标记永不泄漏到聊天气泡（对应 Amadeus `:161`「传输可在任意字节边界截断」的处理）；
  - flush（流结束）：buffer 中不足标记的残余按正文原样输出；
  - 剥出的进展行 → `sendToWin('agent:step', {tab:'roleplay', reqId, kind:'progress', phase, text})`。
- 渲染层（聊天窗）：`agent:step` 渲染为该条消息下方的**步骤时间线**（可折叠）：🔍阶段徽章（设计/发现/能力/验证）+ 文本；与工具步骤（H1.4/H1.5 的 `kind:'tool'`）同一条时间线。
- 事件分层（对应 `provider_types.py:347` 的语义）：`llm:chunk` 永远只承载干净正文（原始流中可能被作废的材料）；`agent:step` 承载结构化事实。两者不混用。

### H1.3 epoch 打断（`agent/loop.js`）

- 每 run 实例持有整数 `runEpoch`（初始 0）。**不引入** Amadeus 的中央账本/多套 epoch——单进程桌面程序一个变量够用。
- 打断入口：`chat:stop {reqId}`（现有通道，渲染层停止按钮不变）。loop 内部顺序（顺序即正确性，对应 `interrupt_flow.py:48-97`）：
  1. `llm.stop(reqId)` —— 中止当前 LLM 流（若在流中）；
  2. `runEpoch++` —— 此后一切异步回调的结果作废；
  3. 清空未决权限请求 —— 全部按 `deny` 结束（广播 `agent:permission` 终态，UI 卡片转「已停止」）；
  4. `trace.finalizeRun()` —— **诚实收尾**：把停止前已实际发生的文件写入如实列入 changes；
  5. 广播 `agent:done {aborted:true, changes}`，run 记录落 `status:'aborted'`。
- 安全点检查 `isStale()`（`epoch !== runEpoch`）：每轮 LLM 发起前、每个工具结果返回后、每次 `agent:step`/`agent:artifact` 推送前、权限 resolve 回调内。stale → 直接 return，不再产生任何推送与写入。
- **写工具的诚实语义**（对应 ③″「不自作主张、也不掩盖事实」）：工具是本地 fs 操作（毫秒级），不做真取消；若写入已完成而 epoch 已变，变更仍进 run 记录与 `agent:done` 载荷——停止按钮不能让「已经写了的文件」消失于记录。

### H1.4 权限卡（`agent/permissions.js`）

- 请求结构（简化自 `PermissionRequestRecord`，provider 中立字段）：

```js
{
  id, runId, tool: 'write_file',
  action: '新建文件' | '覆盖文件',
  scopePaths: ['%APPDATA%/deskpal/temp/todo.md'],   // 绝对路径，fs-guard 通过后的最终目标
  detail: '{文件名, 字节数, 新建|覆盖}',
  reason: String,              // 模型在 write_file 参数里必填的 reason，卡片原文展示
  reversibility: 'temp 内新建（可删）' | '覆盖已有文件（原内容不自动保留，diff 卡可见）',
  options: ['allow_once', 'deny'],   // 固定两选项，无 always（后续迭代再议）
  createdAt, timeoutSec: 120,
}
```

- 生命周期：`request()` 返回 Promise，`Map<id, resolve>` 挂起；渲染层调 `agent:permission-resolve {requestId, decision}`；超时（默认 120s，可配）→ deny；`chat:stop` → deny；app 退出 → 全部按 deny 落记录。**fail-closed：一切异常路径的缺省都是拒绝**（对应 `work_permission_service.py` 的 fail-closed 原则）。
- deny 的后续：不中断 run——把「用户拒绝了这次写入（reason: …）」作为该工具的 result 回给模型，让它改口或调整方案（多数模型会转述并询问）。连续 2 次 deny 同一目标 → 追加 system「用户已两次拒绝同一写入目标，停止再次尝试该目标」。
- UI：聊天窗内嵌卡片（路径、字节数、reason、`允许一次`/`拒绝` 两按钮 + 倒计时）；宠物窗同步弹气泡「有个文件操作需要你批准」点击聚焦聊天窗（复用 `pet:say` 气泡 + 点击开窗，参照日程提醒卡模式）。
- `write_file` 工具参数增加必填 `reason`（≤60 字），注册表 `tools.js` 的 tool 定义补 params 描述；`invoke` 前由 loop 统一拦截 write 权限（不依赖 handler 自查，双保险保留 handler 内 fs-guard 校验）。

### H1.5 写操作差分归因（`agent/trace.js`）

- **快照范围**（fs-guard 写白名单决定，快照区=白名单区）：`userData/temp/` 全部 + `userData/` 根层文件 + `config/`；排除 `logs/`（日志常变）、`books/`、`activity/`、`chats/`、`library/`、`schedule/`、`memory/`（非写工具目标区，避免每次 run 全量扫描）。每文件记 `{size, mtimeMs}`（不哈希，diff 靠读取内容）。
- `captureBaseline(runId)`：run 开始（首次出现工具调用时才做，纯聊天不快照）。
- `recordToolWrite(path)`：每次 write_file 后单文件 before/after（`kind: create|modify|overwrite`）。
- `finalizeRun()`：全量对比快照 → `changed[]`；**不在任何工具调用结果里的变更 → `origin:'ambiguous'`**（对应 `ambiguous_origin`：正常不会出现——deskpal 里只有工具会写白名单区；一旦出现即在 diff 卡顶部黄条警示「检测到工具声明之外的变更」，这就是「模型自述不算数、Host 观察才算」的底线）。
- **行级 diff**：自实现简易按行 LCS（限每文件 200 行差异，超出截断标注），输出 `{path, before, after, hunks:[{aStart, aLines, bStart, bLines}]}`。不引第三方库。
- 推送 `agent:artifact {tab, reqId, changed}` → 聊天窗 **diff 卡**（每文件一块：路径 + 新建/覆盖徽章 + 增删行着色）。卡片头部固定文案：「**以下变更由 deskpal 前后快照实测得出，非模型自述**」。
- 快照与 diff 结果全部进 run 记录（H1.7），可回看。

### H1.6 假完成检测（一次有界重试）

- 触发条件：本 run `finishReason='stop'` 且给出最终回复，但满足「任务型」判定 —— 首轮模型请求过工具**或**正文含 ≥1 条 `[进展:]` 标记 —— 且 `totalToolCalls === 0`（整 run 一次工具都没调）且 `retries === 0`。
- 动作：不结束 run，追加一条 system：「上一轮你没有调用任何工具就声称完成了任务。若任务确需读写文件，请调用工具执行；若确实无需工具，直接给出最终答复。」再走一轮（`retryOrdinal: 1`，**上限 1 次**，对应 Amadeus 恢复槽 ordinal 强制为 1 的有界思想）。重试后无论结果如何都正常收尾。
- 纯聊天（首轮即无工具请求、无进展标记）不触发，避免打扰。

### H1.7 run 记录与中断恢复（轻量台账）

- 存储：`agent/runs.jsonl`（追加式，schema 见附录 B）。每 run 一条：指令、步骤（llm 轮/工具调用/权限/进展/变更）、最终回复、`status: done|aborted|error|denied|interrupted`、`retries`。
- **写记录的只有主进程**（模型输出只是步骤素材之一，run 状态字段模型不可触达——对应 ③″「控制平面元数据防伪造」：deskpal 的等价做法是根本不给模型写台账的通道）。
- 启动恢复：main.js 启动时读 `runs.jsonl`，`status:'running'` 的记录改标 `interrupted` 并原子重写文件。**不自动重跑**（对应「恢复只做对账与围栏，永不自作主张重启执行」）。
- 聊天窗打开时若有 `interrupted` 记录：顶部提示条「上次有个任务被中断（查看）」→ 展开 run 详情 + 按钮「重新发起」＝把原指令填入输入框由用户确认发送（新 run，不复用旧状态）。
- 查询通道：invoke `agent:runs {limit?} → {runs:[…]}`（倒序，默认 20）。

### H1.8 LLM 客户端扩展（`llm.js`，向后兼容）

- `streamChat` 增加 `opts.withTools`：请求体附 OpenAI `tools`（由 `agent/tools.js` 的 `list()` 映射为 OpenAI function schema）+ `tool_choice:'auto'`；SSE 解析增量累计 `delta.tool_calls[].{id,name,arguments}`（arguments 字符串跨 chunk 拼接，轮末 JSON.parse 失败按「工具调用格式错误」处理：result 回填错误提示，不炸 run）。
  - 返回值：`withTools` 时返回 `{content, toolCalls, finishReason}`；不带时维持返回 string（现有调用方零改动）。
- `genericCompletion` 增加 `tools` 选项（非流式决策轮，见下）。
- **兼容降级**：若带 `tools` 的流式请求返回 400（部分网关不支持 stream+tools），记 `api.json` 的 `toolsStreamBroken:true`，此后工具决策轮自动改非流式（`genericCompletion+tools`），最终回复轮恢复流式。决策轮对 deepseek 系沿用 `thinking:{type:'disabled'}`。
- 工具结果消息格式：`{role:'tool', tool_call_id, content: JSON字符串（截断至 4000 字符）}`。

### H1.9 chat.js / prompts.js 集成

- `chat.js send()`（仅 roleplay 且 `settings.agent.enabled`）：
  - 循环内每轮 messages = 基础上下文 + 本轮累积的工具轮消息；
  - 步骤推送：工具开始/结束 → `agent:step {kind:'tool', tool, summary, ok}`；权限请求 → `agent:permission`；变更 → `agent:artifact`；
  - 最终回复路径完全复用现状（parseAndStrip → 历史 → 情绪广播 → llm:done → memoryTick），`llm:done` 载荷追加 `runId`；
  - run 期间宠物表情：首个工具调用 → `emotion.broadcastEmotion('thinking', {source:'agent'})`，最终回复的节拍/兜底情绪自然接管回落。
- `prompts.js roleplaySystem()` 追加「任务执行模式」段（工具清单、何时该用/不该用：**仅当用户明确要求读写文件、生成文件到某处、整理某目录**；普通聊天禁用）、`[进展:]` 契约（H1.2）、`write_file` 必填 reason。
- 快问 `quickSystem` 不加任何 agent 内容。

### H1.10 设置与 UI 落点

- `settings.json` 新增：`agent: { enabled:true, maxRounds:8, permissionTimeoutSec:120 }`（附录 B）。
- 设置页 **API 标签**底部新增「Agent 执行」区块：总开关、最大轮次（4–16）、权限超时（60–300s）。
- 聊天窗新增三个内嵌组件（`src/renderer/chat/`）：步骤时间线（progress + tool 共用）、权限卡、diff 卡；均只在 roleplay 出现。

### H1.11 文件清单（新增/改动，as-built）

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/main/services/agent/loop.js` | 新增 | 执行循环 + runEpoch 打断 + 轮次上限 + 假完成重试 |
| `src/main/services/agent/progress.js` | 新增 | `[进展:]` 流式剥离器（createProgressSplitter） |
| `src/main/services/agent/permissions.js` | 新增 | 权限请求生命周期（request/resolve/超时/fail-closed） |
| `src/main/services/agent/trace.js` | 新增 | 快照/差分归因/行级 diff/ambiguous 检测 |
| `src/main/services/agent/runs.js` | 新增 | runs.jsonl 追加/收尾重写/查询/启动标 interrupted |
| `src/main/services/stream-pipeline.js` | 新增（as-built 补） | 节拍+进展流式管线（chat 平铺路径与 agent loop 共用） |
| `src/main/services/agent/builtin.js` | 改 | write_file 转 enabled（经权限闸），参数加 reason |
| `src/main/services/agent/tools.js` | 改 | 注册表补 openAiSchemas()（OpenAI function schema 映射） |
| `src/main/services/llm.js` | 改 | withTools/tools 解析/400 降级/genericCompletion tools 选项/deepseek 决策轮关 thinking |
| `src/main/services/fs-guard.js` | 改（差异14） | 写入三档模式 setWriteMode + full 模式写黑名单 |
| `src/main/services/chat.js` | 改 | roleplay 接入 loop；流式统一走 stream-pipeline；llm:done 带 msgId/beats/runId |
| `src/main/services/emotion.js` | 改 | createBeatParser 增量状态机；parseAndStrip 走同一解析核（新增 beats 返回） |
| `src/main/services/prompts.js` | 改 | 任务执行模式 + 进展契约段 + 节拍协议段（quick 加节拍说明） |
| `src/main/services/store.js` | 改 | settings.agent 默认块；api.toolsStreamBroken 默认 false |
| `src/main/ipc.js` / `preload.js` | 改 | agent:permission-resolve / agent:runs 通道；chat:stop 接 loop 打断；推送白名单 + agent:* |
| `src/main/main.js` | 改 | 启动恢复钩子（markInterruptedOnBoot）；退出 denyAllStopped；DESKPAL_USERDATA 测试钩子 |
| `src/renderer/chat/app.js`（+chat.css） | 改 | 时间线/权限卡/diff 卡/中断提示条/节拍触发/重试清空/历史附加数据保留/权限三档选择器 |
| `src/renderer/pet/bubble.js` | 改 | perm-ask 气泡（去批准 → 聚焦聊天窗） |
| `src/renderer/settings/app.js` | 改 | API tab Agent 区块 |
| `scripts/test-agent.js` / `scripts/test-agent-e2e.js` | 新增 | 单元 60 项 + loop 集成 37 项（`npm run test:agent`） |
| `scripts/test-real-llm.js` / `scripts/seed-gui.js` | 新增（as-built 补） | 真实 API 端到端实测（25 项）/ GUI 测试 profile 种子 |

## H2. 表情逐句节拍（F10）

### H2.1 协议升级（向后兼容）

```
旧（保留兜底）：回复最后一行 [情绪:XX]（整条一个，现有实现）
新（主协议）  ：正文中可穿插短标签 [开心]/[思考]/[惊讶]/[愤怒]/[悲伤]/[平常]（与口头禅、
               lines.js parseLine 同一格式），标签置于其所修饰句子的句末；
               每句 ≤1 个；只在情绪**变化**时打标签（连续同情绪可省略，避免表情频繁闪烁）；
               3 句以上的回复至少 1 个节拍；末行 [情绪:XX] 仍必须附（兜底 + 历史摘要）。
```

prompt 指引对应 Amadeus `llm/prompts.py:24-40`（`[EMO]` 规则），但做两点本地化取舍并写进 prompt 注释：
- Amadeus 要求「第二句起无强烈情绪必须显式 `[EMO normal]`」→ **不采用**：deskpal 表情差分图仅 6 张且切换带动画，规则改为「只在变化时打标签」；
- Amadeus 的 `serious_speaking/shy/blush` 等扩展表情集 → 不采用，维持 6 表情（KEY_MAP 不动）。

### H2.2 流式节拍解析（`emotion.js` 重构）

- 新增 `createBeatParser()`（增量状态机，对应 `StreamTagParser` 的跨 chunk/防泄漏思路）：
  - 输入流式 chunk，输出 `{cleanDelta, beats}`；
  - 识别三类标签并从正文剔除：短节拍 `[开心]` 等（6 键白名单）；末尾兜底 `[情绪:XX]`；`[日程:{…}]`；
  - **尾巴保留**：buffer 尾部自最后一个 `[` 起、无 `]` 且长度 < 12 → 暂缓推送（节拍/情绪标签）；`[日程:{` 开 JSON 模式时 buffer 上限放宽到 500；
  - `flush()`：残余 buffer 按正文输出；返回 `{clean, beats, emotion(末尾兜底，可能 null), schedule}`。
- `parseAndStrip()` 保留签名不变（非流式路径、历史重建、陪读复用），内部改走同一解析核。
- 流式管线（`chat.js send`）：`onChunk` 先过 beatParser 再过 progress 剥离器（顺序：节拍剥离 → 进展剥离 → 干净 delta 推 `llm:chunk`），`llm:done` 载荷扩展 `beats`。

### H2.3 节拍调度（按句绑定，显示时刻触发）

- 主进程 flush 后把 `clean` 按句切分（`。！？…\n`），每个节拍按其在 clean 中的字符位置落位到句，产出 `beats:[{s:句序, e:'happy'}]`（对应 `chat_runtime.py:1916` 的 sentence_id 绑定）。
- 触发方在**渲染层**（聊天窗）：流式打字渲染时，某句最后一个字符显示完成且该句有绑定节拍 → `deskpal.petEmote(e, 'chat', revertMs)`（复用现有 `pet:emote` invoke → 主进程 → 宠物窗，通道零新增）。roleplay `revertMs:0`（持久保持，与现有 `[情绪:]` 行为一致）；quick `revertMs:6000`。
- 回合结束/打断（对应 `expression_controller.py` 的回合清理）：`llm:done`（含 aborted）后渲染层本地节拍表作废——停止按钮中止打字即不再有后续触发，表情按 pet.js 现有 persistent/revert 机制自然回落，无需广播清理。
- 宠物窗 `pet.js` 无需改动。

### H2.4 数据与兼容

- 历史消息扩展：`{..., content: clean, beats, emotion}`（beats 可缺省，旧消息照常渲染；附录 B 更新）。
- `buildMessages` 回灌上下文时 beats 不参与（仍用 clean 文本）。
- 陪读放映（帧 `e` 字段）、口头禅标签、日程标签行为全部不变——短标签格式就此全局统一。

### H2.5 TTS 对齐预留（本次不实现）

未来接入 TTS 时：节拍触发点从「句子显示完成」换成「该句音频起播回调」（结构不变，只换触发源）；多句合并合成时按**字符语音权重**把总时长分摊到各句得到偏移——权重参考 Amadeus `tts/playback.py:1085`（假名 1.0 / 汉字 1.15 / 拗音 0.35 / 句号 2.2），中文场景建议：汉字 1.0、中文标点 0.6（停顿）、英文字符 0.5、数字 0.6。beats 按句存储的 schema 天然支持，无需迁移。

## H3. 登记（执行前先登记附录，与全局约定 3 一致）

- **附录 B**：`agent/runs.jsonl` schema、`settings.json` 的 `agent` 块、`chats` 的 `beats` 字段、`api.json` 的 `toolsStreamBroken`。
- **附录 C**：invoke `agent:permission-resolve` / `agent:runs`；推送 `agent:step` / `agent:permission` / `agent:artifact` / `agent:done`；`llm:done` 载荷扩展（beats、runId）。
- **附录 D**：里程碑 H 验收清单（下节）。

## 验收清单（实现后自检记录，2026-09-22）

自动化已验证（`npm run test:agent` 单元 87 项 + 集成 65 项；含下列条目的桩化等价路径）：

- [x] roleplay「帮我在数据目录的 temp 里建一个 todo.md，写入三条今日待办」→ 权限卡（路径/字节/reason/倒计时）→ 允许一次 → diff 卡显示新建文件全文 → `temp/todo.md` 真实存在；步骤时间线含 `[进展:]` 行且正文无标记残留；runs.jsonl 有完整记录（e2e 用例 1；GUI 实测待真实 Key）
- [x] 同指令点「拒绝」→ 模型收到拒绝并转述/改方案，无文件产生；连续拒 2 次同目标 → 不再尝试该目标（e2e 用例 2：熔断 system 注入 + 第三次不再发卡）
- [x] 权限卡倒计时超时 → 自动按拒绝处理（fail-closed 单测 + 权限卡终态文案）
- [x] 任务执行中点停止 → `agent:done{aborted:true}`；已完成的写入如实出现在 changes（不隐瞒）；未决权限卡转「已停止」（e2e 用例 5）
- [x] 假完成：构造「把 A 文件内容倒序存到 B」而模型首轮只说不做 → 自动附加提醒重试一轮，重试上限 1（e2e 用例 3）
- [x] 带工具流式请求被网关 400 → 自动降级非流式决策轮，功能不中断；`api.json` 记 `toolsStreamBroken`（llm.js 400 分支；真实网关实测待 Key）
- [x] 工具尝试写黑名单路径（如 `C:\Windows\x`）→ fs-guard 拒绝，模型收到错误 result（e2e 用例 6：即便权限允许仍拒，双保险）
- [x] 杀进程后重启 → `running` 记录标 `interrupted`，聊天窗出提示条，「重新发起」只是填充输入框不自动发送（runs 单测 + 渲染层 loadInterrupted）
- [x] 节拍：长回复出现 ≥2 次表情切换且与句对齐；慢速流式下 `[开` 半截标签跨 chunk 不泄漏到气泡（beat 单测逐字符验证）
- [x] 兼容：旧格式回复（仅末尾 `[情绪:XX]`）行为与升级前一致；quick tab 无工具无时间线（单测旧格式组 + prompt 未加 agent 段）
- [x] `DESKPAL_SMOKE=1 npm start` 冒烟通过（隔离 userData：`DESKPAL_USERDATA=<dir>` 绕开运行中实例的单实例锁）；`npm run test:fs-guard` 仍 PASS

## as-built 差异记录（实现与规格的偏差及理由）

1. **流式管线顺序**：规格 H2.2 写「节拍剥离 → 进展剥离」，实现为**进展剥离先行**。原因：节拍的字符位置必须落在最终 clean（进展剥离之后）的坐标上，否则含 `[进展:]` 行的回复其后续节拍句序整体偏移；两类语法互不相交、剥离可交换，输出 delta 等价。
2. **假完成重试的豁免**：写入曾被用户拒绝（writeDenials>0）时不触发假完成重试——用户已介入且模型知情（拒绝 result 已回填），再提示「你没有调用任何工具」只会诱导它重试被拒目标。
3. **status=denied 语义**：全部写尝试均被拒且无任何成功写入时收尾为 `denied`（区别于 `done`），供台账回看。
4. **agent:step 新增 kind:'notice'**：假完成重试在时间线上可见（🔄 徽章），渲染层收到时同步清空流式正文（管线已 reset）。附录 C 已登记。
5. **llm:chunk 载荷新增 `beat` hint**：规格要求「渲染层在该句显示完成时触发」但 beats 映射表要到 flush 才有——主进程在剥离出短标签的当下随正文同帧推送 `beat` hint（该句正文恰好刚显示完成），渲染层据此即时 `pet:emote`；`llm:done` 仍带完整 `beats` 表（历史/回放）。通道零新增（载荷扩展已登记附录 C）。
6. **超上限收尾轮不带工具**：rounds > maxRounds 的收尾轮以纯流式（无 tools）调用——模型只能基于现有结果作答，与「已达执行上限」system 提示语义一致，也覆盖了「最终回复轮恢复流式」的降级诉求（toolsStreamBroken 时其余轮非流式）。
7. **中间轮正文累积展示**：多轮 run 的叙述性正文（工具轮 content）累积进聊天气泡，最终消息 = 整 run 累积 clean（叙述 + 最终答复），信息不丢失；`chats` 仍只存这一条 clean（不含工具轮消息，符合 H1.1 取舍）。
8. **DESKPAL_USERDATA 环境变量**：开发期测试钩子，隔离 userData 以绕开运行中实例的单实例锁；不影响正常运行。
9. **trace 快照的 `.tmp` 排除**：跳过 store 原子写的临时文件与 runs 重写临时文件，避免快照误报 ambiguous。
10. **deepseek 决策轮关 thinking（H1.8 实测补全）**：`streamChat` 带 tools 且模型为 deepseek 系时附 `thinking:{type:'disabled'}`——真实 API 实测发现思考 token 会挤占工具调用输出（非流式分支原本就有，流式分支漏了）。
11. **progress 剥离器容错增强**：同一行出现多个 `[进展:]` 标记时各自剥出（说明文字不互相吞噬）；标记独占一行时连换行一起剥除。
12. **真实 API 实测方法（2026-09-22，DeepSeek/deepseek-flash，25 项全过）**：`npx electron scripts/test-real-llm.js`——safeStorage 密文跨 profile 不可解，脚本用「PowerShell DPAPI 解包 Local State 密钥 + AES-256-GCM」解出真实 Key 注入隔离 userData；GUI 试用用 `scripts/seed-gui.js <dir>` 在目标 profile 自洽加密后 `DESKPAL_USERDATA=<dir> npm start`。
13. **数据目录路径注入（GUI 实测反馈）**：用户说「数据目录的 temp」时模型无从得知 userData 绝对路径（会去 list_dir 瞎探测后放弃追问）——`agentSection()` 现注入本应用数据目录绝对路径一行，并注明「直接使用、不要探测」；另补「用户未指定内容时生成合理默认内容，不要追问」。实测 T8（GUI 原话复现）通过。
14. **文件权限三档模式（用户需求，替代默认逐卡授权）**：`settings.agent.permissionMode`（read/userData/full，默认 read）。read=write 工具不下发+兜底拦截；userData=数据目录子树直写（模式选择即授权，无逐次卡，diff/台账照常）；full=fs-guard 扩大写白名单至本机大部分目录（核心系统目录/其他用户 profile/敏感文件/盘根文件/UNC 除外）+保留逐次权限卡。选择器在聊天窗输入区与设置页 API tab（零新增 IPC，走 store:set）。fs-guard 增加 `setWriteMode`，store.init 启动同步。
15. **权限卡从未挂载的根因（GUI 实测发现，两处叠加）**：`permissions.js` 发出的请求事件载荷缺顶层 `reqId` 字段，渲染层挂载守卫 `d.reqId !== streaming.reqId` 将其静默丢弃——用户看到并点击的其实是宠物「去批准」气泡（仅聚焦聊天窗），聊天窗内的权限卡从未渲染，120s 后一律超时拒绝。修复：`permissions.request` 接收并透传 `reqId` 至事件顶层（附录 C 契约本就如此登记）。e2e 桩掉了 permissions 模块故未覆盖此链——CDP 驱动真实 GUI 的验证（scripts/cdp-repro.js）补上：full 模式下发卡→程序化点击→`[agent]` 日志确认「点击到达主进程→结算 allow_once→文件写入」全链 1 秒内完成。教训已记：**桩测覆盖不到「主进程推送↔渲染层守卫」的载荷契约，此类字段必须在两端断言一致**。
16. **决策轮 thinking 关闭补全（见差异 10）后的 GUI 验证**：userData 档 GUI 真实链路（选择器→store:set→loop→fs-guard→写入→台账 mode=userData、无 permission 步骤、diff 归因 tool）全通；full 档卡链修复后全通。
17. **工具轮 token 上限与截断/幻觉三重防护（2026-09-22 实测反馈修复）**：真实使用复现「有写入权限却写不进、且声称已写入」——runs.jsonl 显示决策轮 `finishReason=length`：`write_file` 参数内嵌整份文档，远超聊天 `max_tokens`（流式决策轮此前甚至不传该参数，沿用聊天默认），工具调用被腰斩作废；而 loop 把 length 轮当最终回复交付，模型中途叙述「我把文档写进数据目录根」被用户当成已完成；旧假完成检测要求「零工具执行」，读过 list_dir 后即失效。修复三层：① 决策轮（带工具）统一改用 `settings.agent.toolMaxTokens`（默认 8192，设置页可调；流式经 `overrides.max_tokens`、非流式经 `maxTokens` 下发）；② 工具可用时 `finishReason=length` 不再当最终答复——清管线注入 LENGTH_MSG 有界重试 2 次（`record.lengthRetries` 入台账）；③ 声称已写入守卫：最终正文命中「完成态写入动词+文件线索」而零成功写入 → 共用假完成重试预算换 CLAIM_MSG 强指令；重试耗尽仍声称 → finalReply 追加「系统核实」注记再交付。配套：`write_file` 新增可选 `append`（大文件分段追加，提示词/工具描述均教模型分段写）；llm.js 的 stream+tools 400 降级判定排除 max_tokens 类报错（避免误标 toolsStreamBroken）；full 档权限卡对 append 显示「追加文件」；渲染层收到任何 notice（含新增 length_retry）同步清空流式正文。新增 e2e 用例 8/9/9b 复现原故障形态（单元 87 + 集成 65 全过）；真实 API T3/T8 复验通过（test-real-llm.js 同时补上了三档模式落地后缺失的 `permissionMode:'full'` 注入）。
18. **progress 剥离器超长说明泄漏（真实 API T3 发现）**：说明文字正则原为 `[^\n]{0,60}?`——模型违反 ≤40 字协议写出长说明时匹配不到行尾换行，整个 `[进展:xx]` 标记行漏进聊天气泡正文。改为不限长非贪婪匹配、剥出后在 push 处截断到 60 字（标记零泄漏优先于长度约束）。单测补「超长说明行」用例。
