# Qwen Gate — Qwen-Focused Reverse-Engineering Research & Improvement Plan

> Research date: 2026-09-06 · **Scope: Qwen ONLY (chat.qwen.ai)** · No imports of Kimi/GLM/Z.ai.
> Sources: 6 Qwen-specific reverse-engineering projects + qwen-gate upstream + official Alibaba catalog.
> **Status: PLAN ONLY — no code written from this document yet.**

---

## 1. The Qwen-Specific Landscape (what others reverse-engineered)

### 1.1 The cleanest Qwen-specific targets found (by relevance)

| Project | Stars / lang | What it reverse-engineers | Key techniques that matter for US |
|---|---|---|---|
| **angzedy/QwenFreeApi** | 33 / JS | Qwen 3.8 Max, 3.7 Plus… → OpenCode; "newest ultimate bypass" of Qwen's chat endpoint | Same author as qwen-gate PR #57. Likely uses **pure-HTTP token approach** (no browser at request time) |
| **y13sint/FreeQwenApi** | 326 / Node | chat.qwen.ai → local OpenAI proxy (port 3264) | **Browser-auth once, then session reuse**; multi-account round-robin; tool-call folding into system prompt; context persistence; image/video gen via chatType |
| **ckcoding/QwenChat2Api** | 70 / Node | chat.qwen.ai → OpenAI-compatible | ⭐ **Identity pool / multi-cookie load balancing with HEALTH + CIRCUIT BREAKER**: healthy/degraded/down; auto-refresh tokens; retry 2× on failure; auto token refresh from cookie; smart vision fallback; auto-session cleanup (delete chats) |
| **qwen-code-oai-proxy** (aptdnfapt) | 173 / TS | qwen-code **oauth file** → OpenAI proxy | Uses **Qwen Code OAuth creds (~/.qwen/oauth)** — a DIFFERENT auth path (Qwen Code CLI tokens) that may be more stable than chat redirect. **DEPRECATED (401 errors)** — free quota ended |
| **xiaoY233/Qwen-Free-API** | 53 / TS | Qwen 3 reverse API (fork of qwen-free-api) | Uses **tongyi_sso_ticket / login_aliyunid_ticket** (a DIFFERENT SSO cookie) instead of chat token; high-speed streaming fix (only emit when text grows — no dupes); multi-token `Bearer T1,T2,T3`; **auto session cleanup**; ⚠️ *original project had supply-chain malicious code* |
| **qwen-ai-reverse-api** (Wu-jiyan) | 29 / Py | chat.qwen.ai → OpenAI | Multi-token round-robin; **VLESS proxy pool** for IP rotation; health checks; token from **LocalStorage token** (same as ours) |

### 1.2 Qwen auth: multiple credential paths we don't use yet

There are **4 different Qwen credential paths**, and the gate uses only ONE:
1. `chat.qwen.ai` **LocalStorage `token`** (JWT) — what qwen-gate/our `.qwen/tokens` use
2. **`tongyi_sso_ticket`** cookie (from tongyi + AliCloud SSO) — used by xiaoY233, arguably more stable
3. **`login_aliyunid_ticket`** cookie — same project
4. **Qwen Code OAuth file** (`~/.qwen/oauth_creds_<id>.json`) — qwen-code-oai-proxy (now dead)

→ **Lesson for us:** adding SSO-ticket auth as a fallback (paths 2/3) would reduce "login failed / captcha" stalls → fewer stuck tasks.
---

## 2. Qwen-Specific Reliability Issues & How They Fixed Them

