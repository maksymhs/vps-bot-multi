#!/bin/bash

set -e

# --clone mode: clone repo first, then run install from inside it
if [[ "$1" == "--clone" ]]; then
  REPO="https://github.com/maksymhs/vps-bot-multi.git"
  DEST="/root/vps-bot-multi"
  if [ -d "$DEST" ]; then
    echo "Updating existing installation..."
    cd "$DEST" && git pull --ff-only
  else
    git clone "$REPO" "$DEST"
  fi
  # Re-exec with stdin from TTY so interactive prompts work after curl pipe
  exec bash "$DEST/install.sh" < /dev/tty
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

chmod +x "${BASH_SOURCE[0]}" 2>/dev/null || true

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="${INSTALL_DIR}/logs"
mkdir -p "$LOGS_DIR"
LOG_FILE="${LOGS_DIR}/install.log"

# Init log file
echo "=== VPS-BOT-MULTI Install $(date -Iseconds) ===" > "$LOG_FILE"

log() {
    echo "[$(date '+%H:%M:%S')] $*" >> "$LOG_FILE"
}

# Spinner frames
SPINNER_FRAMES=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')

# Animated runner — spinner while command runs, log all output
run_silent() {
    local msg="$1"
    shift
    log "START: $msg — $*"
    printf "  ${CYAN}⠋${NC} ${GRAY}%s${NC}" "$msg"

    # Run command, capture output to log
    local tmpout
    tmpout=$(mktemp)
    "$@" > "$tmpout" 2>&1 &
    local pid=$!
    local i=0

    while kill -0 "$pid" 2>/dev/null; do
        printf "\r  ${CYAN}%s${NC} ${GRAY}%s${NC}" "${SPINNER_FRAMES[$((i % 10))]}" "$msg"
        i=$((i + 1))
        sleep 0.1
    done

    wait "$pid"
    local rc=$?
    cat "$tmpout" >> "$LOG_FILE"
    rm -f "$tmpout"

    if [ $rc -eq 0 ]; then
        printf "\r  ${GREEN}✔${NC} %s${NC}                              \n" "$msg"
        log "  OK: $msg"
        return 0
    else
        printf "\r  ${RED}✘${NC} %s ${DIM}(see install.log)${NC}       \n" "$msg"
        log "FAIL: $msg (exit $rc)"
        return 1
    fi
}

# Animated runner for piped commands (bash -c)
run_silent_sh() {
    local msg="$1"
    shift
    log "START: $msg — $*"
    printf "  ${CYAN}⠋${NC} ${GRAY}%s${NC}" "$msg"

    local tmpout
    tmpout=$(mktemp)
    bash -c "$*" > "$tmpout" 2>&1 &
    local pid=$!
    local i=0

    while kill -0 "$pid" 2>/dev/null; do
        printf "\r  ${CYAN}%s${NC} ${GRAY}%s${NC}" "${SPINNER_FRAMES[$((i % 10))]}" "$msg"
        i=$((i + 1))
        sleep 0.1
    done

    wait "$pid"
    local rc=$?
    cat "$tmpout" >> "$LOG_FILE"
    rm -f "$tmpout"

    if [ $rc -eq 0 ]; then
        printf "\r  ${GREEN}✔${NC} %s                              \n" "$msg"
        log "  OK: $msg"
        return 0
    else
        printf "\r  ${RED}✘${NC} %s ${DIM}(see install.log)${NC}       \n" "$msg"
        log "FAIL: $msg (exit $rc)"
        return 1
    fi
}

echo ""
echo -e "${CYAN}${BOLD}  _   ______  _____   / /_  ____  / /_   __ _  __ __  / / /_(_)${NC}"
echo -e "${CYAN}${BOLD}  | | / / __ \\/ ___/  / __ \\/ __ \\/ __/  /  ' \\/ // / / / __/ /${NC}"
echo -e "${CYAN}${BOLD}  | |/ / /_/ (__  )  / /_/ / /_/ / /_   /_/_/_/\\_,_/ /_/\\__/_/ ${NC}"
echo -e "${CYAN}${BOLD}  |___/ .___/____/  /_.___/\\____/\\__/                           ${NC}"
echo -e "${CYAN}${BOLD}     /_/          ${NC}${DIM}multi-user · by maksymhs${NC}"
echo ""

