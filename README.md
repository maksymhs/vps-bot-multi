<p align="center">
  <img src="https://img.shields.io/badge/node-20-339933?logo=node.js&logoColor=white" />
  <img src="https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/claude-AI-D97706?logo=anthropic&logoColor=white" />
  <img src="https://img.shields.io/badge/telegram-bot-26A5E4?logo=telegram&logoColor=white" />
  <img src="https://img.shields.io/badge/license-MIT-green" />
</p>

<h1 align="center">vps-bot</h1>
<p align="center"><strong>Describe it. Deploy it.</strong></p>
<p align="center">AI-powered VPS platform — describe an app, get it running with Docker + SSL in minutes.</p>

---

## How It Works

```
  You: "A real-time chat app with rooms"
   │
   ▼
  Template matching → selects best starter template
   │
   ▼
  Claude Code → customizes & generates full project
   │
   ▼
  Docker → builds & deploys container
   │
   ▼
  Caddy → https://chat.yourdomain.com ✓
```

Manage everything from an **interactive CLI** or **Telegram bot** — same features, two interfaces.

## Quick Start

```bash
curl -sL https://raw.githubusercontent.com/maksymhs/vps-bot/main/install.sh | bash -s -- --clone
```

Or manually:

```bash
git clone https://github.com/maksymhs/vps-bot.git && cd vps-bot && bash install.sh
```

The installer handles everything: Node.js, Docker, Caddy, Claude Code, code-server, user setup, systemd services.

## Features

| | CLI | Telegram |
|---|:---:|:---:|
| **Create project** (AI-generated from description) | ✓ | ✓ |
| **Rebuild** (patch or full regeneration) | ✓ | ✓ |
| **Logs, start, stop, delete** | ✓ | ✓ |
| **Git** (status, commit, push, pull) | ✓ | ✓ |
| **Code-Server** (VS Code in browser) | ✓ | ✓ |
| **Server status** (CPU, RAM, disk) | ✓ | ✓ |
| **Configuration** (domain, Telegram, passwords) | ✓ | — |

## CLI

```
                       __          __
  _   ______  _____   / /_  ____  / /_
  | | / / __ \/ ___/  / __ \/ __ \/ __/
  | |/ / /_/ (__  )  / /_/ / /_/ / /_
  |___/ .___/____/  /_.___/\____/\__/
     /_/          by maksymhs

  Describe it. Deploy it.  ·  v1.0.0

? Navigation
❯ View Projects
  Create New Project
  Server Status
  Docker Containers
  Code-Server (IDE)
  Claude Usage
  ─────────────────
  Configuration
  Exit
```

### Creating a project

```
? Project name: chat-app
? Describe what the app should do: A real-time chat with rooms and nicknames
? Select model: Sonnet (recommended)
? Create "chat-app" with Sonnet? → Create project

  Creating chat-app

  ⠹ Generating code...
  ⠼ Building image...
  ⠧ Verifying...
  ✓ Ready → http://185.x.x.x:4000
```

### Rebuilding

```
? Rebuild mode:
  Patch — add changes to existing code
  Full — regenerate from scratch

? What changes do you want? Add dark mode and user avatars

  Rebuilding chat-app

  ⠹ Applying changes...
  ✓ Ready → http://185.x.x.x:4000
```

## Telegram Bot

```
⚙️ chat-app
🔨 Building image... 1m 12s
```
```
✅ chat-app created
🔗 https://chat.yourdomain.com
[♻️ Rebuild] [📋 Logs]
[🔗 URL]    [⬅️ List]
```

### Commands

| Command | |
|---|---|
| `/new <name> <desc>` | Create project |
| `/rebuild <name>` | Rebuild |
| `/list` | List projects |
| `/status` | Server resources |
| `/logs <name>` | Container logs |
| `/start` `/stop` `/restart` `<name>` | Control container |
| `/delete <name>` | Delete project |

## Domain + SSL

From **Configuration → Set Custom Domain**:

1. Set DNS: `A  *.yourdomain.com → your-server-ip`
2. DNS is verified automatically before applying
3. Caddy Docker Proxy handles SSL via Let's Encrypt
4. Projects get `https://{app}.yourdomain.com`
5. Code-Server at `https://code.yourdomain.com`

No domain? Works with `http://ip:port` out of the box.

## Auto-sleep

Save resources by automatically stopping idle containers. From **Configuration → Auto-sleep**:

```
? Stop idle containers after:
  Disabled
  5 minutes
❯ 10 minutes
  30 minutes
  60 minutes
```

- Containers with no network traffic are stopped after the configured timeout
- Sleeping containers show 🌙 in the project list
- **Wake on request**: visiting a sleeping app shows a "waking up" page and auto-restarts the container
- Wake manually from CLI (`☀️ Wake`) or Telegram
- All sleep/wake events logged to `logs/system.log`

## Templates

