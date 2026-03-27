<p align="center">
  <img src="https://img.shields.io/badge/node-20-339933?logo=node.js&logoColor=white" />
  <img src="https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/DeepSeek-V3-D97706?logoColor=white" />
  <img src="https://img.shields.io/badge/telegram-bot-26A5E4?logo=telegram&logoColor=white" />
  <img src="https://img.shields.io/badge/license-MIT-green" />
</p>

<h1 align="center">vps-bot-multi</h1>
<p align="center"><strong>Describe it. Deploy it. For everyone.</strong></p>
<p align="center">Multi-user AI deploy platform — a public Telegram bot where anyone can describe an app and get a live URL in seconds. The AI generates, installs, and launches the app <em>inside the container</em> with a real-time web console you can watch.</p>
<p align="center"><a href="https://t.me/VpsCodeBot">🤖 Try it: t.me/VpsCodeBot</a></p>

---

## How It Works

```
  User on Telegram: "A kanban board with drag and drop"
   │
   ▼
  Bot sends ⏳ loading message, matches template → copies boilerplate to project dir
   │
   ▼
  Docker builds image (npm install layer cached) → container starts
   │                                                   ⏳ edited to 🚀 URL in Telegram
   ▼
  builder-server.js runs inside container (permanent proxy on :3000):
    ├── serves live web console + SSE log stream
    ├── reads .build-config.json → picks mode (patch | generate)
    │
    ├── [template match — mode: patch]
    │   ├── FAST PATH: plan+execute (1 API call)
    │   │     all files loaded into context → DeepSeek returns JSON plan
    │   │     { edits: [{file,old,new}], creates: [{file,content}] }
    │   │     → apply all changes instantly, no more API calls
    │   │
    │   └── FALLBACK: agentic tool loop (if plan fails)
    │         list_files → read_file → edit_file / write_file (up to 14 iters)
    │
    └── [no template — mode: generate]
        └── calls DeepSeek V3 via OpenRouter (streaming)
            writes files as tokens arrive
   │
   ▼
  npm install (skipped if package.json unchanged) → npm run build (if needed)
   │
   ▼
  real app spawned on :3001 — builder proxy forwards :3000 → :3001
  Browser auto-reloads → updated app is live ✓
  Caddy → https://john-kanban.yourdomain.com ✓
```

**The container never restarts.** builder-server.js stays alive as a permanent proxy. The app runs on an internal port.

### Console-first UX

For template-based builds the Telegram message links directly to `/console` so you see the agent working from the first second:

```
Telegram: 🚀 my-app  🖥 Watch build → https://my-app.domain.com/console

open link → /console shows live agent progress
                │
                │  (for no-build templates: boilerplate already running at main URL)
                │
           build done → console auto-redirects → https://my-app.domain.com  ✓
```

Going back to `/console` later shows the full replay of the last build (SSE replay buffer).

### Live browser sync (zero interaction)

Every HTML page served by the proxy has a tiny watcher script injected. When a rebuild fires from Telegram the open browser tab switches on its own:

```
app open in browser
  │ (watcher polls /health every 2s)
  │
user sends change from Telegram
  │
state = 'building'
  ↓
browser auto-redirects → /console   ← no click needed
  │ (SSE replay shows full history)
  │
build completes → state = 'running'
  ↓
browser auto-reloads → updated app  ← no click needed
```

---

## Quick Start

