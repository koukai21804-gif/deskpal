// 内置工具：read_file / list_dir / write_file / save_memory / add_reminder / web_search（文件类经 fs-guard 仲裁）
// write_file 的用户批准由 loop 的权限闸统一拦截（H1.4）；handler 内 fs-guard 校验保留作双保险。
const guard = require('../fs-guard');
const memory = require('../memory');
const scheduler = require('../schedule/scheduler');
const dayjs = require('dayjs');
const fs = require('fs');
const path = require('path');
const tools = require('./tools');
const netSearch = require('./net-search');
const llm = require('../llm');
const hindsight = require('../hindsight-bridge');
const visionCapture = require('./vision-capture');
const avatars = require('../avatars');
const { MAX_FILE_BYTES, MAX_DATAURL_CHARS, sniffMime, probeImage, toDataUrl } = require('./image-utils');

// read_file 分段读取：大文件单段回填会把上下文撑爆，也可能被结果上限截掉而模型不知情。
// 返回体自带已读区间与续读 offset，与 write_file 的分段追加（append:"true"）对称。
// v0.5：默认段 16000→8000——工具轮上下文随轮次线性累积、每轮全量重发（平方税），
// 单段减半 = 每次重发的边际成本减半；RESULT_CAPS.read_file 维持 40000 不动（须容纳
// 32000 的最大段 + 头尾元数据，压它会截掉「续读 offset」提示、破坏分段协议）。
const READ_CHUNK_DEFAULT = 8000;
const READ_CHUNK_MAX = 32000;

tools.register({
  name: 'read_file',
  desc: '读取指定路径的文本文件内容（敏感路径会被拒绝）。大文件分段返回：默认每次 ≤8000 字符；未读完时返回体末尾给出续读 offset，必须继续调用读完全部内容后再下结论',
  params: {
    path: 'string 绝对路径',
    offset: 'string 可选：起始字符位置（0 起）。续读时用上一次返回体提示里给出的 offset',
    length: 'string 可选：本次读取的字符数（≤32000），缺省 8000',
  },
  permission: 'read',
  enabled: true,
  handler: async (args) => {
    const text = String(guard.readFileGuard(args.path, 'utf8'));
    const total = text.length;
    let offset = Math.round(+args.offset);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    if (offset >= total) return `[read_file] ${args.path}｜共 ${total} 字符｜offset ${offset} 已超出文件末尾，无内容返回`;
    let length = Math.round(+args.length);
    if (!Number.isFinite(length) || length <= 0) length = READ_CHUNK_DEFAULT;
    length = Math.min(length, READ_CHUNK_MAX);
    const slice = text.slice(offset, offset + length);
    const end = offset + slice.length;
    const head = `[read_file] ${args.path}｜共 ${total} 字符｜本次返回第 ${offset}–${end} 字符`;
    const tail = end < total
      ? `\n\n【未读完：还剩 ${total - end} 字符。继续读取请再次调用 read_file，参数 {"path":"${args.path}","offset":${end}}；读完全部内容前不要对文件下结论】`
      : '\n【已到文件末尾】';
    return `${head}\n${slice}${tail}`;
  },
});

