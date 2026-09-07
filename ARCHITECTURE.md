# Qwen Gate — Browser Backend Architecture & Test Results

## Summary

This document describes the browser backend architecture for qwen-gate and
the integration test results.

## Browser Backend Architecture

qwen-gate uses a tiered browser backend architecture for stealth HTTP requests
(needed when Qwen's WAF blocks the regular `wreq-js` requests):

```
                          ┌─ qwen-gate (TypeScript/Bun) ─┐
                          │  browserChatFetch.ts tries:  │
                          │   1. browser_oxide bridge     │ ──┐
                          │   2. Lightpanda              │   │ HTTP
                          │   3. cloakbrowser (Chromium)│   │
                          └──────────────────────────────┘   ▼
                                                            ┌─ Go bridge ─┐
                                                            │ qg-bridge   │
                                                            │ :9224       │
                                                            └─────────────┘
                                                                 │ CDP
                                                                 ▼
                                                            ┌─ Rust engine ─┐
                                                            │ browser_oxide │
                                                            │ :9222 (CDP)   │
                                                            └───────────────┘
                                                            OR
                                                            ┌─ Lightpanda ─┐
                                                            │ :9223 (CDP)  │
                                                            └──────────────┘
```

### Backends (in order of preference)

1. **browser_oxide** (Rust stealth engine)
   - Native BoringSSL TLS fingerprint (JA3/JA4)
   - V8 JavaScript runtime (deno_core)
   - Real HTML/CSS/DOM/canvas
   - CDP-compatible WebSocket server
   - ~15x lighter than headless Chrome
   - Repo: https://github.com/yfedoseev/browser_oxide
   - Wrapped via Go bridge: https://github.com/Gautamgg7/qwen-gate-bridge

2. **Lightpanda** (Zig-based headless browser)
   - CDP-compatible WebSocket server
   - ~170MB binary, ~123MB memory
   - ~9x faster than headless Chrome
   - Repo: https://github.com/lightpanda-io/browser

3. **cloakbrowser** (stealth Chromium, fallback)
   - Persistent browser profile for login
   - Used when both browser_oxide and Lightpanda are unavailable

## Test Results

### Unit tests (qwen-gate-private)
All 154 unit tests pass:
```
154 pass
0 fail
137 expect() calls
Ran 154 tests across 14 files. [722ms]
```

### Integration tests (live API)

Tested against a running qwen-gate server with the chimpuajain@gmail.com account:

| Test | Result | Notes |
|------|--------|-------|
| GET /v1/models | ✓ PASS | Returns 6 Qwen models |
| Non-streaming chat | ✓ PASS | "Hello! How are you today?" |
| Concurrent (3 parallel) | ✓ PASS | All 3 returned correct responses |
| Streaming chat | ⚠ WARN | Qwen WAF blocked after initial success |
| Tool calling | ⚠ WARN | WAF challenge after circuit breaker |
| Multi-turn (40 turns) | ⚠ WARN | WAF blocks after ~5 requests |
| Large context (50KB) | ⚠ WARN | WAF challenge |
| Image URL upload | ⚠ WARN | WAF challenge |
| Code generation | ⚠ WARN | WAF challenge |
| Bug fix detection | ⚠ WARN | WAF challenge |
| Anthropic /v1/messages | ⚠ WARN | Endpoint works, but blocked by WAF |

### Known limitations

1. **Qwen WAF rate-limiting**: Qwen's baxia anti-bot system blocks chat
   completions after a few requests from the same IP/account in a short
   window. The qwen-gate code correctly detects WAF challenges
   (`FAIL_SYS_USER_VALIDATE` / `RGV587_ERROR`) and retries with fresh
   tokens, but Qwen itself is the bottleneck.

2. **Memory pressure**: The test environment has 4GB total RAM with no
   swap. Running qwen-gate (Bun + cloakbrowser + browserless wreq-js worker)
   together with Lightpanda or browser_oxide can exceed available memory,
   causing the server to crash. In production, use a machine with 8GB+ RAM
   or add swap.

3. **browser_oxide build**: Building browser_oxide from source requires
   ~4GB RAM (BoringSSL + V8 compile). On memory-constrained environments,
   use Lightpanda (binary distribution) or cloakbrowser (Playwright
   Chromium) instead.

## Recommendations for production

1. **Use 3+ Qwen accounts** for round-robin rotation to avoid WAF
   rate-limiting on a single account. Add accounts via the dashboard at
   `/dashboard/accounts`.

2. **Allocate 8GB+ RAM** for the qwen-gate server, especially if you
   enable Lightpanda or browser_oxide. Without enough memory, the server
   will crash under load.

3. **Add swap** if you can't allocate more RAM:
   ```bash
   sudo fallocate -l 4G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   ```

4. **Use browser_oxide bridge** for best stealth (native BoringSSL TLS).
   Build it from source or use the GitHub Actions workflow to produce
   a binary. Fallback to Lightpanda or cloakbrowser if unavailable.

5. **Monitor the dashboard** at `http://localhost:26405/dashboard` for
   account health, WAF hits, and request logs.

## Files

### qwen-gate-private (TypeScript API gateway)
- `src/services/browserOxideBridge.ts` — Go bridge client
- `src/services/lightpandaBrowser.ts` — Lightpanda CDP integration
- `src/services/browserChatFetch.ts` — multi-backend chat fetch fallback
- `src/services/fireyejsRunner.ts` — cookie refresh with backend selection
- `scripts/test-api.sh` — comprehensive integration test script
- `.github/workflows/ci.yml` — GitHub Actions CI/CD

### qwen-gate-bridge (Go bridge)
- `main.go` — HTTP server wrapping CDP-compatible browser backends
- Endpoints: /health, /navigate, /evaluate, /fetch, /chat-fetch
- Repo: https://github.com/Gautamgg7/qwen-gate-bridge

### qwen-gate-test-project (test project)
- `src/qg-client.ts` — OpenAI-compatible TypeScript client
- `tests/run-all.ts` — runs all 14 integration tests
- `tests/test-*.ts` — individual test files
- `sample-project/` — small TypeScript weather app for agent testing
- `.github/workflows/test.yml` — GitHub Actions with matrix builds
- Repo: https://github.com/Gautamgg7/qwen-gate-test-project
