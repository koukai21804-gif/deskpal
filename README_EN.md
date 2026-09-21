# deskpal · Desktop Pet AI Companion

English | [中文](./README.md)

A Windows desktop pet application (Electron): an AI companion that lives on your desktop — roleplay chat, **AI agent file tasks**, book co-reading, time tracking, smart schedule reminders, and a local quick launcher.

The built-in default character is **Titor Noreiji** — a knowledgeable, mildly socially-anxious AI prodigy girl (long lavender hair with cat-ear bone-conduction headphones) who ships with 6 expression sprites. Every persona field is editable, you can upload your own sprite images, and multiple pet profiles can be saved, switched, and shared as `.pet.json` files.

<p align="center">
  <img src="resources/icon-256.png" width="128" alt="deskpal icon">
</p>

## ✨ Features

| Feature | Entry | Description |
|---------|-------|-------------|
| 🐱 Sprite system | Settings → Sprite | 6 built-in expressions (normal/happy/surprised/angry/thinking/sad) + blinking/breathing animations; upload custom sprites (png/jpg/webp/gif ≤8MB); **emotion tags in catchphrases** — put `[happy]` in a line and the pet switches to that expression when it says it; smooth window dragging with edge snapping |
| 🎨 Persona & theme | Settings → Persona/Theme | Fully editable persona fields (personality/speech style/backstory/thinking logic…) plus owner name & intro with live system-prompt preview; **pet profiles**: save persona + sprites + scale as a bundle, switch between sets, export/import `.pet.json`; theme accent applies instantly (light/dark/system) |
| 💬 Roleplay chat | Double-click pet | Layered system prompt + long-term memory (auto-extracted every 10 user messages); **per-sentence expression beats** — inline `[happy]` tags bind to sentences, the pet switches expression sentence by sentence as the reply streams; stop & export supported |
| ⚡ Quick Q&A | Chat → Quick | Straight answers, no roleplay flavor, still in the pet's voice |
| 🤖 Agent file tasks | Chat (roleplay) | Say "create a todo.md in the data directory's temp folder" and the pet actually does it via real tool calls: read / list / write files, with a live step timeline (a `[progress:design/discovery/capability/validation]` protocol), before/after snapshot diff cards (measured, not self-reported), a run ledger for review, bounded fake-completion retry, and interruption at any time. **Three-tier file permission** — see below |
| 📖 Book co-reading | Reader | Upload txt/md/pdf/doc/docx → two-stage AI generation (outline → per-section script + blackboard + quiz) → galgame-style playback; raise-hand questions any time (grounded in the book, doesn't interrupt the story); resumable progress; regenerate with the current persona |
| ⏱ Time tracking | Time | Background 1s polling of the foreground window + idle detection (180s, configurable); labels unknown apps when you return; 24h distribution / ranking / labeling; AI daily & weekly reports |
| 🚀 Launcher | Settings → Commands | "Open WeChat" launches instantly, fully offline (exe/bat/URL/file) |
| 📅 Schedule | Schedule | One-line quick add (AI parses the time) / auto-detected from chat / Excel project-sheet batch import / manual form; per-type lead times (events 60min, task starts 5min, deadlines 120min — all adjustable); pet bubble card + Windows notification + sound; snooze & catch-up |

## 🤖 Agent file permissions (three tiers)

Switch any time from the selector at the left of the chat input (or Settings → API → Agent); takes effect on the next task:

| Tier | What the pet can do |
|------|---------------------|
| 🔒 **Read-only** (default) | Read files and list directories only; the write tool is never even sent to the model |
| 📝 **Editable** | Write directly inside the app data directory (the deskpal folder) and all its subfolders, no prompts; every write still shows up in diff cards and the run ledger |
| ⚠️ **Full edit** | Read/write most folders on your machine (core system dirs, other users' profiles, and sensitive files excluded); **every write pops a permission card** and only lands after you click "Allow once" — timeouts and errors are always denied |

At every tier: sensitive paths (password stores, browser credentials, SSH keys, DPAPI keys, …) are refused for both reads and writes; all changes are **measured** by before/after snapshots rather than trusted from the model's claims, diff cards show line-level changes, and `agent/runs.jsonl` records the full process of every task.

## 🔌 LLM setup

Settings → API: any **OpenAI-compatible endpoint** (presets for DeepSeek / Zhipu GLM / Kimi / Qwen / OpenAI, or a custom URL).

- Once the URL and key are filled in, the **model list is fetched automatically** — just pick from the dropdown (manual entry also works);
- Accepts either a base URL (e.g. `https://api.deepseek.com`) or a full chat/completions URL;
- Reasoning-model friendly (thinking mode is disabled automatically for DeepSeek internal tasks and agent decision rounds so JSON/tool calls aren't truncated by reasoning tokens);
- Gateways that reject streaming-with-tools fall back to non-streaming decision rounds automatically;
- API keys are encrypted with Windows safeStorage (DPAPI);
- Chat / co-reading / schedule parsing / reports / agent tasks need an API key; the launcher and appearance features work fully offline.

## 🚀 Getting started

### End users

Download the installer `deskpal Setup x.x.x.exe` from [Releases](../../releases), or grab the portable `win-unpacked` folder and run `deskpal.exe` directly.

First run: the pet appears in your tray → open **Settings → API** and fill in your endpoint and key → double-click the pet to start chatting.

### Developers

```bash
npm install            # install deps (postinstall prepares vendored assets and default icons)
npm start              # run in dev mode
npm run pack           # portable build (dist/win-unpacked)
npm run dist           # installer + portable build
npm run make-icons     # regenerate all app icons from the root icon.png
npm run test:agent     # agent pipeline self-tests (unit + integration)
npm run test:fs-guard  # file-permission guard self-test
```

- The packaging script has a China-mirror fallback (npmmirror) and reuses the local Electron build, so it works even without direct GitHub access.
- Main process is CommonJS (`src/main/`), renderer is plain ES Modules (`src/renderer/`) — **no build step**; IPC channels are whitelisted in `src/main/preload.js` and `src/main/ipc.js`.
- Smoke check: `DESKPAL_SMOKE=1 npm start` (auto-exits after 8s and logs SMOKE OK).
- Agent pipeline (v0.3): five modules in `src/main/services/agent/` (loop / progress / permissions / trace / runs) wired into roleplay chat; `scripts/test-real-llm.js` runs end-to-end checks against a real API, and `scripts/cdp-repro.js` drives the real GUI to verify the permission-card chain (`MODE=read|userData|full`).
- Design docs live in `docs/` (overview + milestones A–H + appendices, in Chinese). The agent pipeline borrows **ideas** from Amadeus (AGPL-3.0) — progress protocol, epoch interruption, permission cards, snapshot-based attribution, expression beats — with all code written independently; no upstream source was copied.

## 🔐 Privacy & permissions

- **API key**: encrypted locally with safeStorage (DPAPI); it is only sent to the LLM provider you configure yourself. No telemetry, no analytics.
- **File access**: reads go through a sensitive-path blacklist (DPAPI keys, browser credentials, password stores, SSH keys, wallets — always denied; see `src/main/services/fs-guard.js`); writes are arbitrated by the three-tier mode above, and sensitive files are never writable in any tier.
- **Agent ledger**: the full process of every file task (instruction / steps / permission decisions / file changes) stays in the local `agent/runs.jsonl` for review and crash recovery — never sent anywhere.
- **Time tracking**: only records the foreground process name and window title, stored locally.
- **Data directory**: `%APPDATA%/deskpal/` (open it from Settings → About); deleting it fully resets the app.

## 📦 Tech stack

Electron 31 · vanilla JS (no frontend framework) · koffi (FFI window tracking) · pdfjs-dist / mammoth / word-extractor (document parsing) · marked / katex (rendering) · exceljs (schedule import).

## 📄 License

[MIT](./LICENSE). The built-in character artwork (Titor Noreiji) is AI-generated and distributed with the project for personal use; please also follow the terms of your LLM provider.
