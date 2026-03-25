<p align="center">
  <img src="https://img.shields.io/badge/node-20-339933?logo=node.js&logoColor=white" />
  <img src="https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/openrouter-AI-D97706?logo=data:image/svg+xml;base64,&logoColor=white" />
  <img src="https://img.shields.io/badge/telegram-bot-26A5E4?logo=telegram&logoColor=white" />
  <img src="https://img.shields.io/badge/license-MIT-green" />
</p>

<h1 align="center">vps-bot-multi</h1>
<p align="center"><strong>Describe it. Deploy it. For everyone.</strong></p>
<p align="center">Multi-user AI deploy platform — a public Telegram bot where anyone can describe an app and get it running with Docker + SSL.</p>

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
  OpenRouter API → generates full project (DeepSeek, Llama, Qwen)
   │
   ▼
  Docker → builds & deploys in user-namespaced container
   │
   ▼
  Caddy → https://u12345-chat.yourdomain.com ✓
   │
   ▼
  Auto-sleep after 30 min idle → wake on request
```

**No server interaction needed after initial install.** Users find your bot on Telegram and start building.

## Quick Start

One-line install (Ubuntu/Debian VPS):

```bash
curl -sL https://raw.githubusercontent.com/maksymhs/vps-bot-multi/main/install.sh | bash -s -- --clone
```

Or manually:

```bash
git clone https://github.com/maksymhs/vps-bot-multi.git && cd vps-bot-multi && bash install.sh
```

The installer handles Node.js, Docker, Caddy, user setup, and systemd service.
During install it asks for **BOT_TOKEN**, **OPENROUTER_API_KEY**, **DOMAIN**, and **ADMIN_USER_ID** interactively — no manual `.env` editing needed.

## Key Differences from vps-bot

| Feature | vps-bot | vps-bot-multi |
|---|---|---|
| **Users** | Single (CHAT_ID) | Any Telegram user |
| **Auth** | Private (whitelisted) | Public (auto-register) |
| **Isolation** | Shared projects dir | Per-user directories |
| **Container names** | `{app}-app` | `u{userId}-{app}-app` |
| **Subdomains** | `{app}.domain.com` | `u{userId}-{app}.domain.com` |
| **Limits** | Unlimited | MAX_APPS_PER_USER (configurable) |
| **Auto-sleep** | Optional | Forced (30 min default) |
| **Code-Server** | ✅ | Removed (public bot) |
| **Git integration** | ✅ | Removed (public bot) |
| **CLI** | ✅ | Removed (Telegram only) |
| **Admin panel** | — | Server status + user management |

## Features

- **Auto-registration** — users are created automatically on first `/start`
- **Per-user isolation** — each user has their own directory, projects, and containers
- **Configurable limits** — `MAX_APPS_PER_USER` in `.env` (default: 3)
- **Forced auto-sleep** — idle containers stop after 30 min, wake on HTTP request
- **Admin panel** — server status, user list, ban/unban (for ADMIN_USER_ID)
- **AI-powered builds** — OpenRouter API generates apps from descriptions (cheap!)
- **Build queue** — `MAX_CONCURRENT_BUILDS` prevents server overload
- **Template matching** — accelerated builds with template boilerplate
- **Model selection** — DeepSeek, Llama, or Qwen per build

## Telegram Bot

```
⚡ vps-bot multi
Describe it. Deploy it.

📊 Apps: 1/3
[🚀 My Projects]
[➕ New Project]
```

### User Commands

| Command | Description |
|---|---|
| `/start` | Main menu |
| `/new <name> <desc>` | Create project |
| `/rebuild <name>` | Rebuild project |
| `/list` | List your projects |
| `/url <name>` | Get project URL |
| `/delete <name>` | Delete project |

### Admin (via inline buttons)

- **📊 Server Status** — CPU, RAM, disk, user count, total apps
- **👥 Users** — list all users with app counts

## Configuration

All via `.env`:

```bash
# Required
BOT_TOKEN=your_telegram_bot_token
OPENROUTER_API_KEY=sk-or-v1-your-key
DOMAIN=your-domain.com

# Admin
ADMIN_USER_ID=123456789

# Limits & concurrency
MAX_APPS_PER_USER=3
MAX_CONCURRENT_BUILDS=2
IDLE_TIMEOUT=30

# Optional: override default model
# DEFAULT_MODEL=deepseek/deepseek-chat-v3-0324
```

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
   (user-store)    │  (queue)   (30 min)
       │           │           │
       ▼           ▼           ▼
   /projects/   OpenRouter   Stop idle
   u_{userId}/  → Docker →   Wake on
   {app}/       Caddy        HTTP request
```

### Data Layout

```
/home/vpsbot/projects/
├── users.json                    # All registered users
├── u_12345/                      # User 12345's space
│   ├── projects.json             # User's project registry
│   ├── my-chat-app/              # Project files
│   │   ├── src/
│   │   ├── Dockerfile
│   │   └── docker-compose.yml    # container: u12345-my-chat-app-app
│   └── my-api/
└── u_67890/                      # Another user
    ├── projects.json
    └── todo-app/
```

## Project Structure

```
vps-bot-multi/
├── src/
│   ├── bot.js              # Telegram bot (public, multi-user)
│   ├── commands/
│   │   ├── projects.js     # AI generation + Docker deploy (namespaced)
│   │   └── menu.js         # Inline keyboard menus (per-user)
│   └── lib/
│       ├── config.js       # Environment config + limits
│       ├── user-store.js   # Per-user project store + user management
│       ├── docker-client.js # Dockerode singleton
│       ├── sleep-manager.js # Auto-sleep + wake proxy (multi-user)
│       ├── build-state.js  # In-progress build tracking
│       ├── build-queue.js  # Concurrency limiter (MAX_CONCURRENT_BUILDS)
│       ├── usage.js        # API usage tracking
│       ├── logger.js       # Centralized logging
│       ├── templates.js    # Template sync, matching & boilerplate
│       ├── branding.js     # Branding
│       └── caddy.js        # Caddy admin API
├── logs/                   # All logs
├── docker-compose.yml      # Self-deploy
├── .env.example            # Configuration template
└── package.json
```

## Requirements

- **VPS** with 2+ GB RAM (Ubuntu/Debian recommended)
- **Root access** (projects owned by `vpsbot` user)
- **Ports** 80 and 443 open (for domain mode)
- **OpenRouter API key** from [openrouter.ai](https://openrouter.ai)
- **Telegram Bot Token** from @BotFather

## License

MIT © 2025-2026 [Maksym](https://github.com/maksymhs)

---

<p align="center"><strong>vps-bot-multi</strong> — Describe it. Deploy it. For everyone.</p>