One-line install on any Ubuntu/Debian VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/maksymhs/vps-bot-multi/main/install.sh | bash -s -- --clone
```

Or if you already cloned the repo:

```bash
bash install.sh
```

The installer handles Node.js, Docker, Caddy, user setup, system service, pre-warms the Docker build cache, and **auto-generates a secure `REBUILD_SECRET`**.
During install it asks interactively for **BOT_TOKEN**, **OPENROUTER_API_KEY**, **DOMAIN**, and **ADMIN_USER_ID**.

### Skip the wizard on reinstalls

After the first install, save your credentials to `~/.vpsbot` — the script offers this automatically:

```
💾 Save credentials to ~/.vpsbot to skip this wizard next time? [Y/n]
```

You can also create it manually:

```bash
cat > ~/.vpsbot << 'EOF'
BOT_TOKEN=your_token
OPENROUTER_API_KEY=sk-or-v1-your-key
DOMAIN=apps.example.com
ADMIN_USER_ID=123456789
EOF
chmod 600 ~/.vpsbot
```

---

## Features

- **Live build console** — animated spinner per tool call, watch the AI edit your app in real time (SSE stream)
- **Plan+Execute** — single API call with all files in context → JSON plan → all edits applied instantly (~5-10s vs 20-60s)
- **Agentic tool loop** — fallback if plan fails: `read_file` / `edit_file` / `write_file` tools, can't hallucinate file contents
- **Self-healing** — build errors and runtime crashes feed back to the agent automatically (up to 2 fix attempts)
- **Permanent proxy architecture** — builder-server.js stays alive on :3000 forever; app runs on :3001 internally
- **Instant HTTP rebuild** — `/rebuild` POST to the running container, no Docker restart whatsoever
- **Full lifecycle in one message** — ⏳ → 🚀 Watch Live → ✅ ready (single message edited in-place, no spam)
- **Completion notification** — background poll on `/health`; edits to ✅ (or ❌) when build finishes
- **Watch Live button** — opens the `/console` SSE stream directly from Telegram (on both new builds and rebuilds)
- **Instant boilerplate** — for no-build templates (static, express) the app is live at the URL from second one while the agent customises in background
- **Console-first links** — Telegram links directly to `/console`; browser auto-redirects to the app when done; `/console` replays full build history on revisit
- **Auto browser sync** — injected watcher redirects open tab to console on rebuild, reloads app when done; zero clicks needed
- **Docker layer caching** — `npm install` layer cached when `package.json` unchanged between builds
- **npm install skip** — skipped entirely if `package.json` didn't change during generation
- **Auto-registration** — users created automatically on first `/start`
- **Auto-named projects** — DeepSeek generates a short slug from the description
- **Per-user isolation** — each user has their own directory, projects, and containers
- **Configurable limits** — `MAX_APPS_PER_USER` in `.env` (default: 3)
- **Auto-sleep** — idle containers stop after 30 min, wake on HTTP request
- **Admin panel** — server status, user list, ban/unban, maintenance mode
- **Template matching** — boilerplate copied before AI runs; AI only outputs changed files
- **Build queue** — `MAX_CONCURRENT_BUILDS` prevents server overload
- **Full build logs** — container output streamed to `logs/build-*.log` automatically

---

## Container Architecture

Each project runs in a single Docker container. `builder-server.js` is a **permanent proxy** — it never exits.

```
┌─────────────────────────────────────────────────────────┐
│  container: user-projectname-app                         │
│                                                          │
│  :3000 (public) ← builder-server.js (always alive)      │
│  :3001 (internal) ← real app (after build)               │
│                                                          │
│  /app/                                                   │
│  ├── builder-server.js   ← permanent proxy + builder     │
│  ├── .build-prompt.txt                                   │
│  ├── .build-config.json  ← { mode, maxTokens }           │
│  └── [boilerplate / generated files]                     │
│                                                          │
│  BUILD PHASE — builder-server.js                         │
│    serves /console + /events (SSE) on :3000              │
│    SSE replay buffer (300 events) + heartbeat every 4s   │
│    → plan+execute: 1 call, all files → JSON edits        │
│      fallback: tool loop (read/edit/write, ≤14 iters)    │
│      or streaming generation (generate mode)             │
│    → npm install  (cached / skipped if unchanged)        │
│    → npm run build (errors → agent fixes → retry)        │
│    → spawn app :3001 (crash → agent fixes → retry)       │
│                                                          │
│  RUNNING PHASE                                           │
│    :3000 proxies HTML → injects REBUILD_WATCHER script   │
│      polls /health 2s → auto-redirect to /console        │
│      on rebuild; auto-reload to / when done              │
│    no-build templates: boilerplate live before agent     │
│    /rebuild POST → kills app, reruns build phase         │
│    /console → SSE live log always available              │
└─────────────────────────────────────────────────────────┘
```

DeepSeek never runs on your server — it's a cloud API call from inside the container.

### Rebuild flow (instant, no Docker restart)

```
Telegram "change the button color"
  │
  ▼
