#!/bin/bash

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

# Configuration
REPO_URL="${VPS_BOT_REPO_URL:-https://github.com/maksymhs/vps-bot.git}"
REPO_NAME="vps-bot"

echo -e "${CYAN}"
echo "┌─────────────────────────────────────────────────────┐"
echo "│                                                     │"
echo "│         VPS-CODE-BOT INSTALLATION                  │"
echo "│    Smart VPS Management Platform Setup              │"
echo "│                                                     │"
echo "└─────────────────────────────────────────────────────┘"
echo -e "${NC}\n"

# Check if already in repo
if [ -f "install.sh" ] && [ -f "package.json" ] && grep -q "vps-code-bot" package.json 2>/dev/null; then
    echo -e "${CYAN}Running installation from current directory...${NC}\n"
else
    # Clone repository
    echo -e "${CYAN}Cloning repository...${NC}"

    # Check if directory exists
    if [ -d "$REPO_NAME" ]; then
        echo -e "${YELLOW}Directory $REPO_NAME already exists${NC}"
        read -p "Remove and clone fresh? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            rm -rf "$REPO_NAME"
        else
            cd "$REPO_NAME"
            echo -e "${CYAN}Using existing directory${NC}\n"
        fi
    fi

    if [ ! -d "$REPO_NAME" ]; then
        git clone "$REPO_URL" "$REPO_NAME"
    fi

    cd "$REPO_NAME"
    echo -e "${GREEN}✓ Repository ready${NC}\n"
fi

# Check if install.sh exists
if [ ! -f "install.sh" ]; then
    echo -e "${RED}Error: install.sh not found${NC}"
    exit 1
fi

# Make install.sh executable
chmod +x install.sh

# Run installation
echo -e "${CYAN}━━━ Starting Setup ━━━${NC}\n"
bash install.sh
