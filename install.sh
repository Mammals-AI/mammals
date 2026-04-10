#!/bin/bash
# Mammals Installer — downloads, installs deps, and launches the web setup wizard
set -e

ORANGE='\033[0;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

echo ""
echo "${BOLD}  ┌─────────────────────────────────┐"
echo "  │       Mammals v1.0 Installer     │"
echo "  │    Personal AI Agent System       │"
echo "  └─────────────────────────────────┘${RESET}"
echo ""

# ── Check macOS ──
if [[ "$(uname)" != "Darwin" ]]; then
  echo "${RED}  ✗ Mammals currently requires macOS.${RESET}"
  exit 1
fi
echo "${GREEN}  ✓${RESET} macOS detected"

# ── Check/install Homebrew ──
if ! command -v brew &>/dev/null; then
  echo "${DIM}    Homebrew not found — installing...${RESET}"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add to path for Apple Silicon
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
fi
echo "${GREEN}  ✓${RESET} Homebrew"

# ── Check/install Node.js ──
if ! command -v node &>/dev/null; then
  echo "${DIM}    Node.js not found — installing via Homebrew...${RESET}"
  brew install node
fi
NODE_VER=$(node -v)
NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "${RED}  ✗ Node.js $NODE_VER is too old (need 20+). Upgrading...${RESET}"
  brew upgrade node
fi
echo "${GREEN}  ✓${RESET} Node.js $(node -v)"

# ── Check/install Python 3 ──
if ! command -v python3 &>/dev/null; then
  echo "${DIM}    Python 3 not found — installing via Homebrew...${RESET}"
  brew install python3
fi
echo "${GREEN}  ✓${RESET} $(python3 --version)"

# ── Install Flask ──
if ! python3 -c "import flask" 2>/dev/null; then
  echo "${DIM}    Installing Flask...${RESET}"
  python3 -m pip install flask --break-system-packages -q 2>/dev/null || pip3 install flask -q
fi
echo "${GREEN}  ✓${RESET} Flask"

# ── Check Claude Code CLI ──
if ! command -v claude &>/dev/null; then
  echo ""
  echo "${ORANGE}  Claude Code CLI not found.${RESET}"
  echo "${DIM}    You'll need to install it before Mammals can run.${RESET}"
  echo "${DIM}    The setup wizard will walk you through it.${RESET}"
  echo ""
fi

# ── Choose install directory ──
INSTALL_DIR="$HOME/mammals"
echo ""
echo "${DIM}    Install location: $INSTALL_DIR${RESET}"

if [[ -d "$INSTALL_DIR" ]]; then
  echo "${GREEN}  ✓${RESET} Mammals directory exists — updating"
  cd "$INSTALL_DIR"
  git pull origin main 2>/dev/null || true
else
  echo "${DIM}    Cloning Mammals...${RESET}"
  git clone https://github.com/Mammals-AI/mammals.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ── Install npm deps ──
echo "${DIM}    Installing dependencies...${RESET}"
npm install --silent 2>/dev/null
echo "${GREEN}  ✓${RESET} Dependencies installed"

# ── Build TypeScript ──
echo "${DIM}    Building...${RESET}"
npm run build --silent 2>/dev/null
echo "${GREEN}  ✓${RESET} Build complete"

# ── Launch setup wizard ──
echo ""
echo "${BOLD}  ┌─────────────────────────────────┐"
echo "  │     Opening Setup Wizard...      │"
echo "  └─────────────────────────────────┘${RESET}"
echo ""

# Kill any existing HQ on 5067
lsof -ti :5067 2>/dev/null | xargs kill 2>/dev/null || true
sleep 1

# Start HQ (which serves the setup wizard)
cd "$INSTALL_DIR/workspace/pack-hq"
nohup python3 app.py > /tmp/mammals-hq.log 2>&1 &
sleep 2

# Open setup wizard in browser
SETUP_URL="http://localhost:5067/setup"
echo "${GREEN}  ✓${RESET} Setup wizard running at: ${BOLD}$SETUP_URL${RESET}"
echo ""
open "$SETUP_URL" 2>/dev/null || echo "${DIM}    Open $SETUP_URL in your browser${RESET}"
echo "${DIM}    Complete the setup in your browser to finish installation.${RESET}"
echo ""