# Detect OS
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
else
    echo -e "  ${RED}✘ Unsupported OS: $OSTYPE${NC}"
    exit 1
fi

log "OS=$OS INSTALL_DIR=$INSTALL_DIR"

echo -e "  ${CYAN}${BOLD}Dependencies${NC}"
echo -e "  ${DIM}──────────────────────────────────────────${NC}"

# Node.js
if command -v node &> /dev/null; then
    echo -e "  ${GREEN}✔${NC} Node.js $(node --version)"
else
    run_silent_sh "Node.js" "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs"
fi

# Docker
if command -v docker &> /dev/null; then
    echo -e "  ${GREEN}✔${NC} Docker $(docker --version 2>/dev/null | awk '{print $3}' | cut -d',' -f1)"
else
    run_silent_sh "Docker" "curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sh /tmp/get-docker.sh && rm /tmp/get-docker.sh"
fi

# Caddy (only needed for domain mode, but install always)
if command -v caddy &> /dev/null; then
    echo -e "  ${GREEN}✔${NC} Caddy $(caddy version 2>/dev/null | awk '{print $1}' || echo '')"
else
    run_silent_sh "Caddy" \
        "apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl && \
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && \
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list && \
        apt-get update && apt-get install -y caddy"
fi

# vpsbot user (for project file ownership)
VPSBOT_USER="vpsbot"
VPSBOT_HOME="/home/${VPSBOT_USER}"
if id "$VPSBOT_USER" &>/dev/null; then
    echo -e "  ${GREEN}✔${NC} User '${VPSBOT_USER}'"
else
    run_silent "User '${VPSBOT_USER}'" useradd -m -s /bin/bash "$VPSBOT_USER"
fi

chmod -R o+rX "$INSTALL_DIR" 2>/dev/null || true

# npm install
echo ""
echo -e "  ${CYAN}${BOLD}Setup${NC}"
echo -e "  ${DIM}──────────────────────────────────────────${NC}"
run_silent "npm install" bash -c "cd '$INSTALL_DIR' && npm install"

# Interactive setup — ask for required config
if [ -f "${INSTALL_DIR}/.env" ]; then
    source "${INSTALL_DIR}/.env" 2>/dev/null || true
    echo -e "  ${GREEN}✔${NC} .env exists"
else
    cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
fi

echo ""
echo -e "  ${CYAN}${BOLD}Configuration${NC}"
echo -e "  ${DIM}──────────────────────────────────────────${NC}"

# BOT_TOKEN
if [ -z "$BOT_TOKEN" ] || [ "$BOT_TOKEN" = "your_telegram_bot_token" ]; then
    echo -e "  ${YELLOW}?${NC} Telegram Bot Token ${DIM}(from @BotFather)${NC}"
    read -rp "    → " BOT_TOKEN
    if [ -n "$BOT_TOKEN" ]; then
        sed -i "s|^BOT_TOKEN=.*|BOT_TOKEN=${BOT_TOKEN}|" "${INSTALL_DIR}/.env"
        echo -e "  ${GREEN}✔${NC} BOT_TOKEN saved"
    else
        echo -e "  ${YELLOW}!${NC} Skipped — set BOT_TOKEN in .env later"
    fi
else
    echo -e "  ${GREEN}✔${NC} BOT_TOKEN"
fi

# OPENROUTER_API_KEY (required — DeepSeek code generation)
if [ -z "$OPENROUTER_API_KEY" ] || [ "$OPENROUTER_API_KEY" = "sk-or-v1-your-key-here" ]; then
    echo -e "  ${YELLOW}?${NC} OpenRouter API Key ${DIM}(openrouter.ai/keys — uses DeepSeek V3)${NC}"
    read -rp "    → " OPENROUTER_API_KEY
    if [ -n "$OPENROUTER_API_KEY" ]; then
        sed -i "s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=${OPENROUTER_API_KEY}|" "${INSTALL_DIR}/.env"
        echo -e "  ${GREEN}✔${NC} OPENROUTER_API_KEY saved"
    else
        echo -e "  ${YELLOW}!${NC} Skipped — set OPENROUTER_API_KEY in .env later"
    fi
