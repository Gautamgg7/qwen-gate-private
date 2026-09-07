#!/usr/bin/env bash
# ============================================================================
#  Qwen Gate — One-Click Setup & Start
# ============================================================================
#  Downloads, installs, configures, and starts the Qwen Gate server in one go.
#
#  Usage (Linux / macOS):
#    curl -sSL https://raw.githubusercontent.com/Gautamgg7/qwen-gate-private/main/one-click-start.sh | bash
#
#  Or clone first and run:
#    git clone https://github.com/Gautamgg7/qwen-gate-private.git
#    cd qwen-gate-private
#    bash one-click-start.sh
#
#  What this script does:
#    1. Installs Bun (if not present)
#    2. Installs dependencies (bun install)
#    3. Installs Playwright Chromium (for login + WAF fallback)
#    4. (Optional) Installs Rust + Python + browser_oxide for stealth mode
#    5. Creates config.json with defaults
#    6. Starts the server
#    7. Opens the dashboard in your browser
#
#  After it starts:
#    - Dashboard: http://localhost:26405/dashboard
#    - API base:  http://localhost:26405/v1
#    - Models:    curl http://localhost:26405/v1/models
# ============================================================================

set -e

# ── Colors ─────────────────────────────────────────────────────────────
RED='\033[0;31m'   GREEN='\033[0;32m'  YELLOW='\033[0;33m'
CYAN='\033[0;36m'  BOLD='\033[1m'      DIM='\033[2m'      RESET='\033[0m'

info()  { printf "${CYAN}ℹ${RESET}  %s\n" "$*"; }
ok()    { printf "${GREEN}✔${RESET}  %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${RESET}  %s\n" "$*"; }
fail()  { printf "${RED}✖${RESET}  %s\n" "$*" >&2; exit 1; }

# ── Detect platform ────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux*)  PLATFORM="linux"  ;;
  Darwin*) PLATFORM="macos"  ;;
  *)       fail "Unsupported OS: $OS (Linux and macOS only)" ;;
esac

# ── Banner ─────────────────────────────────────────────────────────────
echo ""
printf "${BOLD}${CYAN}"
cat << 'BANNER'
  ██████╗ ██╗    ██╗███╗   ██╗ ██████╗ ███████╗██╗   ██╗
 ██╔═══██╗██║    ██║████╗  ██║██╔═══██╗██╔════╝██║   ██║
 ██║   ██║██║ █╗ ██║██╔██╗ ██║██║   ██║███████╗██║   ██║
 ██║   ██║██║███╗██║██║╚██╗██║██║   ██║╚════██║╚██╗ ██╔╝
 ╚██████╔╝╚███╔██╝██║ ╚████║╚██████╔╝███████║ ╚████╔╝
  ╚═════╝  ╚══╝  ╚═╝   ╚═══╝ ╚═════╝ ╚══════╝  ╚═══╝

  One-Click Setup & Start
BANNER
printf "${RESET}"
echo ""

# ── Step 1: Check for Bun ─────────────────────────────────────────────
info "Step 1/7: Checking for Bun..."
if command -v bun &>/dev/null; then
  ok "Bun $(bun --version) already installed"
else
  info "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun &>/dev/null || fail "Bun installation failed. Install manually: https://bun.sh"
  ok "Bun $(bun --version) installed"
fi

# ── Step 2: Clone or find the repo ────────────────────────────────────
info "Step 2/7: Setting up project..."
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"

# If we're running from the repo directory, use it
if [ -f "package.json" ] && grep -q "qwen-gate" package.json 2>/dev/null; then
  PROJECT_ROOT="$(pwd)"
  ok "Running from repo: $PROJECT_ROOT"
elif [ -d "qwen-gate-private" ] && [ -f "qwen-gate-private/package.json" ]; then
  PROJECT_ROOT="$(pwd)/qwen-gate-private"
  ok "Found existing clone: $PROJECT_ROOT"
else
  # Clone the repo
  info "Cloning qwen-gate-private..."
  git clone --depth 1 https://github.com/Gautamgg7/qwen-gate-private.git 2>/dev/null || \
    fail "Failed to clone. Check your internet connection."
  PROJECT_ROOT="$(pwd)/qwen-gate-private"
  ok "Cloned to $PROJECT_ROOT"
fi

cd "$PROJECT_ROOT" || fail "Could not enter $PROJECT_ROOT"

# ── Step 3: Install dependencies ──────────────────────────────────────
info "Step 3/7: Installing dependencies..."
bun install 2>/dev/null || fail "bun install failed"
ok "Dependencies installed"

# ── Step 4: Install Playwright Chromium (for login + WAF fallback) ──
info "Step 4/7: Installing Playwright Chromium..."
if bunx playwright install chromium 2>/dev/null; then
  ok "Playwright Chromium installed"