Bot POSTs to https://john-kanban.yourdomain.com/rebuild
  { description: "change the button color" }
  X-Rebuild-Secret: <shared secret>
  │
  ▼
builder-server.js kills app process → plan+execute:
  all files loaded into context → 1 DeepSeek call
  → JSON plan: [{file, old, new}, ...]
  → apply all edits instantly
  → npm install (skipped if package.json same)
  → npm run build → if error: agent fixes + retries
  → spawn app on :3001 → if crash: agent fixes + retries
  │
  ▼
Watch Live button → /console shows animated spinner per step
Browser auto-reloads → updated app live in seconds
```

---

## Telegram UX

The bot edits a single message in-place through the whole lifecycle — no message spam:

```
⏳ my-kanban
   Starting build...
        ↓ (Docker up ~2s)
🚀 my-kanban
🌐 https://my-kanban.yourdomain.com
App is building live — tap Watch Live to follow progress.
[👁 Watch Live]  [♻️ Rebuild]  [📋 Logs]  [🔗 URL]
        ↓ (build completes, ~30-90s)
✅ my-kanban is ready
🔗 https://my-kanban.yourdomain.com
[♻️ Rebuild]  [📋 Logs]  [🔗 URL]  [⬅️ List]
```

**After rebuild (with progress bar):**
```
⏳ my-kanban
   Rebuilding...
        ↓
⏳ my-kanban
Rebuilding...

▓▓░░░░░░░░ Agent thinking...
[👁 Watch Live]
        ↓
⏳ my-kanban
Rebuilding...

▓▓▓▓░░░░░░ Applying changes...
[👁 Watch Live]
        ↓
✅ my-kanban is ready
🔗 https://my-kanban.yourdomain.com
Applied: "change the button color"

Type your next change directly in the chat.
[🔗 Open]  [♻️ Rebuild]  [📋 Logs]  [⬅️ List]
```

The progress bar updates live as the build moves through phases: `thinking → editing → installing → building → launching`.
Each phase change edits the message in-place — no spam.

**Change queuing:**
If you send another change while a build is in progress, it's queued automatically:
```
📝 my-kanban is building — change queued (1 pending).
Will apply automatically when done.
```
As soon as the current build finishes, the queued change starts immediately.

> **Tip:** keep the app open in a browser tab. When you send any change from Telegram the tab switches to the live console automatically and reloads to the updated app when done — no manual refresh ever needed.

### Commands

| Command | Description |
|---|---|
| `/start` | Main menu |
| `/list` | List your projects |
| `/url <name>` | Get project URL |
| `/rebuild <name> [changes]` | Patch project via HTTP (no Docker restart) |
| `/delete <name>` | Delete project |

### Admin (inline buttons)

- **📊 Server Status** — CPU, RAM, disk, running containers, build queue
- **👥 Users** — list all users with app counts
- **🛑 Stop All** — stop all running containers
- **⏸ Pause / ▶️ Resume** — maintenance mode

---

## Templates

When a user description matches a known template, the boilerplate is deployed first and the AI customizes it using the agentic tool loop — much faster and more consistent than generating everything from scratch.

| Template | Stack |
|---|---|
| `react-vite` | React + Vite |
| `static-site` | HTML + Tailwind CDN |
| `landing-page` | HTML + Tailwind CDN |
| `express-api` | Express + Node.js |
| `threejs-3d` | Three.js + React Three Fiber |

Templates live in a separate repo (`vps-bot-templates`) and are synced to the server on startup.

---

## Logs

```bash
# All phases of a build (generation, npm install, app startup, errors)
tail -f logs/build-username-projectname.log

