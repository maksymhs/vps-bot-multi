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
  Bot matches template → copies boilerplate to project dir
   │
   ▼
  Docker builds image (COPY . .) → container starts on :3000
   │                               URL sent to Telegram immediately
   ▼
  builder-server.js runs inside container:
    ├── serves live web console at the project URL
    ├── calls DeepSeek V3 via OpenRouter (streaming)
    │   └── writes files to /app as tokens arrive
    ├── npm install  (output streamed to browser)
    ├── npm run build (if needed)
    └── server.close() → spawns the real app on :3000
   │
   ▼
  Browser auto-reloads → real app is live
  Caddy → https://john-kanban.yourdomain.com ✓
```

**The container never restarts.** The builder hands off port 3000 to the app in place.

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

The installer handles Node.js, Docker, Caddy, user setup, system service, and pre-warms the Docker build cache.
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

- **Live build console** — users watch DeepSeek generate their app in real time via a terminal-style web UI
- **No container restart** — builder hands off port 3000 to the app in place, zero downtime transition
- **Auto-registration** — users are created automatically on first `/start`
- **Auto-named projects** — DeepSeek generates a short slug from the description
- **Per-user isolation** — each user has their own directory, projects, and containers
- **Configurable limits** — `MAX_APPS_PER_USER` in `.env` (default: 3)
- **Auto-sleep** — idle containers stop after 30 min, wake on HTTP request
- **Admin panel** — server status, user list, ban/unban, maintenance mode
- **Streaming generation** — files written to disk as tokens arrive
- **Template matching** — boilerplate copied before AI runs, speeds up generation
- **Build queue** — `MAX_CONCURRENT_BUILDS` prevents server overload
- **Full build logs** — container output streamed to `logs/build-*.log` automatically

---

## Container Architecture

Each project runs in a single Docker container through two phases:

```
┌─────────────────────────────────────────────────────┐
│  container: user-projectname-app   port: 3000        │
│                                                      │
│  /app/                                               │
│  ├── builder-server.js   ← orchestrator              │
│  ├── .build-prompt.txt                               │
│  └── [template files]                                │
│                                                      │
│  PHASE 1 — builder-server.js                         │
│    serves web console on :3000                       │
│    → calls OpenRouter API (DeepSeek V3, cloud)       │
│    → writes generated files to /app/                 │
│    → runs npm install / npm run build                │
│    → server.close()                                  │
│                                                      │
│  PHASE 2 — real app                                  │
│    spawn("node src/index.js")  on :3000              │
│    container keeps running, same port                │
└─────────────────────────────────────────────────────┘
```

DeepSeek never runs on your server — it's a cloud API call from inside the container.

### Edit / Rebuild flow

```
Telegram "change the button color"
  │
  ▼
docker cp container:/app/. projectdir/   ← sync latest files to host
docker compose up --build                ← new image with current files
  │
  ▼
PHASE 1 again: AI patches only changed files
PHASE 2: updated app launches
```

---

## Telegram UX

When a project is created or rebuilt, you get a single message:

```
🚀 my-kanban
🌐 https://my-kanban.yourdomain.com

Open the link — your app is building live inside the container.

[♻️ Rebuild]  [📋 Logs]
[🔗 URL]      [⬅️ List]
```

Open the URL to watch the live console. The page auto-reloads when the app is ready.

### Commands

| Command | Description |
|---|---|
| `/start` | Main menu |
| `/list` | List your projects |
| `/url <name>` | Get project URL |
| `/rebuild <name> [changes]` | Patch or rebuild project |
| `/delete <name>` | Delete project |

### Admin (inline buttons)

- **📊 Server Status** — CPU, RAM, disk, running containers, build queue
- **👥 Users** — list all users with app counts
- **🛑 Stop All** — stop all running containers
- **⏸ Pause / ▶️ Resume** — maintenance mode

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
DOMAIN=your-domain.com                 # or leave blank for IP mode

# Admin
ADMIN_USER_ID=123456789

# Limits & concurrency
MAX_APPS_PER_USER=3
MAX_CONCURRENT_BUILDS=2
IDLE_TIMEOUT=30                        # minutes before container sleeps
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
            builder-server.js
            (inside container)
                   │
          ┌────────┴────────┐
          │                 │
     OpenRouter API    writes /app/*
     (DeepSeek V3)    npm install
     cloud, billed    npm run build
     per token        spawn app
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
│       ├── builder-server.js   # Runs inside container: AI → install → launch
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
