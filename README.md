# Qwen Gate

<p align="center">
  <img src="media/banner.svg" alt="Qwen Gate Banner" width="100%">
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.3+-pink.svg)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-browser__oxide-orange.svg)](https://github.com/yfedoseev/browser_oxide)
[![Tests](https://img.shields.io/badge/Tests-154%2F154-brightgreen.svg)]()

> **Disclaimer**: This project is for educational and study purposes. It provides access to Qwen models via `chat.qwen.ai` browser automation. Not affiliated with Alibaba Group or Qwen. Users must comply with `chat.qwen.ai`'s terms of service.

---

## Quick Start

```bash
git clone https://github.com/Gautamgg7/qwen-gate-private.git
cd qwen-gate-private
bun install
bun start
```

Then open [http://localhost:26405/dashboard](http://localhost:26405/dashboard) to add accounts and start using the API.

## Features

- **Free Qwen Models** — Use Qwen 3.5-Flash, Qwen 3.7-Max, Qwen 3.7-Plus, Qwen 3.8-Max, and more for free in your existing tools. Point Claude Code, OpenCode, Qwen Code, Cursor, or any OpenAI-compatible client at Qwen Gate and use Qwen models without paying per-token.
- **OpenAI-Compatible API** — Drop-in replacement for `/v1/chat/completions` and `/v1/models`. Works with existing OpenAI SDKs, curl, or any HTTP client.
- **Anthropic-Compatible API** — Also supports `/v1/messages` endpoint for Claude Code and other Anthropic-compatible clients.
- **Multi-Account Rotation** — Configure multiple Qwen accounts (3+ recommended). Requests are distributed via round-robin with automatic failover and cooldown tracking — cooldown limits become a non-issue.
- **Session Pooling** — Browser sessions are pooled, reused, and autoscaled under load. No per-request login overhead.
- **Tool Calling** — Full OpenAI-style function calling with JSON Schema validation and spam guards.
- **Streaming SSE** — Server-Sent Events with heartbeat keep-alive and content filter integrity maintained across stream boundaries.
- **Content Filter Pipeline** — Strips thinking tags and filters internal artifacts from model output.
- **Web Dashboard** — Real-time monitoring with 5 pages: overview, request log, account manager, network debug, and settings.
- **WAF Detection & Bypass** — Detects Qwen's baxia anti-bot WAF (`FAIL_SYS_USER_VALIDATE` / `RGV587_ERROR`) and retries with fresh tokens + browser cookie refresh.
- **Browser Stealth Fallback** — Uses [browser_oxide](https://github.com/yfedoseev/browser_oxide) (Rust stealth engine via Python bindings) as primary browser backend, with cloakbrowser (stealth Chromium) as fallback for WAF-bypassed chat completions.
- **File Upload** — Large context payloads auto-uploaded as Qwen file attachments. Context above limit goes to `context.txt`, latest user message stays inline for low latency.
- **Image Support** — Supports image_url content blocks for vision models (qwen3.7-plus, qwen3.8-max, etc.).
- **Configurable Circuit Breaker** — Configurable via env vars (`CIRCUIT_BREAKER_FAILURE_THRESHOLD`, `CIRCUIT_BREAKER_RESET_TIMEOUT_MS`) to disable for agent/CI mode.
- **No Build Step** — TypeScript executed directly via Bun. Run from source with no compilation needed.
- **Bun-Powered** — Native TypeScript execution, built-in test runner, and cluster mode for multi-core utilization.

## Installation

### Prerequisites

- [Bun](https://bun.sh/) 1.3+ (TypeScript runtime)
- Python 3 (for browser_oxide bindings, optional but recommended)
- Rust/Cargo (for building browser_oxide, optional)
- CMake + libclang (for BoringSSL build, only needed if building browser_oxide)

### One-Command Install (Linux / macOS)

```bash
curl -sSL https://raw.githubusercontent.com/Gautamgg7/qwen-gate-private/main/install.sh | bash
```

This clones the repo, installs dependencies (Bun, Rust, Python+maturin, CMake, libclang), builds browser_oxide + Python bindings, creates `config.json`, and symlinks the `qg` / `qwengate` / `qwen-gate` CLI commands.

### Manual Install

```bash
git clone https://github.com/Gautamgg7/qwen-gate-private.git
cd qwen-gate-private
bun install
```

### Start the Server

```bash
qg
# or
bun start
```

The server starts on [http://localhost:26405](http://localhost:26405).

### Quick Commands

| What you want | Command |
|---|---|
| **Start the server** | `bun start` |
| Start with hot reload (auto-restart on code changes) | `bun dev` |
| Check if the server is running | `bun run qg status` |
| Multi-core mode | `bun run cluster` |
| Run all tests | `bun test` |

After it starts:

- **Dashboard**: http://localhost:26405/dashboard (manage accounts, view logs, settings)
- **API base URL** (for OpenCode, Cursor, Claude Code, etc.): `http://localhost:26405/v1` — no API key needed unless you set `API_KEY` in `config.json`
- **List available models**: `curl http://localhost:26405/v1/models`

> **Use `localhost`, not `127.0.0.1`** in client configs — Bun binds the OS-resolved `localhost` (IPv6 on some machines), so `127.0.0.1` may refuse to connect. `http://localhost:26405/v1` always works.

> **Accounts are persistent** — they live in `.qwen/accounts.json` (with browser sessions in `.qwen/browser-profiles/`), so after any restart all accounts log back in automatically. Add accounts once via the dashboard and they survive reboots.

### Add Accounts

> **⚠️ Best practice:** Use **3+ accounts** for round-robin rotation to bypass cooldown limits. Do **not** use your personal Qwen account — create dedicated accounts.

1. Open [http://localhost:26405/dashboard/accounts](http://localhost:26405/dashboard/accounts)
2. Enter your Qwen email and password
3. Click **Add Account** — the gateway handles login and session persistence

## Usage

### Use with Any OpenAI-Compatible Client

Qwen Gate works with any tool that speaks OpenAI's API: **Claude Code, OpenCode, Qwen Code, Cursor**, standard OpenAI SDKs (Python, Node.js, curl), and anything else using the `/v1/chat/completions` format — just point it at `http://localhost:26405/v1`.

> **Tip:** Model IDs are fetched live from Qwen, and incoming names are auto-corrected (`Qwen3.8-Max`, `qwen3.8-max`, `qwen/qwen3.8-max` all work). Available models currently include `qwen3.8-max`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.5-plus`, `qwen3.5-flash`, and `qwen3.5-omni-plus` — see `http://localhost:26405/v1/models` for the live list.

### Chat Completion

```bash
curl -X POST http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "qwen3.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Streaming

Set `"stream": true` for SSE:

```bash
curl -X POST http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3.5-flash", "stream": true, "messages": [{"role": "user", "content": "Count to 5"}]}'
```

### Tool Calling

```bash
curl -X POST http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.5-flash",
    "messages": [{"role": "user", "content": "Weather in Paris?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather in a city",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }]
  }'
```

### Image Support (Vision Models)

```bash
curl -X POST http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-plus",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "Describe this image"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBOR..."}}
      ]
    }]
  }'
```

### Using as Cline / OpenCode / Claude Code Replacement

Point your AI coding agent at the qwen-gate API:

```bash
# OpenCode
opencode --provider openai --base-url http://localhost:26405/v1 --model qwen3.5-flash

# Claude Code (via OpenAI compatibility)
claude-code --api-base http://localhost:26405/v1 --model qwen3.7-max

# Cline (VS Code extension)
# Set: API Provider = OpenAI Compatible
# Base URL = http://localhost:26405/v1
# Model = qwen3.5-flash
```

## Configuration

All settings in `config.json`. Key options:

| Key | Default | Description |
|-----|---------|-------------|
| `PORT` | `"26405"` | Server port |
| `API_KEY` | `""` | Bearer token for API auth (empty = no auth) |
| `TOOL_CALLING` | `"true"` | Enable tool call parsing |
| `CLEAN_OUTPUT` | `"true"` | Strip internal artifacts from responses |
| `STREAMING_MODE` | `"auto"` | Streaming mode: `auto`, `on`, `off` |
| `QWEN_FETCH_TIMEOUT_MS` | `"60000"` | Per-request timeout (was 30000, increased for file upload) |
| `STREAM_IDLE_TIMEOUT_MS` | `"300000"` | Stream idle timeout (5 min for thinking models) |
| `MAX_REQUEST_ACCOUNT_ATTEMPTS` | `"5"` | Max account retries per request |
| `SESSION_POOL_SIZE` | `"2"` | Pre-warmed sessions per account |
| `CONVERSATION_REUSE` | `"true"` | Reuse sessions for multi-turn conversations |
| `MAX_INLINE_CHARS` | `"120000"` | Max inline chars before file upload |
| `CONTEXT_COMPRESSION_THRESHOLD` | `"150000"` | Token threshold for history compression |

### Environment Variables (Circuit Breaker)

The circuit breaker is configurable via env vars — useful for agent/CI mode:

| Env Var | Default | Description |
|---------|---------|-------------|
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `5` | Failures before opening circuit (set to `999` to disable) |
| `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` | `30000` | Time before circuit resets |
| `CIRCUIT_BREAKER_HALF_OPEN_MAX` | `1` | Max attempts in half-open state |

## Browser Backend Architecture

Qwen Gate uses a tiered browser backend for stealth HTTP requests (needed when Qwen's WAF blocks the regular `wreq-js` requests):

```
                          ┌─ qwen-gate (TypeScript/Bun) ─┐
                          │  browserChatFetch.ts tries:  │
                          │   1. browser_oxide (Python)  │ ──subprocess──┐
                          │   2. cloakbrowser (fallback)│                │
                          └──────────────────────────────┘                ▼
                                                          ┌─ Python (PyO3) ─┐
                                                          │ browser_oxide   │
                                                          │ Python bindings │
                                                          └─────────────────┘
                                                                │ FFI
                                                                ▼
                                                          ┌─ Rust engine ───┐
                                                          │ browser_oxide   │
                                                          │ (BoringSSL+V8)  │
                                                          └─────────────────┘
```

### Backends (in order of preference)

1. **browser_oxide** (Rust stealth engine via Python bindings)
   - Native BoringSSL TLS fingerprint (JA3/JA4)
   - V8 JavaScript runtime (deno_core)
   - Real HTML/CSS/DOM/canvas
   - ~15x lighter than headless Chrome
   - Repo: https://github.com/yfedoseev/browser_oxide
   - Invoked via `python3 -c "..."` subprocess

2. **cloakbrowser** (stealth Chromium, fallback)
   - Persistent browser profile for login
   - Used when browser_oxide is not available
   - Heavier (~2GB memory) but always works

### WAF Detection & Recovery

Qwen's baxia anti-bot system can block requests with HTTP 200 + JSON body:
```json
{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::..."],"data":{"url":"..."}}
```

Qwen Gate handles this by:
1. Detecting WAF patterns in response bodies (`FAIL_SYS_USER_VALIDATE`, `RGV587_ERROR`, `_____tmd_____`, `x5secdata`)
2. Invalidating bx-ua/bx-pp tokens
3. Triggering browser cookie refresh
4. Retrying with fresh tokens
5. Falling back to browser chat fetch (browser_oxide → cloakbrowser)
6. Not throttling the account (WAF is a token issue, not an account issue)

## Key Bug Fixes Applied

This fork includes comprehensive bug fixes over the original upstream:

### 1. File Upload / Parse Timeouts (CRITICAL)
- `parseFile` now retries up to 3 times with 60s per-attempt timeout (was 30s, no retry)
- `pollParseStatus` adaptive wait: floor 5s→10s, max 30s→90s
- File size scaling: 40KB/sec → 20KB/sec

### 2. Stuck inFlight Counter Leak (HIGH)
- `incrementInFlight` now sets `lastInFlightAt` (was missing)
- Stuck-detection threshold 60s → 30s (faster recovery)
- Safety-valve cap 20 → 10

### 3. Empty Stream/Response Guard (CRITICAL)
- Deep empty-stream detection: scans SSE data frames for actual content
- Non-streaming empty-result guard: returns 502 instead of fake success
- Non-streaming handler handles OpenAI-format chunks (no phase field)

### 4. WAF Baxia Challenge Detection (CRITICAL)
- WAF-in-body sniffer now runs for streaming requests too
- Expanded WAF patterns: `RGV587_ERROR`, `_____tmd_____`, `x5secdata`
- Browser cookie refresh on WAF detection
- WAF challenge does NOT throttle account (token issue, not account issue)
- Single-account retry when no other accounts available

## Web Dashboard

Accessible at `http://localhost:26405/dashboard`.

| Page | Path | Purpose |
|------|------|---------|
| **Overview** | `/dashboard` | KPIs, model health, system logs, session pool status |
| **Logs** | `/dashboard/logs` | Real-time request log with expandable entry details |
| **Accounts** | `/dashboard/accounts` | Add/remove Qwen accounts, view auth status |
| **Network** | `/dashboard/network` | Outbound API call inspector |
| **Settings** | `/dashboard/settings` | Live config editor (changes apply instantly) |

## CLI

Three binary aliases: `qg`, `qwengate`, `qwen-gate`.

```text
Usage: qg [command] [options]

Commands:
  start          Start the API server (default)
  update         Pull latest code and reinstall dependencies
  restart        Restart the running server
  status         Check if the server is running
  help           Show help message

Options:
  --port <n>     Override port
  --browser <e>  Browser engine: chromium, firefox, webkit, chrome, edge
  --host <addr>  Bind address

Account management is done via the web dashboard → Accounts page.
```

## Testing

```bash
# Unit tests (154 tests)
bun test

# Integration test script
bash scripts/test-api.sh
```

154/154 unit tests pass. Covers content filtering, tool-call parsing, streaming sanitization, bx-ua generation, config service, Anthropic format conversion, and more.

## GitHub Actions CI

The `.github/workflows/ci.yml` workflow has 3 jobs:

1. **test** — runs unit tests (154 tests, always passes)
2. **build-browser-oxide** — builds the Rust binary + Python bindings (~30 min)
3. **integration-test** — end-to-end test with Qwen accounts from secrets

To enable integration tests, add these secrets:
- `QWEN_ACCOUNTS_JSON` — JSON array of `[{email, password}, ...]`
- `ACCOUNT1`, `ACCOUNT2`, `ACCOUNT3` — `email:password` format

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](ARCHITECTURE.md) | Browser backend architecture, Rust + Python integration |
| [Bugfix Summary](BUGFIX_SUMMARY.md) | Detailed list of all bug fixes applied |
| [API Reference](docs/API.md) | Full endpoint documentation |
| [Deployment](docs/DEPLOYMENT.md) | Production deployment guide |
| [Development](docs/DEVELOPMENT.md) | Contributing, testing, code conventions |

## Related Repos

| Repo | Description |
|------|-------------|
| [qwen-gate-private](https://github.com/Gautamgg7/qwen-gate-private) | This repo — main API gateway (TypeScript/Bun) |
| [qwen-gate-test-project](https://github.com/Gautamgg7/qwen-gate-test-project) | Test project with 50-prompt agent test + 14 integration tests |

## Upstream

Based on [youssefvdel/qwen-gate](https://github.com/youssefvdel/qwengate) — the original OpenAI-compatible API gateway for Qwen models.

## License

MIT — see [LICENSE](LICENSE).
