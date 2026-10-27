// en 词典（公共层）：ui.js 的确认框/弹窗 chrome、共享标题栏、fmtMin 时长格式。
// 约定：key=中文原文（动态串为带 {0}{1} 占位的模式），value=英文；由 scripts/test-i18n.js
// 校验跨文件 key 无重复、占位符两侧一致。classic script 挂 globalThis.DP_I18N_EN，
// 先于各窗 <script type="module"> 执行；主进程经 src/main/services/i18n.js require 复用。
(function (g) {
  g.DP_I18N_EN = Object.assign(g.DP_I18N_EN || {}, {
    // 确认框 / 弹窗 chrome（common/ui.js）
    '确认': 'Confirm',
    '确定': 'OK',
    '取消': 'Cancel',
    '关闭（Esc）': 'Close (Esc)',
    // 共享自绘标题栏（common/windows/titlebar.js）
    '最小化': 'Minimize',
    '关闭': 'Close',
    // fmtMin（common/ipc.js）
    '{0} 分钟': '{0} min',
    '{0} 小时 {1} 分': '{0} h {1} min',
    '{0} 小时': '{0} h',
    // 跨窗口共享：表情标签（chat/settings/pet）
    '平常': 'Calm', '开心': 'Happy', '惊讶': 'Surprised', '愤怒': 'Angry', '思考': 'Thinking', '悲伤': 'Sad',
    // 跨窗口共享：通用动作
    '删除': 'Delete', '保存': 'Save', '已保存': 'Saved', '添加': 'Add', '恢复默认': 'Reset to default',
    '全部': 'All', '今日': 'Today', '本周': 'This week', '本月': 'This month',
    '已导出：{0}': 'Exported: {0}', '分钟': 'min',
    '失败：': 'Failed: ', '失败：{0}': 'Failed: {0}',
    '权限': 'Permission', '角色扮演': 'Roleplay',
    '缇托': 'Titor', '缇托·诺蕾姬': 'Titor Knowledge',
    // 跨窗口共享动作/标签（chat+reader+schedule+pet/settings 多窗共用）
    '重新生成': 'Regenerate', '恢复': 'Restore', '查看': 'View', '查看进度': 'View progress',
    '手动': 'Manual', '事件': 'Event', '完成': 'Done', '已完成': 'Done',
    '会话': 'Sessions', '失败': 'Failed', '5h': '5h',
    '{0}月{1}日 {2}:{3}': '{1}/{0} {2}:{3}',
    '我的头像': 'My avatar', '图片': 'Images', '文档': 'Documents', '视频': 'Videos',
    '聊天': 'Chat', '一句话': 'One-liner', '工作日': 'Weekdays',

    // ---- 主进程产出（agent 时间线 notice / 权限卡 / demo 回执 / OS 通知 / 对话框 / 会话默认名）----
    // loop.js notices
    '工具上下文超出预算（{0} est-token），最老的工具结果已压缩为回执（需要时可重读）': 'Tool context exceeded budget ({0} est-tokens); the oldest tool results were compacted into receipts (re-read them if needed)',
    '上下文超出模型窗口，第 {0} 级压缩后续跑': 'Context exceeded the model window — continuing after stage-{0} compaction',
    '（已先固化记忆）': ' (memory flushed first)',
    '响应流中途断开，继续任务（{0}/2）': 'Response stream cut off mid-way — continuing ({0}/2)',
    '响应流中途断开且正文已送达（{0}），如实收尾': 'Response stream cut off after the text had arrived ({0}) — closing out honestly',
    '输出被 max_tokens 截断，工具调用未执行，重试（{0}/2）': 'Output truncated by max_tokens, tool calls not executed — retrying ({0}/2)',
    '检测到声称已写入但没有成功写入记录，自动重试一轮（1/1）': 'Claimed a write with no successful write on record — one automatic retry (1/1)',
    '检测到声称已读取但没有任何成功的文件读取，自动重试一轮（1/1）': 'Claimed a read with no successful file read on record — one automatic retry (1/1)',
    '检测到声称已检索但没有任何成功的联网检索，自动重试一轮（1/1）': 'Claimed a search with no successful web search on record — one automatic retry (1/1)',
    '检测到未执行工具即声称完成，自动重试一轮（1/1）': 'Claimed completion without executing any tool — one automatic retry (1/1)',
    '（已拒绝）': ' (denied)',
    // 写权限卡（loop.js）
    '追加文件': 'Append to file', '覆盖文件': 'Overwrite file', '新建文件': 'Create file',
    '{0}，{1} 字节，{2}': '{0}, {1} bytes, {2}',
    '追加到已有文件末尾': 'append to the existing file', '覆盖已有文件': 'overwrite the existing file', '新建': 'new file',
    '在已有文件末尾追加（diff 卡可见）': 'Appends to the end of the existing file (visible on the diff card)',
    '覆盖已有文件（原内容不自动保留，diff 卡可见）': 'Overwrites the existing file (previous content is not kept automatically; visible on the diff card)',
    'temp 内新建（可删）': 'Created inside temp (deletable)',
    // 视觉授权卡（vision-capture.js）
    '自主截取桌面': 'Autonomous desktop capture', '开启桌面查看（截屏识别）': 'Enable desktop viewing (screenshot recognition)',
    '开启后可截取桌面画面交给你配置的模型服务商识别；可在 设置→API 关闭': 'Once enabled, desktop screenshots are sent to your configured model provider for recognition; turn off anytime in Settings → API',
    '仅截取一帧，不落盘': 'Captures one frame only, never persisted',
    '设置→API 一键关闭（关闭即时生效）': 'One click off in Settings → API (effective immediately)',
    '桌面查看已开启，可在 设置→API 关闭': 'Desktop viewing enabled — turn it off in Settings → API',
    '开启摄像头拍一帧': 'Take one camera frame',
    '开启摄像头拍摄一帧当前实景，交给你配置的模型服务商识别；拍完立即关闭摄像头，不留任何影像': 'Takes one frame of the live scene and sends it to your configured model provider for recognition; the camera closes immediately after — no imagery is kept',
    '拍完即关（画面不落盘），不拍摄即无任何采集': 'Camera closes right after the shot (nothing persisted); without a shot there is no capture at all',
    // 联网搜索授权卡（net-search.js）
    '开启联网搜索': 'Enable web search',
    '检索词「{0}」；开启后可随时在 设置→联网搜索 关闭': 'Query "{0}"; once enabled, turn it off anytime in Settings → Web search',
    '设置页一键关闭（关闭即时生效）': 'One click off in Settings (effective immediately)',
    '联网搜索已开启，可在设置→联网搜索 关闭': 'Web search enabled — turn it off in Settings → Web search',
    '自主联网检索': 'Autonomous web search',
    '仅查询不落盘，账本面板可划除该条': 'Query only, nothing persisted; the entry can be struck in the ledger panel',
    // 演示模式（demo-mode.js，toast 回执）
    '不是演示模式命令': 'Not a demo-mode command',
    '调速失败：速度必须是 {0}-{1} 之间的整数（每分钟显示字数）。示例：/demo speed -150': 'Speed change failed: must be an integer between {0}-{1} (chars per minute). Example: /demo speed -150',
    '打字机速度已设为每分钟 {0} 字（全局生效，重启后保持）': 'Typewriter speed set to {0} chars/min (global, kept across restarts)',
    '调速失败：{0}。示例：/demo speed -150': 'Speed change failed: {0}. Example: /demo speed -150',
    '当前不在演示模式中': 'Demo mode is not on',
    '已退出演示模式（本次共 {0} 轮）': 'Exited demo mode ({0} rounds this time)',
    '演示模式：开启中，已持续 {0} 轮（打字机 {1} 字/分钟）；退出用 /demo off': 'Demo mode: on, {0} rounds so far (typewriter {1} chars/min); type /demo off to exit',
    '演示模式：未开启（打字机速度 {0} 字/分钟已记忆）': 'Demo mode: off (typewriter speed {0} chars/min remembered)',
    '已在演示模式中（已持续 {0} 轮）。退出用 /demo off，查看状态用 /demo status': 'Already in demo mode ({0} rounds so far). Type /demo off to exit, /demo status to check',
    '演示模式已开启：主动推进 / 术语必附短解 / 回复提速约 30% / 打字机逐字显示（{0} 字/分钟）。退出用 /demo off': 'Demo mode on: proactive / jargon gets short explanations / ~30% faster replies / typewriter display ({0} chars/min). Type /demo off to exit',
    // OS 通知（main.js / scheduler.js）
    'deskpal · 记忆服务未运行': 'deskpal · memory service not running',
    'Hindsight 语义记忆服务未启动，本次会话将没有深层记忆召回。': 'The Hindsight semantic memory service is not running — this session will have no deep-memory recall.',
    '语义记忆服务已就绪': 'Semantic memory service is ready',
    '（第 {0} 次提醒）': ' (reminder #{0})',
    '现在开始啦': 'Starting now!', '{0} 分钟后开始': 'Starts in {0} min',
    '就是现在截止！': 'Deadline is now!', '{0} 分钟后截止': 'Due in {0} min',
    '马上就开始！': 'Starting any moment!', '还有 {0} 分钟': '{0} min to go',
    // 会话默认名（sessions.js）
    '专项会话 {0}': 'Task session {0}',
    // 宠物设定档案对话框（pets.js）
    '档案不存在或已被删除': 'Profile not found or deleted',
    '导出宠物设定': 'Export pet profile', '导入宠物设定': 'Import pet profile', 'deskpal 宠物设定': 'deskpal pet profile',
    '文件不是合法的 JSON': 'The file is not valid JSON',
    '不是有效的 deskpal 宠物设定文件（需要 .pet.json，v1/v2 均可）': 'Not a valid deskpal pet profile file (.pet.json required; v1/v2 both fine)',
    '导入 v1 单层设定': 'Import a v1 single-layer profile',
    '「{0}」是 v1 单层结构文件': '"{0}" is a v1 single-layer file',
    '分层结果预览：\n· canon 宪法（L1–L4）将以 TITOR-CANON v1.0 默认内容兜底，名字沿用旧档\n· ops 表现层（外貌/口头禅/表层性格等）原样保留旧档内容\n· 导入后可在人设页查看，宪法修改走批准通道\n\n确认导入？': 'Layering preview:\n· The canon constitution (L1–L4) will fall back to the TITOR-CANON v1.0 defaults; the name is kept\n· The ops presentation layer (looks/catchphrases/surface personality) is kept as-is\n· After import, view it on the Persona tab; constitution edits go through the approval flow\n\nImport?',
    '确认导入': 'Import', '(导入)': '(imported)',
    // 环境语言随界面（scheduler/tracker/video/reading 主进程产出）
    '提前{0}分钟': '{0} min before', '开始': 'Start', '截止': 'Deadline',
    '今天开启的部分应用我不明白是什么类型的，你可以帮我标注一下吗？': 'I could not tell what some of today\'s apps are — could you help me label them?',
    '正在检查 ffmpeg…': 'Checking ffmpeg…', '正在检查 yt-dlp…': 'Checking yt-dlp…',
    '正在读取视频时长…': 'Reading video duration…', '正在下载 MP4…': 'Downloading MP4…',
    '正在下载 MP4… {0}%': 'Downloading MP4… {0}%', '正在读取视频信息…': 'Reading video info…',
    '正在尝试抓取字幕（优先，免转写）…': 'Trying to fetch subtitles (preferred, no transcription)…',
    '字幕抓取成功，正在整理文稿…': 'Subtitles fetched — organizing the transcript…',
    '没有可用字幕，正在下载音频（将语音转写）…': 'No subtitles available — downloading audio for transcription…',
    '正在下载音频… {0}%': 'Downloading audio… {0}%',
    '正在提取音轨（16k 单声道）…': 'Extracting the audio track (16k mono)…',
    '正在语音转写（可能需要几分钟）…': 'Transcribing speech (this may take a few minutes)…',
    '转写完成，正在整理文稿…': 'Transcription done — organizing the transcript…',
    '开始通读《{0}》全文（共 {1} 段）…': 'Reading "{0}" in full ({1} chunks)…',
    '正在通读第 {0}/{1} 段并整理笔记…': 'Reading chunk {0}/{1} and taking notes…',
    '通读完成，我随时可以回答关于这份资料的问题': 'Finished reading — I can answer questions about this material anytime',
    '正在分析全书结构…': 'Analyzing the book structure…',
    '大纲完成：共 {0} 节': 'Outline done: {0} sections',
    '正在编写第 {0}/{1} 节「{2}」的剧本…': 'Writing script for section {0}/{1} "{2}"…',
    '剧本完成，共 {0} 帧': 'Script done: {0} frames total',
    '已取消': 'Cancelled',
    '这一节「{0}」的剧本我演砸了…不过要点是：{1}': 'I fumbled the script for "{0}"… but the key points are: {1}',
    '刚才生成剧本时出了点小差错，我们继续下一节吧！': 'Something went a little wrong generating the script — let us move on to the next section!',
    '（笔记缺失，只能靠原文节选回答）': '(notes missing; answering from text excerpts only)',
    // 窗口标题（渲染层 document.title 映射）
    '聊天 · deskpal': 'Chat · deskpal', '设置 · deskpal': 'Settings · deskpal', '陪读 · deskpal': 'Reading · deskpal',
    '日程 · deskpal': 'Schedule · deskpal', '时间统计 · deskpal': 'Time stats · deskpal', '标注应用 · deskpal': 'Label apps · deskpal',
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
