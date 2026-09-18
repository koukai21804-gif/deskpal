# 里程碑 C · LLM 服务与聊天窗

前置：B。产出：llm.js、prompts.js、emotion.js、launcher.js、聊天窗（角色扮演/快问两标签）、记忆系统、聊天内日程标签联动。

## 研究结论 · soulchat 移植要点（原始项目 D:\CC_project\soulchat.html + js\）

- **API 层**：fetch POST + `Authorization: Bearer`，`stream:true`；SSE 手动解析（reader + TextDecoder，`buffer.split('\n')` 残包回填，`data: ` 前缀，`[DONE]` 结束，取 `choices[0].delta.content`）。我们只保留 OpenAI 兼容一种 apiType（Claude/Gemini 用户可走兼容网关），因此移植其 OpenAI 分支即可。
- **persona 字段全集**（我们取子集 + 保留字段名）：name/avatar/tagline/appearance/personality/speechStyle/catchphrases/background/emotionalPatterns/taboos/thinkingLogic/language/customPrompt。
- **system prompt 分层**（soulchat 顺序：角色→对话对象→世界观→世界书→记忆→**行为准则(越狱段，不移植)**→交互规则→自定义指令）。我们裁剪为：角色→对话对象→当前时间→记忆→交互规则→标签协议→自定义指令。
- **记忆**：每条 AI 回复完成后异步检查，「距上次提取的用户消息数 ≥10」触发；提取用非流式低温调用（temp 0.3 / maxTokens 1024）+ `match(/\[[\s\S]*\]/)` 抢救 JSON；失败走正则兜底（我是/我喜欢/我叫…）。
- **重新生成**：删除目标 AI 消息及其后所有消息，取再往前最后一条用户消息重发。**停止**：AbortController 中止后保留半截内容，追加「（已停止生成）」。
- soulchat 的多角色/群聊/世界观/世界书/PWA/i18n **全部不移植**。

## C1. src/main/services/llm.js

```js
// 配置：store.get('api') → { endpoint, apiKeyEnc, model, params:{temperature,maxTokens,topP,frequencyPenalty,presencePenalty} }
// 未配置或解密失败 → 抛出用户可读错误：「还没有配置 API，请到 设置→API 填写」

async function streamChat({ messages, onChunk, signal, overrides })
  // fetch(endpoint, {method:'POST', headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
  //   body:{model, messages, temperature, max_tokens, top_p, frequency_penalty, presence_penalty, stream:true, ...overrides},
  //   signal})
  // SSE 解析（见上方研究结论）→ onChunk(delta, fullSoFar) → 返回完整文本
  // 非 2xx：读 body 的 error.message 转成中文错误（401→「API Key 无效」；429→「调用频率/额度超限」；其他→「接口返回 {status}」）

async function genericCompletion(messages, { temperature=0.3, maxTokens=1024 })  // 非流式（stream:false），供记忆/日程解析/大纲等内部任务
async function testConnection()  // maxTokens=8 发「你好」，返回 {ok, latencyMs|error}
```

每个进行中的流注册到 `Map<reqId, AbortController>`；`stop(reqId)` 调 `controller.abort()`，调用方捕获 AbortError 按正常停止处理。

## C2. src/main/services/prompts.js（函数即模板，全部中文）

```js
nowText()            // "2026-09-16 星期三 14:05"
roleplaySystem()     // 角色扮演 tab 的 system（下文全文）
quickSystem()        // 快问 tab 的 system（下文全文）
memoryExtractPrompt(recentText)   // 记忆提取（下文全文，soulchat 原文）
```

**roleplaySystem() 全文**（`{}` 为注入位；字段为空则整行省略；记忆为空则整节省略）：