| Issue in our gate | Qwen projects' fix | Implementation idea |
|---|---|---|
| **Mid-stream stops** (our #1 pain) | QwenChat2Api: **fault-tolerance = retry 2× on failure + circuit-breaker + auto-shift to next identity**; QwenFreeApi: preserve session + fold tool context so the model doesn't stall | Add per-account **health/circuit-breaker** + **mid-stream auto-retry on next account** |
| **Rate-limit silently accepted** | QwenChat2Api: health states + disable down accounts; surface real error | Detect 200-body rate-limit → real OpenAI error, don't fake `[DONE]` |
| **Token expiry / re-login** | QwenChat2Api: **auto-refresh token from cookie every 24h + valid-until + independent per-identity**; other projects: token health endpoint | Add auto token refresh w/ lock + refresh-failure logging |
| **O(n²) stream / dup output** | xiaoY233: "only extract incremental text when length grows" (fixes dupes + perf) | Fix our per-chunk timer/O(n²) + dedupe detection |
| **Stuck / dead accounts** | QwenChat2Api: circuit breaker + degraded/down states + auto-recover | Port to accountManager (health scoring) |
| **Loading from datacenter IP** | qwen-ai-reverse-api: **VLESS proxy pool with IP rotation + health checks** | (Optional P3) proxy-pool support for cloud deploy |

---
---

## 3. The Proposed Qwen Improvement Plan (revised, Qwen-only)

### 🟥 P0 — Qwen reliability (kill "stuck in middle" for good)

| # | Improvement | Qwen source | Files | Impact |
|---|---|---|---|---|
| Q1 | **Per-account circuit-breaker + health (healthy/degraded/down)** with auto-recover; `pickAccount` prefers healthy; dashboard shows state | QwenChat2Api identity pool; one-api | `accountManager.ts`, dashboard | Rotates off flaky/banned accounts → no dead tasks |
| Q2 | **Mid-stream auto-retry on next account** (if nothing/no significant output emitted, or on `upstream_idle_timeout`) | QwenChat2Api "retry 2× on failure" | `chat.ts`, `chatStreaming.ts` | DIRECT fix for "stuck mid-task" |
| Q3 | **Rate-limit/200-body error surfacing** — parse `RateLimited`/`daily usage`, throttle account, return real response error | qwen-gate PR #68; QwenChat2Api | `streamLoop.ts`, `chatStreamingHelpers.ts` | No fake completions |
| Q4 | **Auto token refresh + valid-until per identity** (24h timer, silent, locked) — refresh from cookie, log failures | QwenChat2Api token-refresh | `tokenRefresh.ts`, `auth.ts` | Accounts stop randomly dropping |
| Q5 | **SSO-ticket auth fallback** (`tongyi_sso_ticket` / `login_aliyunid_ticket` as alternate credential source) | xiaoY233 Qwen-Free-API | `loginService.ts`, config | Reduces login/captcha stalls |

### 🟧 P1 — Qwen speed / stream quality

| # | Improvement | Qwen source | Files | Impact |
|---|---|---|---|---|
| S1 | **Remove per-chunk idle Promise/setTimeout churn** → one resettable timer (keep 300s) | audit P-3 | `streamLoop.ts` + Anthropic | Smoother, less GC |
| S2 | **Fix O(n²) buffer slicing + dup-content fix** (only emit when length grows) | xiaoY233 fix | `streamLoop.ts`, `chatStreamingHelpers.ts` | Faster big streams, no dupes |
| S3 | **Session-pool tuning** (size/watermark/acquire timeout) to absorb bursts | FreeQwenApi session reuse | `sessionPool.ts` | Lower first-token latency |
| S4 | **Header/fingerprint micro-cache** (bx-ua, etc.) | — | `qwen.ts`, `bxUaGenerator.ts` | Fewer round-trips |

### 🟨 P2 — Qwen agent capability parity

| # | Improvement | Qwen source | Files | Impact |
|---|---|---|---|---|
| C1 | **Context compression for large histories** (summarize older turns to keep ~300k) instead of always-upload context.txt | centralvii; xiaoY233 "long doc" | `chat.ts`, `chatHelpers.ts` | Long agent tasks stay coherent |
| C2 | **Homegrown tool-support hardening**: XML tool parser edge cases; multi-tool parallel in ONE block; tool-result folding; `finish_reason` correctness | FreeQwenApi "folds tools into prompt" + ours | `chatStreamingHelpers.ts`, `tools/` | Better agent tool fidelity |
| C3 | **Vision / image / video / web-search parity** (chatType endpoints) | FreeQwenApi image/video guide | new/modify routes | Match official web features |
| C4 | `/v1/completions` + Gemini-style adapters for more clients | xiaoY233 adapters | new routes | Client compatibility |

### 🟩 P3 — Qwen ops/security

- A1–A8 from the general plan (dashboard key leak, chunked-body bypass, `/debug/network` auth, request-ID, `/metrics`, Docker secrets). Plus:
- A9 **Optional VLESS proxy-pool** (IP rotation) for cloud deploys to dodge WAF.

---

## 4. What "100% working + fast" verification looks like (Qwen)

- **Soak:** 50-request burst × 3 accounts, assert 0 idle-timeouts, 0 `[DONE]`-after-failure, p50 first-token <10s.
- **Agent battery:** non-stream, stream, parallel tools, sequential tools, vision image_url, 300k-char context, multi-round loop, all-accounts-throttled → clean error.
- **Week-long** daily task completing with 0 manual re-adds (validates Q4/Q5 auth).

---

## 5. Sources (Qwen-specific)
- angzedy/QwenFreeApi · y13sint/FreeQwenApi (326★) · ckcoding/QwenChat2Api (70★) · aptdnfapt/qwen-code-oai-proxy (173★, deprecated) · xiaoY233/Qwen-Free-API (53★, ⚠️ supply-chain watch) · Wu-jiyan/qwen-ai-reverse-api (29★, archived)

*End — execute Q1→Q5 (P0) first; each verified with the battery above.*