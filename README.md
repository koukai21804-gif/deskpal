# deskpal · 桌面宠物 AI 伴侣

[English](./README_EN.md) | 中文

Windows 桌面宠物应用（Electron）：让一位 AI 伙伴住在你的桌面上 —— 角色扮演聊天、书籍陪读、时间统计、智能日程提醒、本地快速启动器。

内置默认角色 **缇托·诺蕾姬**：一位知识广博、轻微社恐的 AI 天才少女（淡紫色长发 + 猫耳骨传导耳机），配有 6 套表情差分图。全部人设字段可编辑，也可以上传图片打造你自己的宠物；支持多套「宠物设定档案」一键切换、导出/导入分享。

<p align="center">
  <img src="resources/icon-256.png" width="128" alt="deskpal 图标">
</p>

## ✨ 功能一览

| 功能 | 入口 | 说明 |
|------|------|------|
| 🐱 形象系统 | 设置 → 形象 | 内置角色缇托 6 表情差分图（平常/开心/惊讶/愤怒/思考/悲伤）+ 眨眼/呼吸动画；可上传自定义差分图（png/jpg/webp/gif ≤8MB）；**口头禅支持表情标签**：句中写 `[开心]` 等标签，点到该句宠物同步切换表情；窗口平滑拖动、贴边吸附 |
| 🎨 人设与配色 | 设置 → 人设/配色 | 人设字段全可编辑（性格/说话风格/背景故事/思维逻辑…）+ 主人称呼与介绍，实时预览 system prompt；**宠物设定档案**：人设+形象+缩放一体保存、多套切换、导出/导入 `.pet.json` 分享；主题配色全窗口即时生效（浅色/深色/跟随系统） |
| 💬 角色扮演 | 双击宠物 | 分层 system prompt + 长期记忆（每 10 条用户消息自动提取）；回复携带情绪标签实时驱动宠物表情；支持停止/导出 |
| ⚡ 快问速答 | 聊天 → 快问 | 干净直答，无剧情腔，保持宠物口吻 |
| 📖 书籍陪读 | 陪读 | 上传 txt/md/pdf/doc/docx → 两阶段 AI 生成（大纲 → 逐节剧本+黑板+测验）→ galgame 式放映；放映中随时举手提问（基于原文引用，不打断剧情）；进度可续读，可用当前人设重新生成 |
| ⏱ 时间管理 | 时间统计 | 后台 1s 轮询前台窗口 + 空闲检测（180s 可配）；空闲归来请你标注陌生应用；24h 分布/排行/标注；可生成 AI 日报/周报 |
| 🚀 启动器 | 设置 → 指令 | 「打开微信」本地秒开（exe/bat/网址/文件），断网可用 |
| 📅 日程提醒 | 日程 | 一句话速添（AI 解析时间）/ 聊天自动识别 / Excel 项目表批量拆解 / 手动表单；按类型自动提醒（事件提前 60min、任务开始 5min、截止 120min，可调）；宠物气泡提醒卡 + 系统通知 + 提示音；稍后提醒、错过补报 |

## 🔌 LLM 接入

设置 → API：任意 **OpenAI 兼容接口**（内置 DeepSeek / 智谱 GLM / Kimi / 通义千问 / OpenAI 预设，也可自定义地址）。

- 填好地址与 Key 后**自动拉取模型列表**，下拉选择即可（也支持手动填写）；
- 兼容 base 地址（如 `https://api.deepseek.com`）或完整 chat/completions 地址；
- 兼容思考型模型（DeepSeek 内部任务自动关闭思考，避免 JSON 被推理 token 挤占截断）；
- API Key 经 Windows safeStorage（DPAPI）加密存储；
- 聊天/陪读/日程解析/时间报告需要 API；启动器、换装等本地功能无需 API。

## 🚀 快速开始

### 普通用户

从 [Releases](../../releases) 下载安装版 `deskpal Setup x.x.x.exe`，或绿色版 `win-unpacked` 解压后直接运行 `deskpal.exe`。

首次运行：托盘出现宠物 → 打开 **设置 → API** 填入地址与 Key → 双击宠物开始聊天。

### 开发者

```bash
npm install          # 安装依赖（postinstall 自动准备 vendor 资源与默认图标）
npm start            # 开发运行
npm run pack         # 绿色版（dist/win-unpacked）
npm run dist         # 安装包 + 绿色版
npm run make-icons   # 从根目录 icon.png 重新生成全套程序图标
```

- 打包脚本内置国内镜像回退（npmmirror）并复用本地 Electron 构建，GitHub 直连不通也能打包。
- 主进程 CommonJS（`src/main/`），渲染层原生 ES Module（`src/renderer/`），**无构建步骤**；IPC 通道白名单集中在 `src/main/preload.js` 与 `src/main/ipc.js`。
- 冒烟自检：`DESKPAL_SMOKE=1 npm start`（8 秒后自动退出并写 SMOKE OK 日志）；fs-guard 自测：`npm run test:fs-guard`。
- 实施细案见 `docs/`（总纲 + 里程碑 A–G + 附录）。
- Agent 预留：`src/main/services/agent/` 工具注册表已就位（read_file/list_dir 启用、write_file 禁用态），未接入聊天，后续开发只需启用并接入 loop。

## 🔐 隐私与权限

- **API Key**：safeStorage（DPAPI）加密存于本机，只随你的请求发往你自己配置的 LLM 服务商，无遥测、无埋点。
- **文件权限**：读取有敏感路径黑名单（DPAPI 密钥/浏览器凭据/密码库/SSH 私钥/钱包等直接拒绝，见 `src/main/services/fs-guard.js`）；写入仅限应用自身数据目录。
- **时间统计**：仅记录前台窗口进程名与标题，用于本地分类统计。
- **数据目录**：`%APPDATA%/deskpal/`（设置 → 关于可一键打开），删除即完全重置。

## 📦 技术栈

Electron 31 · 原生 JS（无前端框架）· koffi（FFI 窗口监测）· pdfjs-dist / mammoth / word-extractor（文档解析）· marked / katex（渲染）· exceljs（日程表导入）。

## 📄 许可证

[MIT](./LICENSE)。内置角色「缇托·诺蕾姬」的立绘与形象为 AI 生成，随项目分发供个人使用；请同时遵守你所使用 LLM 服务商的条款。
