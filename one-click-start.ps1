# ============================================================================
#  Qwen Gate — One-Click Setup & Start (Windows PowerShell)
# ============================================================================
#  Downloads, installs, configures, and starts the Qwen Gate server in one go.
#
#  Usage (Windows PowerShell as Administrator):
#    powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/Gautamgg7/qwen-gate-private/main/one-click-start.ps1 | iex"
#
#  Or clone first and run:
#    git clone https://github.com/Gautamgg7/qwen-gate-private.git
#    cd qwen-gate-private
#    powershell -ExecutionPolicy Bypass -File one-click-start.ps1
#
#  What this script does:
#    1. Installs Bun (if not present)
#    2. Installs dependencies (bun install)
#    3. Installs Playwright Chromium (for login + WAF fallback)
#    4. Creates config.json with defaults
#    5. Starts the server
#    6. Opens the dashboard in your browser
#
#  After it starts:
#    - Dashboard: http://localhost:26405/dashboard
#    - API base:  http://localhost:26405/v1
#    - Models:    curl http://localhost:26405/v1/models
# ============================================================================

$ErrorActionPreference = "Stop"

function Write-Info { param([string]$msg) Write-Host "ℹ  $msg" -ForegroundColor Cyan }
function Write-Ok { param([string]$msg) Write-Host "✔  $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "⚠  $msg" -ForegroundColor Yellow }
function Write-Fail { param([string]$msg) Write-Host "✖  $msg" -ForegroundColor Red; exit 1 }

# ── Banner ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ██████╗ ██╗    ██╗███╗   ██╗ ██████╗ ███████╗██╗   ██╗" -ForegroundColor Cyan
Write-Host " ██╔═══██╗██║    ██║████╗  ██║██╔═══██╗██╔════╝██║   ██║" -ForegroundColor Cyan
Write-Host " ██║   ██║██║ █╗ ██║██╔██╗ ██║██║   ██║███████╗██║   ██║" -ForegroundColor Cyan
Write-Host " ██║   ██║██║███╗██║██║╚██╗██║██║   ██║╚════██║╚██╗ ██╔╝" -ForegroundColor Cyan
Write-Host " ╚██████╔╝╚███╔██╝██║ ╚████║╚██████╔╝███████║ ╚████╔╝ " -ForegroundColor Cyan
Write-Host "  ╚═════╝  ╚══╝  ╚═╝   ╚═══╝ ╚═════╝ ╚══════╝  ╚═══╝  " -ForegroundColor Cyan
Write-Host ""
Write-Host "  One-Click Setup & Start" -ForegroundColor Green
Write-Host ""

# ── Step 1: Check for Bun ─────────────────────────────────────────────
Write-Info "Step 1/6: Checking for Bun..."
$bunInstalled = $false
try {
    $bunVersion = bun --version 2>$null
    if ($bunVersion) {
        Write-Ok "Bun $bunVersion already installed"
        $bunInstalled = $true
    }
} catch {}

if (-not $bunInstalled) {
    Write-Info "Installing Bun..."
    try {
        irm bun.sh/install.ps1 | iex
        $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
        Refresh-Path
        Write-Ok "Bun installed"
    } catch {
        Write-Fail "Bun installation failed. Install manually: https://bun.sh"
    }
}

# ── Step 2: Clone or find the repo ────────────────────────────────────
Write-Info "Step 2/6: Setting up project..."
if (Test-Path "package.json") {
    $content = Get-Content "package.json" -Raw
    if ($content -match "qwen-gate") {
        $projectRoot = (Get-Location).Path
        Write-Ok "Running from repo: $projectRoot"
    }
} elseif (Test-Path "qwen-gate-private\package.json") {
    $projectRoot = Join-Path (Get-Location).Path "qwen-gate-private"
    Set-Location $projectRoot
    Write-Ok "Found existing clone: $projectRoot"
} else {
    Write-Info "Cloning qwen-gate-private..."
    git clone --depth 1 https://github.com/Gautamgg7/qwen-gate-private.git
    $projectRoot = Join-Path (Get-Location).Path "qwen-gate-private"
    Set-Location $projectRoot
    Write-Ok "Cloned to $projectRoot"
}

# ── Step 3: Install dependencies ──────────────────────────────────────
Write-Info "Step 3/6: Installing dependencies..."
bun install
Write-Ok "Dependencies installed"

# ── Step 4: Install Playwright Chromium ──────────────────────────────
Write-Info "Step 4/6: Installing Playwright Chromium..."
try {
    bunx playwright install chromium
    Write-Ok "Playwright Chromium installed"
} catch {
    Write-Warn "Playwright browser install failed — continuing anyway"
}

# ── Step 5: Create config.json ───────────────────────────────────────
Write-Info "Step 5/6: Creating config.json..."
if (-not (Test-Path "config.json")) {
    $config = @{
        PORT = "26405"
        HOST = ""
        API_KEY = ""
        TOOL_CALLING = "true"
        CLEAN_OUTPUT = "true"
        STREAMING_MODE = "auto"
        MAX_TOOL_CALLS_PER_RESPONSE = "3"
        QWEN_FETCH_TIMEOUT_MS = "60000"
        AUTH_TOKEN_MAX_AGE_MS = "28800000"
        AUTH_REFRESH_BEFORE_MS = "300000"
        DELETE_SESSION = "true"
        RATE_LIMIT_COOLDOWN_MS = "120000"
        MAX_LOGS = "50"
        CUSTOM_INSTRUCTION = ""
        USE_CUSTOM_INSTRUCTION = "false"
        SAVE_REQUEST_LOGS = "false"
        RETRY_MAX_ATTEMPTS = "3"
        OPEN_DASHBOARD_ON_START = "false"
        RETRY_BASE_DELAY_MS = "1000"
        RETRY_MAX_DELAY_MS = "30000"
        RETRY_BACKOFF_MULTIPLIER = "2"
        RETRY_ENABLED = "true"
        STREAM_IDLE_TIMEOUT_MS = "300000"
        MODELS_CACHE_TTL_MS = "3600000"
        SESSION_POOL_SIZE = "2"
        SESSION_MAX_TURNS = "50"
        SESSION_IDLE_TTL_MS = "900000"
        CONVERSATION_REUSE = "true"
        HEADER_CACHE_TTL_MS = "60000"
        MAX_INLINE_CHARS = "120000"
        CONTEXT_COMPRESSION_THRESHOLD = "150000"
        CONTEXT_SUMMARY_CHUNK_TOKENS = "20000"
        ACCOUNT_HEALTH_THRESHOLD = "0.6"
        MAX_REQUEST_ACCOUNT_ATTEMPTS = "5"
        CLAUDE_CODE_PROXY = "false"
    }
    $config | ConvertTo-Json | Set-Content "config.json"
    Write-Ok "config.json created"
} else {
    Write-Ok "config.json already exists"
}

# ── Step 6: Start the server ─────────────────────────────────────────
Write-Info "Step 6/6: Starting Qwen Gate server..."
Write-Host ""
Write-Host "  ═══════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  Qwen Gate is starting!" -ForegroundColor Green
Write-Host "  ═══════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "  Dashboard:  http://localhost:26405/dashboard" -ForegroundColor White
Write-Host "  API base:   http://localhost:26405/v1" -ForegroundColor White
Write-Host "  Models:     curl http://localhost:26405/v1/models" -ForegroundColor White
Write-Host ""
Write-Host "  Press Ctrl+C to stop the server" -ForegroundColor DarkGray
Write-Host ""

# Open dashboard after 3 seconds
Start-Job -ScriptBlock {
    Start-Sleep 3
    Start-Process "http://localhost:26405/dashboard"
} | Out-Null

# Start the server
bun start