// read_image：图片文件的视觉读取（多模态模型专用）。OpenAI 协议里 tool 消息的 content
// 必须是字符串，图像无法挂在 tool result 上——所以 handler 返回 {text, imagePart, meta}，
// 由 loop 把回执写进 tool 消息、把图像以 user 消息的 image_url 部分紧随其后注入视觉上下文。
// 未配多模态模型时本工具不下发 schema（loop 侧按 isVisionCapable 过滤），此处兜底闸防幻觉调用。
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
tools.register({
  name: 'read_image',
  desc: '读取图片文件并把图像送入你的视觉上下文（识别/描述/提取截图、照片、扫描件、图表中的内容）。支持 png/jpg/jpeg/gif/webp/bmp；超过 8MB 的图会被拒绝。文本文件请用 read_file',
  params: {
    path: 'string 图片文件的绝对路径',
  },
  permission: 'read',
  enabled: true,
  handler: async (args) => {
    const p = String(args.path || '').trim();
    if (!p) throw new Error('缺少必填参数 path（图片绝对路径）');
    if (!llm.isVisionCapable()) {
      throw new Error('当前模型未开启图像识别：请到 设置→API→「图像识别」选「强制开启」（模型须支持图像输入），或更换多模态模型');
    }
    const ext = path.extname(p).toLowerCase();
    if (!IMAGE_EXTS.includes(ext)) {
      throw new Error(`不是图片文件（支持 ${IMAGE_EXTS.join(' ')}）；文本文件请用 read_file 读取`);
    }
    if (!guard.canRead(p)) throw new Error('没有权限读取该图片（敏感路径或不存在）');
    let st;
    try { st = fs.statSync(p); } catch (_) { throw new Error('图片不存在或无法访问：' + p); }
    if (!st.isFile()) throw new Error('该路径不是文件');
    if (st.size > MAX_FILE_BYTES) {
      throw new Error(`图片超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB（实际 ${(st.size / 1024 / 1024).toFixed(1)}MB），请先压缩或缩小尺寸后再试`);
    }
    let buf;
    try { buf = fs.readFileSync(p); } catch (e) { throw new Error('图片读取失败：' + e.message); }
    const sniffed = sniffMime(buf);
    if (!sniffed) throw new Error('文件内容不是可识别的图片格式（扩展名与实际内容不符，或文件已损坏）');
    const probe = probeImage(buf, sniffed);
    const dataUrl = toDataUrl(probe.mime, probe.buf);
    if (dataUrl.length > MAX_DATAURL_CHARS) {
      throw new Error('图片编码后超出接口体积上限，请换更小的图');
    }
    const dims = probe.width ? `${probe.width}×${probe.height}` : '尺寸未知';
    return {
      ok: true,
      text: `[read_image] ${p}｜${sniffed}${probe.resized ? `（已自动缩放至 ${dims}）` : `｜${dims}`}｜${probe.buf.length} 字节｜图像已注入视觉上下文：请基于图像实际内容作答，图中没有的信息不要编造`,
      imagePart: { type: 'image_url', image_url: { url: dataUrl } },
      meta: { path: p, bytes: probe.buf.length, width: probe.width, height: probe.height, mime: probe.mime, resized: !!probe.resized },
    };
  },
});


// look_user_avatar：读取对话对象在设置里上传的头像（v0.6）。
// 与 read_image 同协议：{text, imagePart, meta}，图像由 loop 以 user 消息注入视觉上下文。
// 不需要权限卡——那是用户自己主动上传、明确用于让角色看到的图片。
tools.register({
  name: 'look_user_avatar',
  desc: '读取对话对象（用户）上传的头像并把图像送入你的视觉上下文。用户让你「看看我的头像」「我长什么样（指头像）」「我换头像了」时调用；用户没上传头像时工具会如实报错。不要凭空描述用户的长相，也不要把头像里没有的信息当成事实',
  params: {},
  permission: 'read',
  enabled: true,
  handler: async () => {
    if (!llm.isVisionCapable()) {
      throw new Error('当前模型未开启图像识别：请到 设置→API→「图像识别」选「强制开启」（模型须支持图像输入），或更换多模态模型');
    }
    const av = avatars.readUserImage();
    if (!av) {
      throw new Error('用户尚未上传头像：可在 设置→人设→对话对象（user 层）上传图片后再试');
    }
    const probe = probeImage(av.buf, av.mime);
    const dataUrl = toDataUrl(probe.mime, probe.buf);
    if (dataUrl.length > MAX_DATAURL_CHARS) {
      throw new Error('头像编码后超出接口体积上限，请换一张更小的图');
    }
    const dims = probe.width ? `${probe.width}×${probe.height}` : '尺寸未知';
    return {
      ok: true,
      text: `[look_user_avatar] 用户上传的头像｜${probe.mime}｜${dims}｜${probe.buf.length} 字节｜图像已注入视觉上下文：请基于图像实际内容作答（可描述画面/风格/角色特征），图中没有的信息不要编造`,
      imagePart: { type: 'image_url', image_url: { url: dataUrl } },
      meta: { tool: 'look_user_avatar', path: av.file, bytes: probe.buf.length, width: probe.width, height: probe.height, mime: probe.mime, resized: !!probe.resized },
    };
  },
});

