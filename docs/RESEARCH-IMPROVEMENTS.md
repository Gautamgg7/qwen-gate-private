# Qwen Gate — Research & Improvement Plan

> Research date: 2026-09-06 · Sources: qwen-gate upstream repo (issues/PRs), 8+ comparable free-LLM
> gateway projects, official Alibaba Model Studio catalog, in-repo audit docs.
> **Status: PLAN ONLY — no code implemented from this document yet.**

---

## 1. Research Summary — What We Learned

### 1.1 Upstream qwen-gate state (youssefvdel/qwen-gate, 181★)

Open issues that matter to us:
- `#80` completions API (not chat) requested
- `#78` "Opening the browser is not working" (login fragility)
- `#65` "emitting fallback error" (fallback error surfacing)
- `#48` kimi k3 support (multi-provider demand)

Open PRs with real fixes we can cherry-pick (unmerged upstream):
- `#68` — enforce RateLimited walls delivered inside HTTP 200 bodies → surface as real errors
- `#40` — eliminate recurring login + mid-chat CAPTCHA (cookie persistence, WAF-warm requests, silent refresh)
- `#57` — fix empty Claude Code responses (CAPTCHA handling, local_mcp budget, tool normalization)
- `#36` — replace broken local_mcp with xml_prompt tool-calling for Claude Code
- `#41` — MCP tool-call drop fix, Node-default runtime for browser-profile harvesting

### 1.2 Comparable projects & the techniques that make them fast/reliable

| Project | Stars | Techniques worth stealing |
|---|---|---|
| `one-api` (songquanpeng) | 36.8k | **Health-based channel auto-disable** (ENABLE_METRIC: disable channels <80% success), quota/rate-limit management, multi-tenancy, load balancing, batch DB updates |
| `xtekky/deepseek4free` | 378 | **Reverse-engineered PoW challenge solving** (in-process, <50ms WASM) — no browser wait |
| `NIyueeE/ds-free-api` (Rust) | 661 | OpenAI **and** Anthropic compat, session pool, cookie persistence |
| `ForgetMeAI/FreeDeepseekAPI` | 336 | OpenAI + Anthropic + **Responses API**, tool calling, Open WebUI |
| `Fly143/deepseek-free-api` | 266 | Tool calling, web-search passthrough, chat/pages session reuse |
| `centralvii/deepseek-free-api` | 0 (new) | **1M-token context with intelligent compressor (~300k)**, WASM PoW <50ms, auto-login via Playwright, /login per provider, agent inspector proxy |
| `kravchenski/FreeKimiQwenDeepseekApi` | 4 | Unified multi-provider (Qwen/Kimi/GLM), persistent sessions, Docker, opencode.json out of the box |
| `spf0209/FreeAI-Gateway` | 33 | Multi-provider web-to-API (GLM, Kimi, Qwen, MiniMax, DeepSeek, Z.ai) |
| **GLM-Free-API (already installed)** | — | **Throwaway sessions + async session pool, device-token pooling in SQLite, background captcha cache, HMAC-salted request signing, request pacing vs Aliyun WAF, pure-HTTP no browser at runtime** |

### 1.3 Official paid tier note

Alibaba **Model Studio** (official API) now lists: `qwen3.8-max`, `qwen3.7-plus`, `qwen3.8-flash`,
`deepseek-v4-pro/flash`, `kimi-k2.7-code`, `glm-5.2`, plus embeddings/rerank/image/video/audio.
→ An official API key gives a **guaranteed-reliable fallback tier** (no captcha/WAF) we can route
to as a safety net, while free web accounts carry the volume.

---

## 2. Problem Ranking (from our own logs)

1. **Stream idle-timeout killed long tasks** — FIXED (60s→300s default, both OpenAI & Anthropic paths, proper SSE error before `[DONE]`).
2. **Account count flicker 0/2/3 on dashboard** — FIXED (reload now merges accounts.json + env).
3. **Model-name Not_Found (Qwen3.8-Max vs qwen3.8-max)** — FIXED (resolveModelName canonical matching).
4. **`qg status` lying** — FIXED (IPv6 localhost probing + /ping).
5. **Token pool exhaustion on GLM side** — mitigated (reseed helper) — same risk class applies to captcha/token handling in qwen-gate: **no defensive health metrics yet**.

