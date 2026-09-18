# deskpal · Desktop Pet AI Companion

English | [中文](./README.md)

A Windows desktop pet application (Electron): an AI companion that lives on your desktop — roleplay chat, book co-reading, time tracking, smart schedule reminders, and a local quick launcher.

The built-in default character is **Titor Knowledge** — a knowledgeable, mildly socially-anxious AI prodigy girl (long lavender hair with cat-ear bone-conduction headphones) who ships with 6 expression sprites. Every persona field is editable, you can upload your own sprite images, and multiple pet profiles can be saved, switched, and shared as `.pet.json` files.

<p align="center">
  <img src="resources/icon-256.png" width="128" alt="deskpal icon">
</p>

## ✨ Features

| Feature | Entry | Description |
|---------|-------|-------------|
| 🐱 Sprite system | Settings → Sprite | 6 built-in expressions (normal/happy/surprised/angry/thinking/sad) + blinking/breathing animations; upload custom sprites (png/jpg/webp/gif ≤8MB); **emotion tags in catchphrases** — put `[happy]` in a line and the pet switches to that expression when it says it; smooth window dragging with edge snapping |
| 🎨 Persona & theme | Settings → Persona/Theme | Fully editable persona fields (personality/speech style/backstory/thinking logic…) plus owner name & intro with live system-prompt preview; **pet profiles**: save persona + sprites + scale as a bundle, switch between sets, export/import `.pet.json`; theme accent applies instantly (light/dark/system) |
| 💬 Roleplay chat | Double-click pet | Layered system prompt + long-term memory (auto-extracted every 10 user messages); replies carry emotion tags that drive the pet's expression in real time; stop & export supported |
| ⚡ Quick Q&A | Chat → Quick | Straight answers, no roleplay flavor, still in the pet's voice |
| 📖 Book co-reading | Reader | Upload txt/md/pdf/doc/docx → two-stage AI generation (outline → per-section script + blackboard + quiz) → galgame-style playback; raise-hand questions any time (grounded in the book, doesn't interrupt the story); resumable progress; regenerate with the current persona |
| ⏱ Time tracking | Time | Background 1s polling of the foreground window + idle detection (180s, configurable); labels unknown apps when you return; 24h distribution / ranking / labeling; AI daily & weekly reports |
| 🚀 Launcher | Settings → Commands | "Open WeChat" launches instantly, fully offline (exe/bat/URL/file) |
| 📅 Schedule | Schedule | One-line quick add (AI parses the time) / auto-detected from chat / Excel project-sheet batch import / manual form; per-type lead times (events 60min, task starts 5min, deadlines 120min — all adjustable); pet bubble card + Windows notification + sound; snooze & catch-up |

## 🔌 LLM setup

Settings → API: any **OpenAI-compatible endpoint** (presets for DeepSeek / Zhipu GLM / Kimi / Qwen / OpenAI, or a custom URL).

- Once the URL and key are filled in, the **model list is fetched automatically** — just pick from the dropdown (manual entry also works);
- Accepts either a base URL (e.g. `https://api.deepseek.com`) or a full chat/completions URL;
- Reasoning-model friendly (thinking mode is disabled automatically for DeepSeek internal tasks so JSON output isn't truncated by reasoning tokens);
- API keys are encrypted with Windows safeStorage (DPAPI);
- Chat / co-reading / schedule parsing / reports need an API key; the launcher and appearance features work fully offline.

## 🚀 Getting started

### End users

Download the installer `deskpal Setup x.x.x.exe` from [Releases](../../releases), or grab the portable `win-unpacked` folder and run `deskpal.exe` directly.

First run: the pet appears in your tray → open **Settings → API** and fill in your endpoint and key → double-click the pet to start chatting.

### Developers

```bash
npm install          # install deps (postinstall prepares vendored assets and default icons)
npm start            # run in dev mode
npm run pack         # portable build (dist/win-unpacked)
npm run dist         # installer + portable build
npm run make-icons   # regenerate all app icons from the root icon.png
```

- The packaging script has a China-mirror fallback (npmmirror) and reuses the local Electron build, so it works even without direct GitHub access.
- Main process is CommonJS (`src/main/`), renderer is plain ES Modules (`src/renderer/`) — **no build step**; IPC channels are whitelisted in `src/main/preload.js` and `src/main/ipc.js`.
- Smoke check: `DESKPAL_SMOKE=1 npm start` (auto-exits after 8s and logs SMOKE OK); fs-guard self-test: `npm run test:fs-guard`.
- Design docs live in `docs/` (overview + milestones A–G + appendices, in Chinese).
- Agent placeholder: the tool registry in `src/main/services/agent/` is ready (read_file/list_dir enabled, write_file disabled) but not wired into chat yet.

## 🔐 Privacy & permissions

- **API key**: encrypted locally with safeStorage (DPAPI); it is only sent to the LLM provider you configure yourself. No telemetry, no analytics.
- **File access**: reads go through a sensitive-path blacklist (DPAPI keys, browser credentials, password stores, SSH keys, wallets — always denied; see `src/main/services/fs-guard.js`); writes are restricted to the app's own data directory.
- **Time tracking**: only records the foreground process name and window title, stored locally.
- **Data directory**: `%APPDATA%/deskpal/` (open it from Settings → About); deleting it fully resets the app.

## 📦 Tech stack

Electron 31 · vanilla JS (no frontend framework) · koffi (FFI window tracking) · pdfjs-dist / mammoth / word-extractor (document parsing) · marked / katex (rendering) · exceljs (schedule import).

## 📄 License

[MIT](./LICENSE). The built-in character artwork (Titor Noreiji) is AI-generated and distributed with the project for personal use; please also follow the terms of your LLM provider.
