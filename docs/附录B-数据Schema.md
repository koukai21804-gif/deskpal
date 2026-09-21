# 附录 B · 数据 Schema（as-built）

全部位于 `%APPDATA%/deskpal/`。配置读写统一经 `store.js`（默认值深合并 + 防抖原子写）；自由 JSON（books/library/activity）用 `readJSON/writeJSON`。

## config/settings.json
```json
{
  "windows": { "pet": {"x":1,"y":1}, "chat": {"x":1,"y":1,"width":900,"height":680} },
  "theme": { "accent": "#7DBE3C", "mode": "light|dark|system" },
  "pet": { "bubbleSeconds": 6, "scale": 1, "sleep": false },
  "activity": { "paused": false, "idleThresholdSec": 180, "windowPollMs": 1000, "idlePollMs": 5000 },
  "schedule": { "leadEvent": 60, "leadStart": 5, "leadDeadline": 120, "snoozeMin": 10,
                "sound": true, "systemNotification": true, "catchupHours": 24 },
  "agent": { "enabled": true, "maxRounds": 8, "permissionTimeoutSec": 120, "permissionMode": "read|userData|full" }
}
```
`agent`（★H as-built）：Agent 执行总开关 / 最大决策轮次（clamp 4–16）/ 权限卡超时秒（clamp 60–300，超时按拒绝）/ **文件权限三档**：
`read`=只读（write 工具不下发，幻觉调用兜底拦截）；`userData`=可编辑（数据目录子树直写，无逐次卡）；`full`=完全编辑（本机大部分目录可写——核心系统目录/其他用户目录/敏感文件/盘根文件/UNC 除外，逐次权限卡）。默认 `read`。聊天窗输入区与设置页 API tab 均可切换（对下一次任务生效）。

## config/persona.json
`pet`: name/tagline/appearance/personality/speechStyle/catchphrases/background/emotionalPatterns/taboos/thinkingLogic/customPrompt/language；`user`: name/description。全部可空（prompt 组装时省略）。

## config/api.json
`endpoint/model/apiKeyEnc(base64 的 safeStorage 密文)/params{temperature,maxTokens,topP,frequencyPenalty,presencePenalty}`。渲染层读取时 apiKeyEnc 剥离，仅见 hasKey。
`toolsStreamBroken`（★H as-built）：布尔，网关不支持 stream+tools 返回 400 时置 true，此后工具决策轮自动降级非流式。

## config/commands.json
`{ commands: [{id, phrase, path, args}] }`

## config/categories.json
`{ categories:[...], rules:[{regex, category}], ignore:[exe...], appLabels:{exe: category} }`

## config/sprites.json
`{ slots: { normal|happy|surprised|angry|thinking|sad: {mode:"svg"} | {mode:"image", file:绝对路径} } }`（图片实体在 `sprites/`）

## config/pets.json（宠物设定档案：人设+形象绑定）
`{ profiles: [{ id:"pet_...", name≤20字, persona:（同 persona.json 全量快照）, sprites:（同 sprites.json）, petScale,
  createdAt, updatedAt }] }`
导出文件 `.pet.json`：`{ app:"deskpal", type:"pet-profile", version:1, name, exportedAt, persona, petScale,
  sprites:{ slots:{ 各表情: {mode:"svg"} | {mode:"image", mime, data:base64} } } }`

## chats/roleplay.json · chats/quick.json
`{ messages: [{id, role:user|assistant, content, emotion?, beats?, schedule?, aborted?, at}], lastExtractAt, userCountSince }`（保留最近 200 条）
`beats`（★H as-built）：`[{s:句序, e:"happy|…|sad"}]` 表情逐句节拍，正文中的短标签已剥离；旧消息无此字段照常渲染。
注：agent run 的步骤时间线/diff 数据只存 `agent/runs.jsonl`，不进 chats（渲染层会话内展示、存盘时剥离）。

## agent/runs.jsonl（★H as-built）
每行一 run（追加式；收尾按 id 替换该行原子重写；启动时 `status:"running"` 改标 `interrupted` 并原子重写，保留最近 500 条；写记录的只有主进程）：
```json
{ "id": "run_...", "reqId": "chat_...", "at": "ISO",
  "instruction": "用户原话", "mode": "read|userData|full",
  "steps": [ {"kind":"llm","round":1,"finishReason":"tool_calls"},
             {"kind":"progress","phase":"设计|发现|能力|验证","text":"…"},
             {"kind":"tool","tool":"write_file","summary":"temp/todo.md 120B","ok":true},
             {"kind":"permission","requestId":"…","decision":"allow_once|deny|timeout|stopped"},
             {"kind":"notice","notice":"retry","text":"检测到未执行工具即声称完成，自动重试一轮（1/1）"} ],
  "changed": [ {"path":"绝对路径","kind":"create|overwrite","origin":"tool|ambiguous",
                "before":{"size":0,"mtimeMs":0},"after":{"size":120,"mtimeMs":0},
                "hunks":[{"aStart":0,"aLines":[],"bStart":1,"bLines":["- 买牛奶"]}],
                "truncated":false, "note":"仅原文件不可读时出现"} ],
  "finalReply": "clean 文本", "retries": 0,
  "status": "running|done|aborted|error|denied|interrupted", "error": "仅 status=error 时" }
```
`status=denied`：全部写尝试均被用户拒绝且无任何成功写入时收尾。

## memory/roleplay.json
`{ items: [{type: relationship|event|fact|preference, content≤40字, importance 1-5, createdAt}] }`（上限 50，重要性升序淘汰）

## activity/YYYY-MM-DD.jsonl
每行一事件：`{type:"app", app, exe, title, start(ms), end(ms), dur(ms)}` 或 `{type:"afk", start, end, dur}`

## books/{bookId}.json
`{ id, meta:{fileName,format,pages,chars,truncated,title}, text, createdAt }`

## library/{bookId}.json
`{ id, title, meta, status: parsed|generating|ready|error, error, outline:[{id,title,summary,keyPoints[],mood,quizIntent}], sections, frames:[{id,type:dialogue|quiz,sectionId,mood,text?,bb,q?,options?,correct?,feedback?}], qa:[{q,a,at,atFrame}], cursor: frameId|null, createdAt, updatedAt }`

## schedule/events.json
`{ version:1, events: [{ id:"evt_时间戳_rand", kind:"event|task", title, notes,
  start: ISO|null, end: ISO|null, deadline: ISO|null, durationMin, remindPreset: event|start|deadline|none,
  reminders: [{id:r1.. , at: ISO, label, kind: lead|atstart|atdeadline, status: pending|fired|missed|cancelled, firedAt, snoozedTo, snoozeCount}],
  status: pending|done|cancelled, source: nl|chat|excel|manual, groupId, createdAt, updatedAt, doneAt }] }`
