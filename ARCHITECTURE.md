# Qwen Gate — Architecture (Rust + Python + TypeScript, no Go)

## Overview

This document describes the browser backend architecture for qwen-gate after
removing the Go bridge and Lightpanda. The architecture now uses only
**Rust** (browser_oxide) + **Python** (browser-oxide PyO3 bindings) +
**TypeScript** (qwen-gate itself).

## Browser Backend Architecture

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
   - Python bindings: `pip install browser-oxide` (when published) or
     build from source with maturin
   - Invoked from TypeScript via `python3 -c "..."` subprocess

2. **cloakbrowser** (stealth Chromium, fallback)
   - Persistent browser profile for login
   - Used when browser_oxide is not available
   - Heavier (~2GB memory) but always works

## Why no Go?

The previous architecture used a Go bridge to wrap browser_oxide's CDP server.
This added an extra process to manage and was unnecessary since browser_oxide
ships Python bindings (PyO3/maturin). We removed the Go bridge and use Python
directly from TypeScript via a subprocess call.

## Why no Lightpanda?

Lightpanda was a lightweight CDP browser alternative. We removed it to
simplify the architecture — browser_oxide (Rust) is already lightweight
(~150MB memory per page) and provides better stealth (native BoringSSL TLS,
no CDP detection vectors).

## Files

### qwen-gate-private (TypeScript API gateway)
- `src/services/browserOxidePython.ts` — TypeScript wrapper that invokes
  browser_oxide via Python subprocess
- `src/services/browserChatFetch.ts` — tries browser_oxide first, falls
  back to cloakbrowser
- `src/services/fireyejsRunner.ts` — cookie refresh via browser_oxide
  (or cloakbrowser fallback)
- `install.sh` — installs Rust + Python + maturin + builds browser_oxide
- `Dockerfile` — debian:bookworm-slim with browser_oxide built from source
- `.github/workflows/ci.yml` — CI with browser_oxide build job

### qwen-gate-test-project (test project)
- `tests/agent-build-project.ts` — agent that builds a complex Node.js
  TypeScript weather app over 45 prompts (multi-turn, growing context)
- `.github/workflows/test.yml` — CI with `agent-build-complex-project` job

## Test Results

### Unit tests (qwen-gate-private)
All 154 unit tests pass.

### Live integration tests
| Test | Result | Notes |
|------|--------|-------|
| GET /v1/models | ✓ PASS | Returns 6 Qwen models |
| Non-streaming chat | ✓ PASS | "Hello! How are you today?" |
| Concurrent (3 parallel) | ✓ PASS | All 3 returned correct responses |
| Streaming chat | ⚠ WAF | Qwen WAF blocked after initial success |
| Tool calling | ⚠ WAF | WAF challenge |
| Multi-turn (40 turns) | ⚠ WAF | WAF blocks after ~5 requests |
| Large context (50KB) | ⚠ WAF | WAF challenge |
| Image URL upload | ⚠ WAF | WAF challenge |
| Agent build (45 prompts) | ⚠ WAF | WAF blocks after initial prompts |

### Known limitations

1. **Qwen WAF rate-limiting**: Qwen's baxia anti-bot system blocks chat
   completions after a few requests from the same IP/account in a short
   window. The qwen-gate code correctly detects WAF challenges
   (`FAIL_SYS_USER_VALIDATE` / `RGV587_ERROR`) and retries with fresh
   tokens, but Qwen itself is the bottleneck.

2. **Memory pressure**: The test environment has 4GB total RAM with no
   swap. Running qwen-gate (Bun + cloakbrowser + browserless wreq-js worker)
   together with browser_oxide can exceed available memory.

3. **browser_oxide build**: Building browser_oxide from source requires
   ~4GB RAM (BoringSSL + V8 compile). On memory-constrained environments,
   use cloakbrowser (Playwright Chromium) fallback.

## GitHub Actions

### qwen-gate-private CI (`.github/workflows/ci.yml`)
3 jobs:
1. **test** — runs unit tests (154 tests, always passes)
2. **build-browser-oxide** — builds Rust binary + Python bindings (~30 min)
3. **integration-test** — end-to-end test with Qwen accounts from secrets

### qwen-gate-test-project CI (`.github/workflows/test.yml`)
3 jobs:
1. **unit-tests** — runs the 14 integration tests
2. **agent-build-complex-project** — runs the 45-prompt agent test
   - Installs Rust + CMake + libclang + maturin
   - Builds browser_oxide + Python bindings
   - Starts qwen-gate server
   - Runs the agent with 45 turns
   - Uploads the generated project as an artifact
3. **huge-context-test** — 40-turn multi-turn + 500KB context test

To enable integration tests, add these secrets to the repos:
- `QWEN_ACCOUNTS_JSON` — JSON array of `[{email, password}, ...]`
- OR `ACCOUNT1`, `ACCOUNT2`, `ACCOUNT3` — `email:password` format

## How to use

### Local development

```bash
# 1. Clone and install qwen-gate
git clone https://github.com/Gautamgg7/qwen-gate-private.git
cd qwen-gate-private
bash install.sh  # installs Bun, Rust, Python+maturin, builds browser_oxide

# 2. Start the server
qg  # or: bun start

# 3. Open dashboard to add Qwen accounts
open http://localhost:26405/dashboard/accounts

# 4. Test the API
curl http://localhost:26405/v1/models
curl -X POST http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.5-flash","messages":[{"role":"user","content":"Hello"}]}'
```

### Run the agent test (45 prompts, builds a Node.js weather app)

```bash
git clone https://github.com/Gautamgg7/qwen-gate-test-project.git
cd qwen-gate-test-project
bun install

# Run the agent (builds a complex project over 45 turns)
QG_HOST=http://localhost:26405 \
QG_MODEL=qwen3.5-flash \
QG_AGENT_TURNS=45 \
PROJECT_OUTPUT_DIR=/tmp/qg-agent-project \
bun run test:agent

# View the generated project
ls /tmp/qg-agent-project
```

### Using as a Cline/OpenCode/Claude Code replacement

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

## Recommendations for production

1. **Use 3+ Qwen accounts** for round-robin rotation to avoid WAF
   rate-limiting on a single account.

2. **Allocate 8GB+ RAM** for the qwen-gate server, especially if you
   build browser_oxide from source.

3. **Add swap** if you can't allocate more RAM:
   ```bash
   sudo fallocate -l 4G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   ```

4. **Use browser_oxide** for best stealth (native BoringSSL TLS).
   Build it from source with `bash install.sh` or use the GitHub Actions
   workflow to produce a binary. Fallback to cloakbrowser if unavailable.

5. **Monitor the dashboard** at `http://localhost:26405/dashboard` for
   account health, WAF hits, and request logs.