# Bot system log (registrations, errors)
tail -f logs/system.log

# Raw container output
docker logs username-projectname-app --follow

# Find errors across all builds
grep ERROR logs/build-*.log
```

Container output (npm install, app crashes, etc.) is automatically streamed to the build log file — no manual `docker logs` needed for debugging.

---

## Configuration

All via `.env`:

```bash
# Required
BOT_TOKEN=your_telegram_bot_token
OPENROUTER_API_KEY=sk-or-v1-your-key   # get from openrouter.ai/keys
DOMAIN=your-domain.com                 # or IP_ADDRESS + PORT for no-SSL mode

# Admin
ADMIN_USER_ID=123456789                # auto-claimed by first /start if unset

# Limits & concurrency
MAX_APPS_PER_USER=3
MAX_CONCURRENT_BUILDS=2
IDLE_TIMEOUT=30                        # minutes before container sleeps

# Security (auto-generated by installer)
REBUILD_SECRET=<hex secret>            # shared between bot and containers
```

---

## Architecture Overview

```
        ┌──────────────────────┐
        │  Any Telegram User   │
        └──────────┬───────────┘
                   │
              vps-bot-multi (Node.js, host)
                   │
       ┌───────────┼───────────┐
       │           │           │
   Auto-register  Build       Auto-sleep
   (user-store)   (queue)      (30 min)
       │           │           │
       ▼           ▼           ▼
   /projects/   docker build  Stop idle
   {username}/  + start       Wake on
   {app}/       container     HTTP request
                   │
                   ▼
            builder-server.js (permanent proxy :3000)
                   │
          ┌────────┴──────────────────┐
          │                           │
     plan+execute               real app (:3001)
     (1 API call, all files)    proxied from :3000
     fallback: tool loop
     self-healing: build/crash
     errors → agent fixes
          │
     OpenRouter API
     (DeepSeek V3, cloud)
```

### Data Layout

```
/home/vpsbot/projects/
├── users.json
├── john/
│   ├── projects.json
│   ├── kanban-board/
│   │   ├── src/
│   │   ├── builder-server.js     ← baked into image at build time
│   │   ├── .build-config.json    ← { mode: 'patch', maxTokens: 8000 }
│   │   ├── Dockerfile
│   │   └── docker-compose.yml    # container: john-kanban-board-app
│   └── task-tracker/
└── maria/
    └── weather-bot/

logs/
├── system.log
├── build-john-kanban-board.log   ← full container output
└── build-maria-weather-bot.log
```

---

## Project Structure

```
vps-bot-multi/
├── src/
│   ├── bot.js                  # Telegram bot, conversation state machine
│   ├── commands/
│   │   ├── projects.js         # Build orchestration + Docker + logging
│   │   └── menu.js             # Inline keyboard menus
│   └── lib/
│       ├── builder-server.js   # Runs inside container: permanent proxy + agentic builder
│       ├── config.js           # Environment config + limits
│       ├── user-store.js       # Per-user project store
│       ├── docker-client.js    # Dockerode singleton
│       ├── sleep-manager.js    # Auto-sleep + wake proxy
│       ├── build-state.js      # In-progress build tracking
│       ├── build-queue.js      # Concurrency limiter
│       ├── logger.js           # Centralized file logging
│       ├── templates.js        # Template sync, matching & boilerplate
│       └── caddy.js            # Caddy admin API
├── logs/
├── .env.example
└── package.json
```

---

## Requirements

- **VPS** — 1+ GB RAM (Ubuntu/Debian recommended)
- **Root access** — projects are owned by the `vpsbot` system user
- **Ports 80 + 443** open (for domain mode with HTTPS)
- **OpenRouter API key** — [openrouter.ai/keys](https://openrouter.ai/keys)
- **Telegram Bot Token** — from [@BotFather](https://t.me/BotFather)

---

## License

MIT © 2025-2026 [Maksym](https://github.com/maksymhs)

---

<p align="center"><strong>vps-bot-multi</strong> — Describe it. Deploy it. For everyone.</p>