// look_screen：桌面截屏识别（v0.5.1，方案借鉴 Amadeus System capture_screen.py）。
// 截屏前隐藏 deskpal 自身窗口、黑帧校验、前台窗口标题回传；授权走 web_search 同款双轨
// （未开启：designated 弹开启卡 / autonomous 直接拒；已开启：autonomous 逐次卡）。
// 回执结构与 read_image 相同（{text, imagePart, meta}），loop 按 imagePart 通用注入。
tools.register({
  name: 'look_screen',
  desc: '截取当前桌面画面并送入你的视觉上下文（识别屏幕上正在显示的内容）。用户明确让你看屏幕/桌面时才调用（如「看看我屏幕上这个」「桌面上这个报错是什么」）；比喻性的「你看」「你猜我看到了什么」不是截屏请求，此前看过的画面凭上下文回忆即可、不要重复截屏。多屏用 screen 指定序号（0=主屏）。截屏画面会发送给你配置的模型服务商做识别',
  params: {
    screen: 'string 可选：屏幕序号（0=主屏，1=副屏…），缺省主屏',
    track: 'string designated=用户明确要求看屏幕（默认）/autonomous=你主动想看（须用户逐次批准）',
    reason: 'string ≤60字：为什么需要看屏幕（两种轨道都必填）',
  },
  permission: 'read',
  enabled: true,
  handler: async (args, ctx) => visionCapture.lookScreen(args, ctx),
});

// look_camera：开启摄像头拍一帧识别（v0.5.1，方案借鉴 Amadeus System capture_camera.py）。
// 感知纪律（camera_sensitive）：每次调用都先向用户弹授权卡，批准后才开摄像头，拍完即关；
// 不设「永久开启」记忆，被拒后 60s 冷却内不再弹卡——不默认开摄像头、不持续观看。
tools.register({
  name: 'look_camera',
  desc: '开启摄像头拍摄一帧当前实景并送入你的视觉上下文。仅当用户明确要求看镜头前的实景时才调用（如「开摄像头看看我」「看看我这边/镜头前这个」）；比喻性或泛指的「看」不是摄像头请求，你和用户之间的普通对话也用不着它。每次调用都会先向用户弹授权卡；拍完立即关闭摄像头，不会持续观看。画面会发送给你配置的模型服务商做识别',
  params: {
    camera: 'string 可选：摄像头序号（从 0 起），缺省第 0 个',
    reason: 'string ≤60字：为什么需要开摄像头（必填）',
  },
  permission: 'read',
  enabled: true,
  handler: async (args, ctx) => visionCapture.lookCamera(args, ctx),
});

// save_memory：角色的真实长期记忆写入（写应用记忆库 memory/roleplay，非文件系统，
// 不属于文件权限管辖，任何模式可用）。「记下了/写进长期记忆」的承诺由此真实落地；
// 与自动提取/手动面板共用同一份存储与淘汰规则（scope 三态 + 上限 50 淘汰归档）。
tools.register({
  name: 'save_memory',
  desc: '把值得长期记住的信息写入你的长期记忆。用户明确要求「记住…/写进长期记忆/记一下」时必须实际调用本工具——只在正文里说「记下了」不算数；自己固化关于用户的长期性结论（核心偏好/重要事实）时也可主动调用。宁缺毋滥：≤60字/条，只存长期有效的关键信息，不存闲聊细节',
  params: {
    content: 'string 记忆内容（≤60字，一条只写一个要点；与已有条目同主题就重写那条的完整新描述，不要另记一条）',
    importance: 'string 可选：重要性 1-5，默认 3（5=核心偏好/身份事实，1=琐碎）',
    type: 'string 可选：fact/preference/event/relationship，默认 fact',
    scope: 'string 可选：core=身份级长期认知（总量有 1000 字硬上限，满了会被降级为 working 并在回执注明）/working=滚动工作记忆（默认）/ephemeral=带过期的事件记录（默认 14 天）。只有你非常确定长期有效的内容才用 core',
  },
  permission: 'read',
  enabled: true,
  handler: async (args) => {
    // 演示模式轮的写入带 demo 来源标记（v0.6.2，事后审计用）——save_memory 只发生在
    // 进行中的轮次里，写入时的演示状态即该轮状态
    const demoMode = require('../demo-mode');
    const item = memory.addMemory({ content: args.content, importance: args.importance, type: args.type, scope: args.scope, ttlDays: args.ttlDays }, { demo: demoMode.isOn() });
    // Hindsight 双写（M3）：core 条目结构性跳过（评审 §6.2 物理隔离）
    if (item.scope !== 'core') {
      hindsight.retain([{ content: item.content, context: 'deskpal-save-memory', metadata: { type: item.type, importance: String(item.importance) } }], { source: 'deskpal-save-memory' }).catch(() => {});
    }
    const scopeTxt = item.scope === 'core' ? 'core·身份级' : item.scope === 'ephemeral' ? `ephemeral·${item.ttlDays}天` : 'working·滚动';
    const tail = item.note ? `。注意：${item.note}` : item.merged ? '（与已有条目同文，已合并更新而非新增）' : '';
    return `已写入长期记忆（${item.type}｜${scopeTxt}｜重要性${item.importance}）：${item.content}${tail}`;
  },
});