else
  warn "Playwright browser install failed — continuing anyway"
fi

# ── Step 5: Create config.json if not exists ────────────────────────
info "Step 5/7: Creating config.json..."
if [ ! -f config.json ]; then
  cat > config.json << 'CONFIG'
{
  "PORT": "26405",
  "HOST": "",
  "API_KEY": "",
  "TOOL_CALLING": "true",
  "CLEAN_OUTPUT": "true",
  "STREAMING_MODE": "auto",
  "MAX_TOOL_CALLS_PER_RESPONSE": "3",
  "QWEN_FETCH_TIMEOUT_MS": "60000",
  "AUTH_TOKEN_MAX_AGE_MS": "28800000",
  "AUTH_REFRESH_BEFORE_MS": "300000",
  "DELETE_SESSION": "true",
  "RATE_LIMIT_COOLDOWN_MS": "120000",
  "MAX_LOGS": "50",
  "CUSTOM_INSTRUCTION": "",
  "USE_CUSTOM_INSTRUCTION": "false",
  "SAVE_REQUEST_LOGS": "false",
  "RETRY_MAX_ATTEMPTS": "3",
  "OPEN_DASHBOARD_ON_START": "false",
  "RETRY_BASE_DELAY_MS": "1000",
  "RETRY_MAX_DELAY_MS": "30000",
  "RETRY_BACKOFF_MULTIPLIER": "2",
  "RETRY_ENABLED": "true",
  "STREAM_IDLE_TIMEOUT_MS": "300000",
  "MODELS_CACHE_TTL_MS": "3600000",
  "SESSION_POOL_SIZE": "2",
  "SESSION_MAX_TURNS": "50",
  "SESSION_IDLE_TTL_MS": "900000",
  "CONVERSATION_REUSE": "true",
  "HEADER_CACHE_TTL_MS": "60000",
  "MAX_INLINE_CHARS": "120000",
  "CONTEXT_COMPRESSION_THRESHOLD": "150000",
  "CONTEXT_SUMMARY_CHUNK_TOKENS": "20000",
  "ACCOUNT_HEALTH_THRESHOLD": "0.6",
  "MAX_REQUEST_ACCOUNT_ATTEMPTS": "5",
  "CLAUDE_CODE_PROXY": "false"
}
CONFIG
  ok "config.json created"
else
  ok "config.json already exists"
fi

# ── Step 6: Optional — Install browser_oxide (Rust stealth engine) ──
info "Step 6/7: Checking for browser_oxide (optional stealth mode)..."
if command -v python3 &>/dev/null && python3 -c "from browser_oxide import Browser" 2>/dev/null; then
  ok "browser_oxide Python bindings already available"
elif [ "${SKIP_BROWSER_OXIDE:-0}" = "1" ]; then
  warn "browser_oxide skipped (SKIP_BROWSER_OXIDE=1)"
else
  warn "browser_oxide not found — stealth mode will use cloakbrowser fallback"
  info "  To install browser_oxide (Rust stealth engine):"
  info "    1. Install Rust:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  info "    2. Install deps: sudo apt install cmake libclang-dev (Linux)"
  info "    3. Build:        git clone https://github.com/yfedoseev/browser_oxide.git"
  info "    4. Build:        cd browser_oxide && cargo build --release -p browser_oxide"
  info "    5. Python:       cd crates/browser_oxide_py && pip install maturin && maturin develop --release"
  info "  Or run the full installer: bash install.sh"
  info "  Skipping for now — the server will use cloakbrowser (Playwright Chromium) as fallback"
fi

# ── Step 7: Start the server ─────────────────────────────────────────
info "Step 7/7: Starting Qwen Gate server..."
echo ""
printf "${BOLD}${GREEN}"
echo "  ═══════════════════════════════════════════════════"
echo "  Qwen Gate is starting!"
echo "  ═══════════════════════════════════════════════════"
printf "${RESET}"
echo ""
echo "  ${BOLD}Dashboard:${RESET}  http://localhost:26405/dashboard"
echo "  ${BOLD}API base:${RESET}   http://localhost:26405/v1"
echo "  ${BOLD}Models:${RESET}     curl http://localhost:26405/v1/models"
echo ""
echo "  ${DIM}Press Ctrl+C to stop the server${RESET}"
echo ""

# Open dashboard in browser (if possible)
if [ "$PLATFORM" = "macos" ]; then
  (sleep 3 && open http://localhost:26405/dashboard) &
elif [ "$PLATFORM" = "linux" ]; then
  (sleep 3 && xdg-open http://localhost:26405/dashboard 2>/dev/null) &
fi

# Start the server (foreground)
exec bun start