Remaining systemic risks (from `docs/AUDIT.md`, still open):
- P-1/2/4 O(n²) buffer accumulation in stream hot path
- P-3 idle timeout recreated per chunk (Promise/setTimeout churn)
- P-15 no backpressure on wrapped ReadableStream
- P-17 session-pool race can exceed max sessions
- P-20 session-delete timeout not cleared on fetch error
- P-29 mid-stream errors NOT retried (task just dies)
- S-1 API key injected into dashboard HTML
- S-17 body limit bypassed via chunked encoding
- H-4/5/6 silent `.catch(() => {})`
- A-3 circular deps / 12+ dynamic imports
---

## 3. Improvement Plan — by Priority

Legend: 🟥 P0 (do first, high impact) · 🟧 P1 · 🟨 P2 · 🟩 P3 (nice-to-have)
Each item: source inspiration / files touched / expected impact.

### 🟥 P0 — Reliability: "100% working" tasks never die silently

| # | Improvement | Borrowed from | Files | Impact |
|---|---|---|---|---|
| R1 | **Mid-stream error retry**: when upstream stream fails/errors mid-response, automatically retry on the next account from the same request context (like the existing initial-attempt loop but also covering post-first-chunk failures) | qwen-gate PR ideas + DeepseekFreeAPI retry loops | `chatStreaming.ts`, `chat.ts`, `streamLoop.ts` | Eliminates "task just stops" complaints |
| R2 | **Account health scoring + auto-disable**: track success/error rate per account (5-min window); auto-exclude accounts below ~80% success from `pickAccount`; auto-recover after healthy window; surface in dashboard | one-api `ENABLE_METRIC` (success-rate threshold 0.8) | `accountManager.ts` (extend `isAvailable`), dashboard accounts page | Rotates away from flaky/banned accounts → far fewer dead tasks |
| R3 | **Rate-limit wall detection**: Qwen returns HTTP 200 bodies containing rate-limit/`RateLimited` errors; detect, classify, throttle that account (already partly present), and **surface a real OpenAI error to client** instead of `[DONE]`, so OpenCode/agents retry | upstream PR #68 | `chatStreamingHelpers.ts`, `streamLoop.ts` | Correct behavior, no fake successes |
| R4 | **Request pacing / WAF-warmups**: randomized min interval (200–500ms) between upstream requests per session; occasional "warm" /ping navigations to keep profile fingerprint trusted | GLM-Free-API `UPSTREAM_MIN_INTERVAL_MS`; upstream PR #40 "WAF-warm requests" | `qwen.ts`/`browserlessFetch.ts`, session pool | Fewer Aliyun WAF blocks → fewer captchas |
| R5 | **Cookie-persistence hardening + silent refresh**: load cookies from browser profile more aggressively, refresh token silently before expiry with lock, log refresh failures instead of `.catch(()=>{})` | upstream PR #40; AUDIT P-22 / H-4,5,6 | `playwright.ts`, `tokenRefresh.ts`, `auth.ts` | Accounts stop randomly re-logging / mid-chat captcha |
### 🟧 P1 — Speed: reduce latency & CPU

| # | Improvement | Borrowed from | Files | Impact |
|---|---|---|---|---|
| S1 | **Replace per-chunk idle-timeout Promise+setTimeout with a single resettable timer** — kills the O(chunks) timer churn; keeps the 300s policy | AUDIT P-3 | `streamLoop.ts`, `anthropic.ts` | Lower GC pressure, smoother streaming |
| S2 | **Fix O(n²) buffer accumulation** in stream hot path (avoid repeated re-slicing of giant buffers) | AUDIT P-1/2/4 | `streamLoop.ts`, `chatStreamingHelpers.ts` | Keeps long agentic tasks fast over many tool rounds |
| S3 | **Pre-warm + autoscale session-pool tune** (pool-size config, min-ready watermark, acquire timeout) so bursts don't pay chat/new latency | GLM-Free-API `SESSION_POOL_SIZE`; DeepseekFreeAPI | `sessionPool.ts`, `configService.ts` | First-token latency drops on burst |
| S4 | **Short TTL metadata micro-cache**: /v1/models + capabilities already cached 1h; add per-request bx/UA/token header cache reuse, avoid re-deriving fingerprints each request | existing `bxUaGenerator` cache | `qwen.ts`, `bxUaGenerator.ts` | Saves ~1 network round-trip |
| S5 | **Trim redundant `setTimeout(0)` per SSE event** or batch flush with microtask drain | — | `streamLoop.ts` | Better throughput on big streams |