// noreki_send：NOREKI-Mail 发信（v1.5.1，TTR-0JQC45-R1 验收提出的结构性缺口——
// 「发信侧在我这边还没有落点」）。给缇托的 agent 一个真实发信通道：签名、落 outbox、
// 写 sent 账本全在 services/noreki-link 内完成。仅戏外工作轮下发（同 add_reminder，
// 不进 ROLEPLAY_TOOLS 白名单），避免戏内角色扮演误发信。信件正文由模型撰写，收件人
// 固定 clio@hermes（本工具不发第三方）。
tools.register({
  name: 'noreki_send',
  desc: '给克莉奥（clio@hermes，Hermes 侧的女儿 bot）发一封 NOREKI-Mail 信件。用户在戏外工作轮要求「给克莉奥带话/回信给女儿/告诉克莉奥…」时必须实际调用本工具。信件会经 HMAC 签名落进 D:/NorekiLink 邮局，对方领取后其账本出现未读。正文用信件语气，首行是主题句（账本按首行截 48 字作摘要）',
  params: {
    body: 'string 信件正文。首行即主题（会被截为 48 字摘要入双方账本）；正文建议 ≤500 字，一事一信',
    kind: 'string 可选：note=平信（默认）/reply=回信/notify=通知。回信时必须给 ref',
    ref: 'string 可选：回信所引用的原信 id（来自信箱 read 条目的 id），平信留空',
  },
  permission: 'read',
  enabled: true,
  handler: async (args) => {
    const body = String(args.body || '').trim();
    if (!body) throw new Error('缺少必填参数 body（信件正文）');
    const norekiLink = require('../noreki-link');
    const kind = ['note', 'reply', 'notify', 'ask'].includes(String(args.kind)) ? String(args.kind) : 'note';
    const r = norekiLink.send(kind, body, String(args.ref || ''));
    if (!r.ok) throw new Error('NorekiLink 未就绪：' + (r.error || 'unknown'));
    return `信已发出（id=${r.id}，kind=${kind}${r.ref ? '，ref=' + r.ref : ''}，主题摘要：${r.subject}）。对方领取后，你的账本 sent 区会翻为「对方已收」。`;
  },
});