else
    echo -e "  ${GREEN}✔${NC} OPENROUTER_API_KEY"
fi

# DOMAIN or IP
if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "your-domain.com" ]; then
    echo -e "  ${YELLOW}?${NC} Domain ${DIM}(e.g. apps.example.com, or leave empty for IP mode)${NC}"
    read -rp "    → " INPUT_DOMAIN
    if [ -n "$INPUT_DOMAIN" ]; then
        DOMAIN="$INPUT_DOMAIN"
        sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" "${INSTALL_DIR}/.env"
        echo -e "  ${GREEN}✔${NC} DOMAIN → ${DOMAIN}"
    else
        # Auto-detect IP
        SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || curl -s ifconfig.me 2>/dev/null || echo "")
        if [ -n "$SERVER_IP" ]; then
            sed -i "s|^# IP_ADDRESS=.*|IP_ADDRESS=${SERVER_IP}|" "${INSTALL_DIR}/.env"
            sed -i "s|^DOMAIN=.*|# DOMAIN=|" "${INSTALL_DIR}/.env"
            echo -e "  ${GREEN}✔${NC} IP mode → ${SERVER_IP}"
        else
            echo -e "  ${YELLOW}!${NC} Skipped — set DOMAIN or IP_ADDRESS in .env later"
        fi
    fi
else
    echo -e "  ${GREEN}✔${NC} DOMAIN → ${DOMAIN}"
fi

# ADMIN_USER_ID
if [ -z "$ADMIN_USER_ID" ] || [ "$ADMIN_USER_ID" = "123456789" ]; then
    echo -e "  ${YELLOW}?${NC} Your Telegram User ID ${DIM}(optional — press Enter to auto-detect)${NC}"
    echo -e "    ${DIM}The first person to /start the bot becomes admin automatically${NC}"
    read -rp "    → " ADMIN_USER_ID
    if [ -n "$ADMIN_USER_ID" ]; then
        sed -i "s|^ADMIN_USER_ID=.*|ADMIN_USER_ID=${ADMIN_USER_ID}|" "${INSTALL_DIR}/.env"
        echo -e "  ${GREEN}✔${NC} ADMIN_USER_ID → ${ADMIN_USER_ID}"
    else
        echo -e "  ${GREEN}✔${NC} Admin will be auto-assigned to first /start user"
    fi
else
    echo -e "  ${GREEN}✔${NC} ADMIN_USER_ID → ${ADMIN_USER_ID}"
fi

# Re-source .env with new values
source "${INSTALL_DIR}/.env" 2>/dev/null || true

echo ""
echo -e "  ${CYAN}${BOLD}Services${NC}"
echo -e "  ${DIM}──────────────────────────────────────────${NC}"

# Docker daemon
if ! docker info &> /dev/null; then
    run_silent "Starting Docker" bash -c "systemctl start docker && systemctl enable docker"
fi

# Docker network
if ! docker network ls --format '{{.Name}}' | grep -qx 'caddy'; then
    run_silent "Docker network 'caddy'" docker network create caddy
fi

# Pre-pull node:20-alpine so first user build skips the download
run_silent "Pre-pulling node:20-alpine" docker pull node:20-alpine

# Pre-warm BuildKit npm cache with the most common packages.
# This populates /root/.npm so the first real app build is fast.
WARMUP_DIR=$(mktemp -d)
cat > "${WARMUP_DIR}/package.json" << 'PKGJSON'
{
  "name": "vpsbot-warmup",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "express": "^4",
    "cors": "^2",
    "dotenv": "^16",
    "helmet": "^7",
    "uuid": "^9",
    "node-fetch": "^3"
  }
}
PKGJSON
cat > "${WARMUP_DIR}/Dockerfile" << 'WARMUPEOF'
# syntax=docker/dockerfile:1
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev
WARMUPEOF
run_silent "Pre-warming npm cache" bash -c "DOCKER_BUILDKIT=1 docker build -t vpsbot-warmup:tmp '${WARMUP_DIR}' && docker rmi vpsbot-warmup:tmp"
rm -rf "${WARMUP_DIR}"

