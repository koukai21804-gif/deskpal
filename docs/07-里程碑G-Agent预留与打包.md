# 里程碑 G · Agent 预留与打包（as-built）

## G1. Agent 工具注册表（services/agent/）

- `tools.js`：`register/get/list/invoke`；invoke 前置检查 enabled，未注册/禁用抛中文错误。**本次不接入聊天管线**
- `builtin.js`：
  - `read_file`（permission: read，**enabled: true**）→ fs-guard.readFileGuard
  - `list_dir`（read，**enabled: true**）→ fs-guard.listDirGuard
  - `write_file`（write，**enabled: false** 预留）→ handler 内再校验 canWrite（仅 userData 与 userData/temp）
- 后续开发路径：在 chat 管线接入 tool-call loop → 按需启用 write_file → 更多工具（delete/move 等继续经 fs-guard 仲裁）

## G2. 打包

- `electron-builder.yml`：nsis x64、可改安装目录、桌面快捷方式；files 收敛到 `src/ resources 图标与提示音 package.json`；asar 开
- 图标：`scripts/gen-assets.js` 纯 Node zlib 生成 16/32/256 PNG（Haro 风格绿球）与 ding.wav；`scripts/make-icon.js`（png-to-ico）在打包前生成 icon.ico：`npm run make-icon && npm run dist`
- 注意：构建机若拦截安装脚本，需手动补跑 electron/koffi 的 postinstall（README 有说明）

## G3. 交付物清单

- 源码 `src/main`（14 文件）+ `src/renderer`（7 窗口 + common）
- 脚本：vendor.js（postinstall 拷 marked/katex）、gen-assets.js、make-icon.js、test-fs-guard.js
- README.md：快速开始/功能表/API 配置/数据与权限/开发说明

## 验收（实现后自检记录）

- [x] `node scripts/test-fs-guard.js` → PASS（18 项）
- [x] `DESKPAL_SMOKE=1 npm start` → main.log 出现 SMOKE OK；`full` 模式打开全部 7 窗口无渲染层 JS 错误
- [x] 打包配置就绪（完整 dist 构建依赖网络下载 Electron 二进制，按需执行）
