#!/bin/bash

set -e

# --clone mode: clone repo first, then run install from inside it
if [[ "$1" == "--clone" ]]; then
  REPO="https://github.com/maksymhs/vps-bot.git"
  DEST="/root/vps-bot"
  if [ -d "$DEST" ]; then
    echo "Updating existing installation..."
    cd "$DEST" && git pull --ff-only
  else
    git clone "$REPO" "$DEST"
  fi
  # Re-exec with stdin from TTY so interactive menus work after curl pipe
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
echo "=== VPS-CODE-BOT Install $(date -Iseconds) ===" > "$LOG_FILE"

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
echo -e "${CYAN}${BOLD}                       __          __ ${NC}"
echo -e "${CYAN}${BOLD}  _   ______  _____   / /_  ____  / /_${NC}"
echo -e "${CYAN}${BOLD}  | | / / __ \\/ ___/  / __ \\/ __ \\/ __/${NC}"
echo -e "${CYAN}${BOLD}  | |/ / /_/ (__  )  / /_/ / /_/ / /_ ${NC}"
echo -e "${CYAN}${BOLD}  |___/ .___/____/  /_.___/\\____/\\__/ ${NC}"
echo -e "${CYAN}${BOLD}     /_/          ${NC}${DIM}by maksymhs${NC}"
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

# Caddy
if command -v caddy &> /dev/null; then
    echo -e "  ${GREEN}✔${NC} Caddy $(caddy version 2>/dev/null | awk '{print $1}' || echo '')"
else
    run_silent_sh "Caddy" \
        "apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl && \
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && \
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list && \
        apt-get update && apt-get install -y caddy"
fi

# Claude Code CLI
if command -v claude &> /dev/null; then
    echo -e "  ${GREEN}✔${NC} Claude Code CLI"
    CLAUDE_CLI=$(command -v claude)
else
    run_silent "Claude Code CLI" npm install -g @anthropic-ai/claude-code
    CLAUDE_CLI=$(command -v claude 2>/dev/null || echo "claude")
fi

# Code-Server
if command -v code-server &> /dev/null; then
    echo -e "  ${GREEN}✔${NC} Code-Server"
else
    run_silent_sh "Code-Server" "curl -fsSL https://code-server.dev/install.sh | sh"
fi

# Code-Server extensions & settings
if command -v code-server &> /dev/null; then
    run_silent "Claude Code extension" code-server --install-extension anthropic.claude-code
    # Dark theme + settings
    CS_SETTINGS_DIR="$HOME/.local/share/code-server/User"
    mkdir -p "$CS_SETTINGS_DIR"
    if [ ! -f "$CS_SETTINGS_DIR/settings.json" ]; then
        cat > "$CS_SETTINGS_DIR/settings.json" << 'SETTINGS'
{
    "workbench.colorTheme": "Default Dark Modern",
    "editor.fontSize": 14,
    "editor.minimap.enabled": false,
    "workbench.startupEditor": "none"
}
SETTINGS
    fi
fi

# vpsbot user
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

cd "$INSTALL_DIR"
node src/setup.js --claude-cli "$CLAUDE_CLI" --os "$OS" 2>/dev/null || true

# Source .env
if [ -f "${INSTALL_DIR}/.env" ]; then
    source "${INSTALL_DIR}/.env" 2>/dev/null || true
fi

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

# Network setup
CS_PORT="${CODE_SERVER_PORT:-8080}"
NODE_BIN=$(which node)
PROJECTS_DIR="${PROJECTS_DIR:-/home/vpsbot/projects}"
mkdir -p "$PROJECTS_DIR"

if [ -n "$DOMAIN" ]; then
    # Domain mode: Caddy Docker proxy with Let's Encrypt (HTTPS)
    systemctl stop caddy 2>/dev/null || true
    systemctl disable caddy 2>/dev/null || true
    docker rm -f caddy-proxy 2>/dev/null || true

    run_silent "Caddy proxy → ${DOMAIN}" docker run -d \
        --name caddy-proxy \
        --restart unless-stopped \
        --network caddy \
        -p 80:80 -p 443:443 -p 2019:2019 \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v caddy_data:/data \
        -l "caddy.admin=0.0.0.0:2019" \
        -l "caddy_0=code.${DOMAIN}" \
        -l "caddy_0.reverse_proxy=host.docker.internal:${CS_PORT}" \
        --add-host host.docker.internal:host-gateway \
        lucaslorentz/caddy-docker-proxy:ci-alpine
else
    # IP mode: direct HTTP (no Caddy needed)
    systemctl stop caddy 2>/dev/null || true
    systemctl disable caddy 2>/dev/null || true
    docker rm -f caddy-proxy 2>/dev/null || true
fi

# Code-Server service
if command -v code-server &> /dev/null; then
    CS_PASS="${CODE_SERVER_PASSWORD:-changeme}"
    # Domain mode: localhost only (Caddy proxies). IP mode: public.
    CS_BIND="0.0.0.0:${CS_PORT}"
    [ -n "$DOMAIN" ] && CS_BIND="127.0.0.1:${CS_PORT}"

    mkdir -p "$HOME/.config/code-server"
    cat > "$HOME/.config/code-server/config.yaml" << EOF
bind-addr: ${CS_BIND}
auth: password
password: ${CS_PASS}
cert: false
EOF

    cat > /etc/systemd/system/code-server.service << EOF
[Unit]
Description=Code Server
After=network.target

[Service]
Type=simple
ExecStart=$(which code-server) --disable-telemetry ${PROJECTS_DIR}
Restart=always
RestartSec=5
Environment=HOME=$HOME

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload > /dev/null 2>&1
    systemctl enable code-server > /dev/null 2>&1
    systemctl restart code-server > /dev/null 2>&1
    sleep 1
    if systemctl is-active --quiet code-server; then
        IP_DISPLAY=$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost')
        if [ -n "$DOMAIN" ]; then
            echo -e "  ${GREEN}✔${NC} Code-Server → ${CYAN}https://code.${DOMAIN}${NC}"
        else
            echo -e "  ${GREEN}✔${NC} Code-Server → ${CYAN}http://${IP_DISPLAY}:${CS_PORT}${NC}"
        fi
    fi
fi

# Bot service
cat > /etc/systemd/system/vps-bot-telegram.service << EOF
[Unit]
Description=VPS-CODE-BOT Telegram Bot
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

chown -R "${VPSBOT_USER}:${VPSBOT_USER}" "$PROJECTS_DIR" 2>/dev/null || true

echo ""
echo -e "  ${GREEN}${BOLD}✔ Installation complete${NC}"
echo -e "  ${DIM}Log: ${LOG_FILE}${NC}"
echo ""

# Launch main menu
cd "$INSTALL_DIR"
exec node src/cli-home.js