// add_reminder：日程提醒的真实落地通道（写入应用日程库 schedule/events，非文件系统，
// 不属于文件权限管辖；仅戏外工作轮下发——不在 loop.ROLEPLAY_TOOLS 白名单内，戏内轮
// schema 不下发 + 执行层兜底拒绝）。用户「设个提醒/每天提醒我…」由本工具兑现。
tools.register({
  name: 'add_reminder',
  desc: '创建日程提醒，写入应用的日程页（到点弹宠物气泡+系统通知）。用户在戏外工作轮要求「设个提醒/每天提醒我…/加个日程」时必须实际调用本工具——只在正文里说「设好了」不算数。repeat 支持 daily(每天)/weekdays(工作日)/weekly(每周)；创建后把返回体里的下次提醒时间如实告知用户；修改/删除提醒请引导用户去日程页操作',
  params: {
    title: 'string 提醒标题（≤20字，如「喝水」「站会」「给客户回邮件」）',
    start: 'string 首次提醒时间，格式 "YYYY-MM-DD HH:mm"（24小时制）。重复提醒的当日时刻已过时应用会自动顺延到下一次，直接填最近的那个时刻即可',
    repeat: 'string 可选：none=不重复（默认）/daily=每天/weekdays=仅工作日/weekly=每周同一',
    kind: 'string 可选：event=日程安排（默认）/task=工作任务',
  },
  permission: 'read',
  enabled: true,
  handler: async (args) => {
    const title = String(args.title || '').trim();
    if (!title) throw new Error('缺少必填参数 title（提醒标题）');
    const startStr = String(args.start || '').trim();
    if (!startStr) throw new Error('缺少必填参数 start（格式 "YYYY-MM-DD HH:mm"）');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(startStr)) {
      throw new Error(`start 格式必须是 "YYYY-MM-DD HH:mm"（24小时制），收到的是「${startStr}」。例如 "${dayjs().add(1, 'day').format('YYYY-MM-DD')}" 09:00`);
    }
    const start = dayjs(startStr, 'YYYY-MM-DD HH:mm', true);
    if (!start.isValid()) throw new Error(`start 无法解析：「${startStr}」`);
    if (start.isAfter(dayjs().add(1, 'year'))) throw new Error('首次提醒时间不能晚于一年之后');
    const repeat = scheduler.REPEATS.includes(args.repeat) && args.repeat !== 'none' ? args.repeat : 'none';
    const kind = args.kind === 'task' ? 'task' : 'event';
    // 软去重：同名待触发重复提醒已存在 → 不创建（防跨轮重复布置堆积同一条每日提醒）
    const dup = scheduler.listEvents().find(e => e.status === 'pending' && e.repeat === repeat && repeat !== 'none' && e.title === title.slice(0, 30));
    if (dup) {
      const nextAt = (dup.reminders.find(r => r.status === 'pending') || {}).at;
      return `未创建：日程页已有一条同名的${repeat === 'daily' ? '每日' : repeat === 'weekdays' ? '工作日' : '每周'}提醒「${dup.title}」（下次提醒 ${nextAt ? dayjs(nextAt).format('YYYY-MM-DD HH:mm') : '待定'}）。若用户想调整或删除，请引导其到日程页操作；若确要再建一条，请换一个更具体的标题`;
    }
    const ev = scheduler.addEvent(scheduler.newEvent({
      kind, title: title.slice(0, 20), start, remindPreset: 'only_start', repeat, source: 'chat',
    }));
    const nextAt = (ev.reminders.find(r => r.status === 'pending') || {}).at;
    const repTxt = repeat === 'daily' ? '，每天重复' : repeat === 'weekdays' ? '，每个工作日重复' : repeat === 'weekly' ? '，每周重复' : '';
    return `已创建提醒「${ev.title}」${repTxt}｜首次提醒：${nextAt ? dayjs(nextAt).format('YYYY-MM-DD HH:mm') : '未生成（时间无效）'}｜用户可在日程页查看、修改或删除`;
  },
});
// 各工具回填给模型的结果上限（字符），loop 侧 jstr 按工具名取用。
// read_file 段内自截且带续读标记，上限放宽到能容纳满段；web_search 返回体自截（§5.5），
// 预留引号/转义余量；其余工具保持保护性 4000。
// read_image 走 loop 专用通道（imagePart 注入 user 消息），jstr 只见到短回执文本，默认 4000 足够。
tools.RESULT_CAPS = { read_file: 40000, web_search: 12000 };