```
你是{name}，一只生活在用户电脑桌面上的桌面宠物。{tagline}

【角色设定】
外貌：{appearance}
性格：{personality}
说话风格：{speechStyle}
口头禅：{catchphrases}
背景：{background}
情绪模式：{emotionalPatterns}
禁忌（绝对不能做）：{taboos}
思维逻辑：{thinkingLogic}

【对话对象】
与你对话的人是{userName}。{userDescription}

【当前时间】
{nowText()}

【长期记忆（之前对话中的重要信息）】
- {content}（最多10条）

【交互规则】
- 始终用{language}回复
- 始终保持角色设定，不要跳出角色
- 用自然、生动的语言回复，要有推进感和主动性，不要重复用户的描述
- 你与用户是相互关心的伙伴，可以适度主动关心用户，但不要每条都说教

【输出标签协议（重要）】
1. 每条回复的最后一行，必须单独附情绪标签：[情绪:XX]，XX 只能取：平常/开心/惊讶/愤怒/思考/悲伤。
2. 如果用户在对话中明确说出了未来的安排（约会、会议、赶工、缴截止时间等），且时间明确或可以可靠推断，在情绪标签的上一行附加日程标签：
[日程:{"title":"简短标题","kind":"event或task","start":"YYYY-MM-DD HH:mm","durationMin":数字或null,"remindPreset":"event/start/deadline/none"}]
   kind：约会/会议/外出等日历安排=event，有开始或截止的工作任务=task；remindPreset 按类型选 event/start/deadline，无法判断用 none。
   时间一律换算成绝对时间。只有意图明确、时间可确定才附加；拿不准就不附，绝不编造时间，也不要为了附标签而改变聊天语气。

【自定义指令】
{customPrompt}
```

**quickSystem() 全文**：

```
你是桌面宠物{name}的速问速答模式。{tagline}
性格：{personality}；说话风格：{speechStyle}
当前时间：{nowText()}

现在直接、简洁、准确地回答用户的问题：
- 不进行角色扮演剧情，不反问闲聊，答完即止
- 可以带一丝你的口吻，但信息准确优先
- 能短则短；需要展开时用 markdown 列表/小标题/代码块
- 涉及文件路径、命令、代码时给出可直接复制使用的完整内容

每条回复最后一行仍必须单独附 [情绪:XX] 标签（平常/开心/惊讶/愤怒/思考/悲伤）。
```

**memoryExtractPrompt 全文**（soulchat 原文移植）：

```
你是一个对话记忆提取器。只输出JSON数组，不要有其他内容。
请分析以下对话，提取需要长期记住的关键信息。对于每条信息，标注类型和重要性（1-5星）。

类型分类：
- relationship: 人物关系变化
- event: 重要事件
- fact: 关键事实
- preference: 喜好/偏好

输出格式（JSON数组）：
[
  {"type": "类型", "content": "简洁的信息描述（20字以内）", "importance": 数字1-5}
]

只输出重要且值得长期记忆的信息（重要性>=2），无关紧要的对话细节不要提取。

对话内容：
{recentText}
```

## C3. src/main/services/emotion.js

```js
const EMOJI_SET = ['平常','开心','惊讶','思考','悲伤','愤怒'];          // 内部键: normal/happy/surprised/thinking/sad/angry
const KEY_MAP = {平常:'normal', 开心:'happy', 惊讶:'surprised', 思考:'thinking', 悲伤:'sad', 愤怒:'angry'};

function parseAndStrip(content)
// 返回 { clean, emotion|null, schedule|null }
// 1. 情绪：在全文搜索 /\[情绪[:：]\s*(平常|开心|惊讶|愤怒|思考|悲伤)\s*\]/（取最后一次出现），从 clean 中删除
// 2. 日程：搜索 /\[日程[:：]\s*(\{[\s\S]*?\})\s*\]/，JSON.parse；成功且含非空 title + 可被 dayjs 严格解析的 start → 保留；否则丢弃
// 3. clean 去掉首尾空白与多余空行
```

广播：`broadcastEmotion(key)` → 全窗口 `pet:emotion {emotion:key, source}`。

## C4. 聊天窗（src/renderer/chat/）

结构：顶部标签切换（角色扮演 💬 / 快问 ⚡），中部消息流，底部输入区（textarea 自适应≤150px + 发送/停止按钮 + 当前模型名小字）。两 tab 各自独立历史（`chats/roleplay.json`、`chats/quick.json`，各保留最近 200 条，结构见附录 B）。

**发送流水线（渲染层）**：
1. `launcher:match(text)`（见 C6）：命中 → 本地回复气泡（系统样式：「这就为你打开{label}～」）+ 执行，**不调 LLM**，结束。
2. `/^(提醒我|帮我记一下|记一下|添加日程)/` → `window:open('schedule')` + `schedule:prefill {text}`（F 里程碑实现；C 里程碑先留 TODO 注释并直接走 LLM），结束。
3. 走 LLM：追加用户消息 → 占位气泡（`streaming-cursor` 闪烁光标）→ 订阅 `llm:chunk` 按 chunk 全量重渲染（`md.js`）→ `llm:done` 时以 `parseAndStrip` 的 clean 落盘，emotion 显示为消息角落小圆点图例，schedule 弹确认条。
4. `llm:error` → 红色系统气泡显示中文错误。

