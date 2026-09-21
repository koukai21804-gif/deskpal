# 附录 D · 验收清单（总验收 as-built）

各里程碑细案文档末尾含分项自检；本文件为整体验收记录（2026-09-16 实施完成时；v0.3 增补见下方里程碑 H 段）。

## 自动化验证（已通过）

- [x] `npm install` 成功；electron/koffi 安装脚本被 allow-scripts 拦截时按 README 手动补跑（本机已补跑成功）
- [x] `node scripts/test-fs-guard.js` → **PASS（18 项）**：读黑名单/写白名单/越界抛错
- [x] `DESKPAL_SMOKE=1` 启动 → 主进程日志出现 `SMOKE OK`，%APPDATA%/deskpal 全目录与默认配置自动生成
- [x] `DESKPAL_SMOKE=full` 打开全部 7 窗口 → 渲染层无 Uncaught/ReferenceError（修复 3 处后清零）
- [x] 文档解析独立脚本：UTF-8/GBK txt、URL/DOI 清洗、过短文件拒绝
- [x] koffi FFI：GetForegroundWindow 返回真实 hwnd

## GUI 实测（已通过，截图留档）

- [x] 宠物窗：SVG 绿球 6 表情正常渲染（径向渐变/分割线/极点凹槽/红竖椭圆眼/微笑/地面阴影）
- [x] 气泡：开机问候台词、点击台词、唤醒台词；睡觉（半垂眼睑+Zzz+气泡清空）↔ 单击唤醒
- [x] 托盘菜单与宠物右键菜单（聊天/陪读/时间统计/日程/换装/设置/休息/退出）可弹出，托盘菜单点击可开聊天窗
- [x] 聊天窗：自绘标题栏、双标签、空状态、输入区、"尚未配置 API"模型提示正确
- [x] 日程页：速添栏（示例占位文案）/三按钮/7 天条/空状态
- [x] 陪读页与设置页：工具栏/空状态/侧边导航+默认人设表单

## 需用户配置 API 后实测（功能已实现，链路待真实 Key 验证）

- [ ] 角色扮演流式输出 + `[情绪:xx]` 驱动表情 + `[日程:{...}]` 确认条入库
- [ ] 陪读两阶段生成 → 放映/测验/举手提问
- [ ] 日程一句话解析入库 + 提醒双通道触发 + Excel 拆解导入 + 稍后提醒 + 重启补报
- [ ] 时间 AI 报告
- [ ] API tab 测试连接（真实 Key）

## 挂机类（逻辑已实现）

- [ ] 空闲 3 分钟归来触发标注询问气泡（每天一次）
- [ ] 拖动宠物重启位置保持

## 打包

- [ ] `npm run make-icon && npm run dist` 出 nsis exe（构建时执行）

## 里程碑 H（v0.3，2026-09-22 实现完成；分项细案见 docs/08 末尾）

### 自动化验证（已通过）

- [x] `node scripts/test-agent.js` → **58 项通过**：progress 剥离器（单 chunk/逐字符跨边界/尾巴保留/flush 残余）、节拍解析（旧格式兼容/按句落位/句中错置/跨 chunk 日程 JSON/同句多标签/超长未闭合放行）、trace（覆盖/新建 LCS diff/ambiguous 归因）、runs（update 按 id 替换/启动标 interrupted）、注册表（write_file 转正/reason 必填/OpenAI schema）
- [x] `node scripts/test-agent-e2e.js` → **37 项通过**（桩 LLM+权限，真实 fs/台账/差分）：写文件全链路（权限卡字段/diff 归因/tool result 回填）、连续拒绝熔断（两次后不再发卡+system 提示+status denied）、假完成一次重试、maxRounds 上限收尾轮不带工具、epoch 打断（onAborted/stale 静默退出/aborted 台账）、fs-guard 越界拒绝不炸 run
- [x] `npm run test:fs-guard` 仍 **PASS（18 项）**
- [x] `DESKPAL_SMOKE=full`（隔离 userData：`DESKPAL_USERDATA=<dir>`）→ `SMOKE OK`，主进程日志 0 ERROR