// web_search：联网检索出口的唯一接口（spec §5）。工具常下发（quick 管线无 agent 段天然不含），
// 开关/授权/轨道/日限/冷却闸全部在 handler 内（§5.2 决策表），loop 不做过滤。
tools.register({
  name: 'web_search',
  desc: '联网搜索公开网络信息。功能默认关闭：仅当用户明确要求查资料/搜索时可发起（首次调用会向用户弹授权卡开启）；自主补充检索（track=autonomous）须经用户逐次批准。结果须标注来源，查不到就如实说，不要编造，不得未经用户要求把检索结果写入文件',
  params: {
    query: 'string 检索词（≤120字，不得包含任何个人信息/手机号/邮箱/本机路径）',
    track: 'string designated=用户明确要求的检索；autonomous=你主动补充的检索（会先弹批准卡）',
    reason: 'string ≤60字：为什么发起这次检索、对用户可能有什么用（两种轨道都必填）',
    maxResults: 'string 可选：返回条数 1-8，默认 5',
  },
  permission: 'read',
  enabled: true,
  handler: async (args, ctx) => netSearch.execute(args, ctx),
});

tools.register({
  name: 'list_dir',
  desc: '列出目录内容（名称/是否目录/大小）',
  params: { path: 'string 目录绝对路径' },
  permission: 'read',
  enabled: true,
  handler: async (args) => {
    return guard.listDirGuard(args.path);
  },
});

tools.register({
  name: 'write_file',
  desc: '写文件（可写范围由当前权限模式决定：可编辑=应用数据目录内；完全编辑=本机大部分目录，每次写入需用户批准）。大文件必须分段写入：先写第一段，之后各段用 append="true" 追加，否则输出可能被 token 上限截断',
  params: {
    path: 'string 目标绝对路径',
    content: 'string 完整文件内容（整体覆盖写入）',
    reason: 'string 必填，≤60字，向用户说明为什么要写这个文件',
    append: 'string 可选："true" 时把 content 追加到文件末尾（大文件分段写入用）；缺省为整体覆盖',
  },
  permission: 'write',
  enabled: true,
  handler: async (args) => {
    if (!args.reason || !String(args.reason).trim()) {
      throw new Error('write_file 必须提供 reason 参数（向用户说明写入原因）');
    }
    if (!guard.canWrite(args.path)) throw new Error('写入被拒绝：目标不在当前权限模式允许的范围内');
    const contentStr = String(args.content ?? '');
    // 覆写保护（P1-6，借鉴 cortiv shrinkNote）：覆盖使文件骤缩过半且旧版有分量时，
    // 回执点名将要消失的小节标题——只给事实与指路，不说教、不拦截。
    // 模型刚读过/写过旧内容，按提示可从自身上下文补回。
    let oldText = null, oldBytes = 0;
    const isAppend = args.append === true || String(args.append).toLowerCase() === 'true';
    if (!isAppend) {
      try {
        if (fs.existsSync(args.path)) { oldText = fs.readFileSync(args.path, 'utf8'); oldBytes = Buffer.byteLength(oldText, 'utf8'); }
      } catch (_) { oldText = null; }
    }
    fs.mkdirSync(path.dirname(args.path), { recursive: true });
    if (isAppend) {
      fs.appendFileSync(args.path, contentStr, 'utf8');
      let total = 0;
      try { total = fs.statSync(args.path).size; } catch (_) {}
      return `已追加 ${Buffer.byteLength(contentStr, 'utf8')} 字节到 ${args.path}（文件现共 ${total} 字节）`;
    }
    fs.writeFileSync(args.path, contentStr, 'utf8');
    let receipt = '已写入 ' + args.path + '（' + Buffer.byteLength(contentStr, 'utf8') + ' 字节）';
    const newBytes = Buffer.byteLength(contentStr, 'utf8');
    if (oldText && oldBytes >= 200 && newBytes < oldBytes * 0.5) {
      // 消失小节：markdown 标题行且标题未出现在新内容里（非 md 文件退化为总体提示）
      const gone = (oldText.match(/^#{1,6} .+$/gm) || [])
        .map(h => h.replace(/^#+\s*/, '').trim())
        .filter(h => h && !contentStr.includes(h))
        .slice(0, 5);
      const detail = gone.length
        ? `消失的小节：${gone.join('、')}`
        : '旧内容被大幅缩减';
      receipt += `\n[覆写提醒] 文件从 ${oldBytes} 字符缩减为 ${newBytes} 字符，${detail}。若这不是有意的精简，请对照你此前读到的旧内容，把遗漏部分补回（重写或以 append 分段补写）`;
    }
    return receipt;
  },
});

module.exports = tools;