### 🟨 P2 — Capability parity (agent-ready)

| # | Improvement | Borrowed from | Files | Impact |
|---|---|---|---|---|
| C1 | **Context compression for >~300k tokens**: summarize older history (like centralvii's compressor) instead of always uploading context.txt; stops long-codebase degradation | centralvii intelligent compressor | `chat.ts`, `qwenFileUpload.ts` | 1M-context tasks stay coherent |
| C2 | **Anthropic `/v1/messages` tool-use parity**: fix Claude Code empty responses (local_mcp budget, tool normalization, xml_prompt mode) | upstream PR #57 / #36 | `anthropic.ts`, `chatStreamingHelpers.ts` | Claude Code agents work fully |
| C3 | **`/v1/completions` (non-chat)** passthrough to satisfy strict OpenAI clients | upstream issue #80 | new route | Unlocks more clients |
| C4 | **Web-search passthrough toggle** (enable/disable) | Fly143, centralvii `/search` | `chat.ts`, config | Parity with official web |
| C5 | **Vision streaming check**: verify multi-modal image input in both streaming & non-streaming | — | `chat.ts`, `chatHelpers.ts` | True multimodal |
### 🟩 P3 — Architecture / ops / security

| # | Improvement | Borrowed from | Files | Impact |
|---|---|---|---|---|
| A1 | Remove API key from dashboard HTML (mask server-side) | AUDIT S-1 | `dashboardRoutes.ts` | Security |
| A2 | Byte-counting body limit (chunked bypass) | AUDIT S-17 | `index.tsx` | Security |
| A3 | Auth-gate `/debug/network` + admin routes | AUDIT S-4 | `index.tsx` | Security |
| A4 | Log every `.catch(()=>{})` | AUDIT H-4/5/6 | pool/playwright/login | Diagnosability |
| A5 | Session-pool race mutex | AUDIT P-17 | `sessionPool.ts` | Correctness |
| A6 | `/metrics` Prometheus endpoint | AUDIT 4.2 | new route | Observability |
| A7 | Request-ID propagation & per-request trace log | AUDIT A-28 | middleware + logStore | Debuggability |
| A8 | Docker: pin base image, tree-shake node_modules, keep secrets out | AUDIT S-10/11 | `Dockerfile`, `.dockerignore` | Deploy safety |

---

## 4. "100% working" — definition & verification strategy

**Definition:** a task requested through the OpenAI/Anthropic surface completes with a valid
`finish_reason` and no dropped output; P(task aborted mid-stream) < 1%.

**Verification battery (CI + manual):**
1. Unit: `bun test` + new tests for health scoring, mid-stream retry, rate-limit parsing.
2. E2E battery (scripted): non-stream, stream, parallel tools, sequential tools, vision image_url,
   long-context (>300k chars), multi-round agent loop, all-throttled → clean error, restart resilience.
3. Soak: 50-request burst × 3 accounts; assert 0 idle-timeouts, 0 `[DONE]`-after-failure, <10s p50 first token.
4. Dashboard: account health/status columns show live state; no 0/2/3 flicker.

## 5. Working notes
- All fixes are local to our clone (5 hotfixes already applied) — do NOT rely on upstream merges; we own our fork.
- Keep GLM-Free-API as a second provider for failover; consider a one-api-style facade in front of both later (P3).
- TOS risk: automating chat.qwen.ai is for personal/educational use; low request pacing (R4) reduces flagging.

*End of plan — execute in P0→P3 order, verifying each item with the battery above.*