<p align="center">
  <img src="https://img.shields.io/badge/node-20-339933?logo=node.js&logoColor=white" />
  <img src="https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/DeepSeek-V3-D97706?logoColor=white" />
  <img src="https://img.shields.io/badge/telegram-bot-26A5E4?logo=telegram&logoColor=white" />
  <img src="https://img.shields.io/badge/license-MIT-green" />
</p>

<h1 align="center">vps-bot-multi</h1>
<p align="center"><strong>Describe it. Deploy it. For everyone.</strong></p>
<p align="center">Multi-user AI deploy platform — a public Telegram bot where anyone can describe an app and get it running on your VPS with Docker + SSL in under 20 seconds.</p>
<p align="center"><a href="https://t.me/VpsCodeBot">🤖 Try it: t.me/VpsCodeBot</a></p>

---

## How It Works

```
  Any Telegram user: "A real-time chat app with rooms"
   │
   ▼
  Auto-register → creates isolated user space on server
   │
   ▼
  Template matching → selects best starter template
   │
   ▼
  DeepSeek V3 (streaming) → auto-names project + generates all files
   │                         writes each file to disk as it arrives
   ▼
  Docker build starts in parallel → npm install runs while AI
   │                                 is still generating source files
   ▼
  Caddy → https://john-chat.yourdomain.com ✓  (~15-20s total)
   │
   ▼
  Auto-sleep after 30 min idle → wake on request
```

**No server interaction needed after initial install.** Users find your bot on Telegram and start building.

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

Every subsequent install sources `~/.vpsbot` and skips all prompts entirely.
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

- **Auto-registration** — users are created automatically on first `/start`
- **Auto-named projects** — DeepSeek generates a short slug from the description; no name step
- **Per-user isolation** — each user has their own directory, projects, and containers
- **Configurable limits** — `MAX_APPS_PER_USER` in `.env` (default: 3)
- **Forced auto-sleep** — idle containers stop after 30 min, wake on HTTP request
- **Admin panel** — server status, user list, ban/unban (for ADMIN_USER_ID)
- **AI-powered builds** — DeepSeek V3 via OpenRouter, extremely cheap per build
- **Streaming generation** — files written to disk as they arrive, not after full response
- **Parallel Docker build** — `npm install` starts the moment `package.json` + `Dockerfile` land
- **Build cache warmup** — install pre-pulls `node:20-alpine` and warms the npm cache
- **Build queue** — `MAX_CONCURRENT_BUILDS` prevents server overload
- **Template matching** — accelerated builds with template boilerplate

---

## Build Speed

| Scenario | Time |
|---|---|
| First build (cold server) | ~30-45s |
| First build (after install warmup) | **~15-20s** |
| Rebuild (code changes only) | **~10-15s** |
| Rebuild (no dependency changes) | **~6-8s** |

The key optimisation: AI streams files one by one. Docker starts building the moment `package.json` + `Dockerfile` arrive — so `npm install` runs in parallel with the remaining source files being generated.

---

## Telegram Bot

```
⚡ vps-bot multi
Describe it. Deploy it.

📊 Apps: 1/3
[🚀 My Projects]
[➕ New Project]
```

### User Flow

1. Tap **➕ New Project**
2. Describe what the app should do
3. Bot auto-generates a name, deploys, and returns the URL — done

### Commands

| Command | Description |
|---|---|
| `/start` | Main menu |
| `/list` | List your projects |
| `/url <name>` | Get project URL |
| `/rebuild <name>` | Rebuild project |
| `/delete <name>` | Delete project |

### Admin (inline buttons)

- **📊 Server Status** — CPU, RAM, disk, running containers, build queue
- **👥 Users** — list all users with app counts
- **🛑 Stop All** — stop all running containers
- **⏸ Pause / ▶️ Resume** — maintenance mode (blocks non-admin users)

---

## Configuration

All via `.env` (written automatically by the installer):

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

## Architecture

```
        ┌──────────────────────┐
        │  Any Telegram User   │
        └──────────┬───────────┘
                   │
              vps-bot-multi
                   │
       ┌───────────┼───────────┐
       │           │           │
   Auto-register  Build       Auto-sleep
   (user-store)   (queue)      (30 min)
       │           │           │
       ▼           ▼           ▼
   /projects/   DeepSeek V3  Stop idle
   {username}/  → Docker →   Wake on
   {app}/       Caddy        HTTP request
```

### Data Layout

```
/home/vpsbot/projects/
├── users.json                    # All registered users
├── john/                         # User @john's space
│   ├── projects.json             # User's project registry
│   ├── chat-rooms/               # Auto-named from description
│   │   ├── src/
│   │   ├── Dockerfile
│   │   └── docker-compose.yml    # container: john-chat-rooms-app
│   └── task-tracker/             # URL: john-task-tracker.domain.com
└── maria/
    ├── projects.json
    └── weather-bot/              # URL: maria-weather-bot.domain.com
```

---

## Project Structure

```
vps-bot-multi/
├── src/
│   ├── bot.js              # Telegram bot, conversation state machine
│   ├── commands/
│   │   ├── projects.js     # AI generation + Docker deploy + streaming
│   │   └── menu.js         # Inline keyboard menus
│   └── lib/
│       ├── config.js       # Environment config + limits
│       ├── user-store.js   # Per-user project store + user management
│       ├── docker-client.js # Dockerode singleton
│       ├── sleep-manager.js # Auto-sleep + wake proxy
│       ├── build-state.js  # In-progress build tracking
│       ├── build-queue.js  # Concurrency limiter
│       ├── logger.js       # Centralized logging
│       ├── templates.js    # Template sync, matching & boilerplate
│       ├── branding.js     # Branding
│       └── caddy.js        # Caddy admin API
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