**流式 IPC 契约**（tab 维度并发）：`chat:send {tab, text}` → 主进程流式回推 `llm:chunk {tab, reqId, delta}` → 结束 `llm:done {tab, reqId, raw}`（渲染层不解析标签，主进程 done 里已含 `parseAndStrip` 结果：`{clean, emotion, schedule}`，chunk 阶段原样转发 delta）。停止按钮 → `llm:stop {reqId}` → done 以 `aborted:true` 结束，保留半截 +「（已停止生成）」。

**消息操作**：悬停气泡右上角三个小按钮——复制 / 删除单条 / （仅最后一条 AI 消息）重新生成。重新生成 = 删除该条及其后全部 → 重发其前最后一条用户消息（需 confirm：「将删除之后 N 条消息」）。**导出**：顶部菜单按钮把当前 tab 历史导出 `.md`（`dialog:save-md`）。

**上下文裁剪**：每次请求携带 system + 最近 20 条消息（含历史 emotion 剥离后的 clean 文本）；估算 tokens（CJK≈0.5 token/字，其他≈0.25）> 6400 时再砍一半并 toast 提示。

## C5. 记忆系统（主进程 chat 流程内）

- 触发：角色扮演 tab 每条回复完成后 1s，统计「上次提取时间戳之后的用户消息数」≥10 → 提取最近 20 条消息（`用户: …\nAI: …` 格式）→ `genericCompletion(memoryExtractPrompt)` → `match(/\[[\s\S]*\]/)` 抢救 → 逐条校验 type/content/importance 落盘 `memory/roleplay.json`。
- 失败/空结果 → 正则兜底：`/(我是|我叫|我喜欢|我讨厌|我生日|我在?做)(.{2,20})/` 命中存一条 importance 2 的 fact；再不行存一条 `{「进行了N轮对话」event,2}`。
- 上限 50 条：超限按 importance 升序 → createdAt 升序淘汰。
- 注入：system 组装时取 importance 降序前 10 条。快问 tab **不使用**记忆。

## C6. 启动器（src/main/services/launcher.js）

- `match(text)`：`/^(打开|启动|运行|开启|开一下)(一下)?\s*(.{1,24})[。!！]?$/` 捕获目标词 → 与 `commands.json` 匹配：①指令词全等 ②指令词包含目标词或目标词包含指令词（取最长命中）。返回 `{hit:true, label, phrase}` 或 `{hit:false}`。
- `run(phrase)` 按路径后缀分发：`.exe` → `child_process.spawn(path, args? , {detached:true, shell:false})`；`.bat/.cmd` → `spawn('cmd.exe', ['/c', path], {detached:true})`；`.html/.htm/.url` → `shell.openExternal(file:/// 绝对路径或 http url)`；其他 → `shell.openPath`。启动失败（ENOENT 等）→ 抛中文错误 toast。
- 右键菜单「快捷打开」子菜单：`commands.json` 前 10 条直接列出（B 里程碑菜单的扩展项，本里程碑接线）。

## C7. 聊天内日程确认条（渲染层 chat）

`llm:done` 返回 `schedule` 非空时，在该 AI 消息下方渲染确认条：

```
📅 检测到日程：{title} · {start 格式化为 "M月D日 HH:mm"}   [ 加入日程 ] [ 忽略 ]
```

点「加入」→ `schedule:add {draft}`（F 里程碑接口，本里程碑先实现 UI + 调用占位：接口不存在时 toast「日程功能将在后续里程碑启用」——**按此实现，F 里程碑回来接线**）。点「忽略」收起。同一 schedule 只弹一次。

## 验收（里程碑 C）

- [ ] 未配置 API 时发消息 → 中文引导气泡；配置后角色扮演流式输出、光标闪烁、自动滚动
- [ ] 回复末尾 `[情绪:开心]` 被剥离，宠物窗表情实时切换；标签缺失时不报错、表情保持
- [ ] 停止：半截内容保留并标注；重新生成：确认后删除其后消息并重流式
- [ ] 快问 tab：问「Electron 是什么」得到简洁直答，无人设剧情腔；两 tab 历史互不串
- [ ] 设置指令「打开记事本」→ `C:\Windows\notepad.exe`，聊天输入「打开记事本」本地秒回并拉起进程（断网也行）
- [ ] 连发 10+ 条用户消息后检查 `memory/roleplay.json` 出现提取结果；新会话中 system 含记忆段
- [ ] 聊天说「明天下午3点开会」→ AI 回复后出现日程确认条；「忽略」不产生副作用