vps-bot uses a public template repository ([vps-bot-templates](https://github.com/maksymhs/vps-bot-templates)) to accelerate app generation. When you create a new project, vps-bot automatically:

1. **Syncs** the templates repo (git clone/pull)
2. **Matches** the best template based on your description
3. **Copies** boilerplate files into the project directory
4. **Generates** customized code using template instructions

### Available Templates

| Template | Best for |
|---|---|
| **Express API** | REST APIs, webhooks, microservices |
| **Next.js App** | Dashboards, SaaS, admin panels, full-stack apps |
| **Static Site** | Portfolios, blogs, documentation |
| **React + Vite** | Interactive SPAs, tools, calculators, games |
| **Landing Page** | Marketing pages, product launches, waitlists |
| **Python FastAPI** | Python APIs, ML serving, data processing |

If no template matches your description well enough, vps-bot falls back to the generic build prompt. Templates are only used for new and full rebuild — patch rebuilds modify existing code directly.

Custom template repo: set `TEMPLATES_REPO` in `.env`.

## Architecture

```
┌─────────┐     ┌──────────┐
│   CLI   │     │ Telegram │
└────┬────┘     └────┬─────┘
     └───────┬───────┘
             │
         vps-bot
             │
  ┌──────────┼──────────┬──────────┐
  │          │          │          │
Templates  Claude    Docker     Caddy
 (git)     Code      Build     (SSL)
  │          │          │          │
  ▼          ▼          ▼          ▼
Boiler → Customized → Container → https://
plate      Code
```

## Project Structure

```
vps-bot/
├── src/
│   ├── bot.js              # Telegram bot entry point
│   ├── cli.js              # CLI main menu orchestrator
│   ├── cli-home.js         # CLI entry point (setup check)
│   ├── setup.js            # First-run setup wizard
│   ├── commands/
│   │   ├── projects.js     # AI generation + Docker deploy
│   │   ├── docker.js       # Container management
│   │   ├── git.js          # Git operations
│   │   ├── menu.js         # Telegram inline keyboard menus
│   │   └── status.js       # Server resource stats
│   ├── cli/
│   │   ├── ui.js           # CLI helpers (header, spinner, env)
│   │   ├── screens.js      # Status, containers, code-server screens
│   │   ├── config-screens.js # Domain, Telegram, password, auto-sleep
│   │   └── project-screens.js # Project CRUD, logs, git, rebuild
│   └── lib/
│       ├── config.js       # Environment config
│       ├── store.js        # Project state (JSON file)
│       ├── docker-client.js # Dockerode singleton
│       ├── sleep-manager.js # Auto-sleep + wake proxy
│       ├── build-state.js  # In-progress build tracking
│       ├── code-server.js  # IDE management
│       ├── usage.js        # Claude API usage tracking
│       ├── logger.js       # Centralized logging
│       ├── templates.js    # Template sync, matching & boilerplate
│       ├── branding.js     # Branding + ASCII banner
│       └── caddy.js        # Caddy admin API
├── logs/                   # All logs (system, install, per-project)
├── install.sh              # One-command installer
└── .env                    # Auto-generated config
```

## Tech Stack

| | |
|---|---|
| **AI** | Claude Code (Sonnet / Opus / Haiku) + OpenRouter models |
| **Runtime** | Node.js 20 |
| **Containers** | Docker + Compose |
| **Proxy** | Caddy (auto SSL) |
| **IDE** | code-server |
| **Bot** | Telegraf |
| **CLI** | Inquirer.js + chalk |

## Logs

All logs centralized in `logs/`:

| File | Content |
|---|---|
| `system.log` | General operations |
| `install.log` | Full install process |
| `build-{name}.log` | Per-project: prompt, Claude output, Docker build, health checks |

View from CLI: **Configuration → View System Logs**

## Requirements

- **VPS** with 1+ GB RAM (Ubuntu/Debian recommended)
- **Root access** (everything runs as root except Claude Code)
- **Ports** 80 and 443 open (for domain mode) or any port for IP mode
- **Claude API key** (for Claude Code) or OpenRouter API key

## After Reboot

All services auto-recover after a VPS reboot:

| Component | Auto-starts | Mechanism |
|---|---|---|
| Docker | ✅ | systemd |
| Project containers | ✅ | `restart: unless-stopped` |
| Caddy proxy (SSL) | ✅ | Docker restart policy |
| Code-Server | ✅ | systemd |
| Telegram bot | ✅ | systemd (if enabled) |
| Sleep manager | ✅ | Starts with Telegram bot |

On startup, sleeping flags are reconciled with actual Docker state — containers that Docker restarted are correctly shown as running.

## Troubleshooting

```bash
# Services
systemctl status code-server
systemctl status vps-bot-telegram
docker ps

# Claude Code (runs as vpsbot user)
su - vpsbot -c 'claude --version'
su - vpsbot -c 'claude auth status'

# Build logs
cat logs/build-myapp.log

# Reconfigure
npm run setup
```

## License

MIT © 2025-2026 [Maksym](https://github.com/maksymhs)

---

<p align="center"><strong>vps-bot</strong> — Describe it. Deploy it.</p>