# Network setup
NODE_BIN=$(which node)
PROJECTS_DIR="${PROJECTS_DIR:-/home/vpsbot/projects}"
mkdir -p "$PROJECTS_DIR"

if [ -n "$DOMAIN" ]; then
    # Domain mode: Caddy Docker proxy with Let's Encrypt (HTTPS)
    systemctl stop caddy 2>/dev/null || true
    systemctl disable caddy 2>/dev/null || true
    docker rm -f caddy-proxy 2>/dev/null || true

    run_silent "Caddy proxy → *.${DOMAIN}" docker run -d \
        --name caddy-proxy \
        --restart unless-stopped \
        --network caddy \
        -p 80:80 -p 443:443 -p 2019:2019 \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v caddy_data:/data \
        -l "caddy.admin=0.0.0.0:2019" \
        --add-host host.docker.internal:host-gateway \
        lucaslorentz/caddy-docker-proxy:ci-alpine
else
    # IP mode: direct HTTP (no Caddy needed)
    systemctl stop caddy 2>/dev/null || true
    systemctl disable caddy 2>/dev/null || true
    docker rm -f caddy-proxy 2>/dev/null || true
    echo -e "  ${YELLOW}!${NC} No DOMAIN set — apps will use http://IP:PORT"
fi

# Bot systemd service
cat > /etc/systemd/system/vps-bot-multi.service << EOF
[Unit]
Description=VPS-BOT-MULTI Telegram Bot
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} src/bot.js
Restart=always
RestartSec=10
EnvironmentFile=${INSTALL_DIR}/.env
Environment=HOME=$HOME

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload > /dev/null 2>&1
systemctl enable vps-bot-multi > /dev/null 2>&1

chown -R "${VPSBOT_USER}:${VPSBOT_USER}" "$PROJECTS_DIR" 2>/dev/null || true

# Start bot if BOT_TOKEN is set
if [ -n "$BOT_TOKEN" ] && [ "$BOT_TOKEN" != "your_telegram_bot_token" ]; then
    run_silent "Starting bot" bash -c "systemctl restart vps-bot-multi"
    echo -e "  ${GREEN}✔${NC} Bot running as systemd service"
else
    echo -e "  ${YELLOW}!${NC} BOT_TOKEN not set — edit .env and run: ${CYAN}systemctl start vps-bot-multi${NC}"
fi

echo ""
echo -e "  ${GREEN}${BOLD}✔ Installation complete${NC}"
echo -e "  ${DIM}Log: ${LOG_FILE}${NC}"

echo ""
source "${INSTALL_DIR}/.env" 2>/dev/null || true

BOT_MISSING=false
{ [ -z "$BOT_TOKEN" ] || [ "$BOT_TOKEN" = "your_telegram_bot_token" ]; } && BOT_MISSING=true

OR_MISSING=false
{ [ -z "$OPENROUTER_API_KEY" ] || [ "$OPENROUTER_API_KEY" = "sk-or-v1-your-key-here" ]; } && OR_MISSING=true

if [ "$BOT_MISSING" = false ] && [ "$OR_MISSING" = false ]; then
    echo -e "  ${GREEN}${BOLD}Bot is running! Open Telegram and send /start${NC}"
    echo -e "  ${DIM}Manage: systemctl status vps-bot-multi${NC}"
else
    echo -e "  ${YELLOW}${BOLD}Next steps:${NC}"
    [ "$BOT_MISSING" = true ] && echo -e "  ${DIM}• Edit .env → set BOT_TOKEN${NC}"
    [ "$OR_MISSING" = true ] && echo -e "  ${DIM}• Edit .env → set OPENROUTER_API_KEY (get from openrouter.ai/keys)${NC}"
fi
echo ""
