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
                "sound": true, "systemNotification": true, "catchupHours": 24 }
}
```

## config/persona.json
`pet`: name/tagline/appearance/personality/speechStyle/catchphrases/background/emotionalPatterns/taboos/thinkingLogic/customPrompt/language；`user`: name/description。全部可空（prompt 组装时省略）。

## config/api.json
`endpoint/model/apiKeyEnc(base64 的 safeStorage 密文)/params{temperature,maxTokens,topP,frequencyPenalty,presencePenalty}`。渲染层读取时 apiKeyEnc 剥离，仅见 hasKey。

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
`{ messages: [{id, role:user|assistant, content, emotion?, schedule?, aborted?, at}], lastExtractAt, userCountSince }`（保留最近 200 条）

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
