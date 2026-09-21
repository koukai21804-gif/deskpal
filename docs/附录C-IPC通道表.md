# 附录 C · IPC 通道表（as-built）

实现位置：主进程 `src/main/ipc.js`（invoke 路由）与 `src/main/preload.js`（`window.deskpal` 白名单暴露 + 推送订阅）。渲染层经 `common/ipc.js` 薄封装调用。

## invoke 通道（请求-响应；失败抛中文 userMsg）

| 通道 | 参数 → 返回 |
|------|------------|
| window:open / window:close | {name} |
| window:minimize | （最小化调用方窗口） |
| window:pet-menu | 光标处弹出宠物菜单 |
| window:settings-tab | {tab} 打开设置页并切标签 |
| pet:drag | {phase:start\|move\|end, dx, dy} 宠物窗手动拖拽（贴边吸附 4px） |
| pet:emote | {emotion, source, revertMs} 渲染层驱动宠物表情（陪读放映） |
| store:get | {name} → 数据（api 额外脱敏） |
| store:set | {name, patch} → 合并后数据；广播 settings:changed |
| theme:get / theme:set / theme:presets | 主题读取/设置/预设列表 |
| prompt:preview | → roleplay system prompt 原文（人设页预览） |
| api:save-key | {key} → safeStorage 加密落盘 |
| dialog:pick-file | {title, filters, multi} → 路径/数组/null |
| dialog:save-text | {defaultName, content} → 保存路径/null |
| shell:open-external / open-path / show-in-folder | {url}/{path} |
| app:info / app:ding | 版本与数据目录 / ding.wav data URL |
| llm:test | → {ok, latencyMs\|error} |
| chat:send | {tab, text} → {reqId}（流式经 llm:chunk/done/error） |
| chat:stop / llm:stop | {reqId}（★H as-built：chat:stop 先 llm.stop 停源头，再 loop.abortRun 排干下游——世代号+1/权限按停/diff 如实收尾） |
| chat:history / save-history / export | 历史读/整体覆盖/导出 md |
| launcher:match | {text} → {hit, id, label}（"打开X"本地匹配） |
| launcher:run / list / save | 按 id 启动 / 清单 / 保存 |
| sprites:get / upload / reset | 差分图映射 / {emotion, path} 复制入 sprites / 恢复 SVG |
| reader:upload | {path} → {bookId, meta}（解析+建库） |
| reader:list / load / delete | 书库 |
| reader:generate / cancel-generate | 启动两阶段生成（进度经 reader:progress）/ 取消 |
| reader:save | {bookId, patch}（cursor/qa 落盘） |
| reader:ask / qa-stop | {bookId, question} → {reqId}（侧信道问答） |
| time:stats | {range: today\|week} → 聚合 JSON |
| time:unknown-apps / label-save | 未知应用清单 / 标注保存 |
| time:report / report-stop | AI 报告流式（report:chunk/done） |
| time:paused / set-paused / open-label | 监测开关与标注窗 |
| schedule:parse | {text} → {understood, draft?\|question?} |
| schedule:add / update / delete / done | 事件 CRUD（update 重建未触发 reminders） |
| schedule:list | 全部事件 |
| schedule:snooze / dismiss | {eventId, reminderId} |
| schedule:excel-parse | {path} → {sheetNames, cols, rows} |
| schedule:excel-decompose | {cols, rows} → {tasks[]}（LLM 拆解+校验） |
| schedule:excel-import | {tasks} → {imported, groupId} |
| schedule:prefill | {text} 打开日程窗并自动执行解析 |
| agent:tools | 工具注册表清单（read_file/list_dir/write_file，H 起全部启用） |
| agent:permission-resolve | ★H as-built：{requestId, decision: allow_once\|deny} → 权限卡裁决（超时/停止按 deny/stopped） |
| agent:runs | ★H as-built：{limit?} → {runs:[…]} 倒序 run 台账（中断提示条/回看） |

## 推送通道（主→渲染，preload `dp.on(channel, cb)` 白名单订阅）

| 通道 | 载荷 |
|------|------|
| theme:changed | {accent, accentFg, mode} |
| settings:changed | {name} 或 {tab}（打开设置页指定标签） |
| sprites:changed | 差分图变更 → 宠物窗重渲染 |
| pet:emotion | {emotion, source, revertMs} |
| pet:bubble | {kind: text\|ask-label\|schedule-card\|perm-ask, text, …}（★H as-built 新增 perm-ask：写权限批准气泡，「去批准」聚焦聊天窗，20s 自动消失） |
| pet:sleep | {on} |
| pet:ding | 播放提示音 |
| llm:chunk / llm:done / llm:error | {tab, reqId, delta, beat?} / {tab, reqId, clean, emotion, beats?, schedule, aborted, runId?, changes?, msgId?} / {tab, reqId, error}。★H as-built：chunk 载荷新增 `beat`（节拍 hint，随正文同帧推送供渲染层按句触发宠物表情）；done 载荷新增 `beats`（句序节拍表）、`runId`、`changes`（agent run）、`msgId`（主进程消息 id，渲染层用于刷新后保持本地附加数据） |
| agent:step | ★H as-built：{tab, reqId, kind: progress\|tool\|permission\|notice, phase?, tool?, summary?, ok?, notice?, text?} → 聊天窗步骤时间线（kind llm 只进台账不上时间线；notice 用于假完成重试提示） |
| agent:permission | ★H as-built：{tab, reqId, request:{id,runId,tool,action,scopePaths,detail,reason,reversibility,options:[allow_once,deny],createdAt,timeoutSec}} / 终态 {requestId, decision: allow_once\|deny\|timeout\|stopped, final:true, note?} |
| agent:artifact | ★H as-built：{tab, reqId, changed:[{path,kind,origin,before,after,hunks,truncated?,note?}]} → diff 卡（快照实测，非模型自述） |
| agent:done | ★H as-built：{tab, reqId, runId, aborted, changes}（run 收尾；停止时已发生的写入如实带出） |
| reader:progress | {bookId, stage, pct, message} |
| reader:qa-chunk / qa-done | 举手提问流式 |
| report:chunk / report:done | AI 时间报告流式 |
| schedule:remind | {eventId, reminderId, title, label, kind, timeText, nth, event} → 宠物提醒卡 |
| schedule:catchup | {items[]} 错过提醒汇总 |
| schedule:changed / schedule:prefill | 列表变更刷新 / 速添预填 |
| activity:idle-back | {unknownCount} |
| time:changed | 统计刷新 |