### GUI 实测（已通过）

- [x] 设置页 API tab「Agent 执行」区块：总开关/最大轮次 4–16/权限超时 60–300s 即时保存
- [x] 聊天窗组件渲染：步骤时间线（progress/tool/permission/notice 混排、llm 轮不上时间线）、权限卡（路径/字节/reason/倒计时/终态文案）、diff 卡（新建/覆盖徽章、增删行着色、ambiguous 黄条）、中断任务提示条（查看详情/重新发起=仅填入输入框）

### 需用户配置 API 后实测（2026-09-22 已用真实 API 实测：DeepSeek / deepseek-flash，`npx electron scripts/test-real-llm.js` 25 项通过 0 失败）

主进程链路（自动化实测已过）：

- [x] roleplay「在数据目录 temp 里建 todo.md」→ 权限卡请求 → 允许 → diff 卡（origin=tool）→ `temp/todo.md` 真实存在 → runs.jsonl 完整（steps：llm→list_dir→[进展:发现]→llm→permission→write_file→[进展:设计/能力/验证]→llm）
- [x] 拒绝路径：权限请求被拒 → 模型收到拒绝 result 并转述 → `status=denied`（连续拒绝熔断由集成测试覆盖）
- [x] 权限卡超时按拒绝（fail-closed，集成测试覆盖；真实 GUI 倒计时待人工确认）
- [x] 任务执行中点停止 → `agent:done{aborted:true}`、onAborted、挂起写入未发生、记录 aborted（T5 实测）
- [x] 假完成重试：真实模型首轮即正常调工具未触发（行为良好）；触发路径由集成测试覆盖、上限 1
- [x] deepseek 决策轮自动关 thinking（H1.8 实测补全：stream+tools 未关 thinking 会挤占输出）
- [x] fs-guard 越界：模型知晓 write_file 权限边界主动说明（guard 拒绝分支由集成测试覆盖，双保险）
- [x] 节拍流式：真实流式输出 3–6 个节拍按句绑定、正文无标签残留、兜底情绪正常（T2 实测）
- [x] 旧格式兼容与 quick 无工具：单元测试覆盖
- [x] GUI 原话复现「帮我在数据目录的 temp 里建一个 todo.md」（模糊指代，不给绝对路径）→ prompt 注入数据目录路径后模型直接写对位置（T8 实测）

GUI 交互层（2026-09-22 CDP 驱动真实 GUI 验证通过；dev 实例隔离目录 %LOCALAPPDATA%/Temp/deskpal-gui-profile）：

- [x] 权限三档选择器：聊天窗输入区 + 设置页 API tab，切换经 store:set 持久化、UI 回显正确（CDP 验证 userData/full 两档）
- [x] 「可编辑」档（userData）：同一句「帮我在数据目录的 temp 里建一个 todo.md」→ 无权限卡直接写入 → temp/todo.md 真实创建（模型自拟四区模板）→ 台账 mode=userData、无 permission 步骤、diff 归因 tool
- [x] 「完全编辑」档（full）：权限卡真实挂载 → 点击「允许一次」→ 主进程日志「点击到达主进程 decision=allow_once」→ 1 秒内结算 → 文件写入（此前用户点击失效的根因：事件载荷缺顶层 reqId 被渲染层守卫静默丢弃，已修复，见 08 差异记录 15）
- [x] 「只读」档（read）：write 工具不下发 + 幻觉调用兜底拦截（e2e 用例 7b）
- [ ] full 档人工点验：卡片倒计时/拒绝路径/宠物「去批准」气泡聚焦
- [ ] 中断提示条：杀 dev 实例重启后「查看 / 重新发起（仅填入输入框）」
- [ ] 长回复节拍驱动宠物表情逐句切换、慢速流式半截标签不泄漏
- [ ] 停止按钮：任务执行中停止 → 「已停止」权限卡 + 已发生写入如实展示
