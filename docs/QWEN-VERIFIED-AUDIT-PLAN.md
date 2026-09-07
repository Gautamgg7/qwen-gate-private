# Qwen Gate â€” Verified Code-Audit & Qwen-Optimized Improvement Plan

> Research + actual code audit date: 2026-09-06 Â· Scope: Qwen ONLY.
> Each row = what I actually READ in the source, not just README claims.
> **Status: PLAN ONLY â€” no code implemented from this document.**

---

## 1. Verified Code Audits (what I read vs claimed)

### QwenChat2Api (ckcoding, 70â˜…) â€” VERIFIED CLEAN & REAL
Read: identity-pool.js, sse.js, main.js, token-refresh.js, config.json, chat-helpers.js
- Identity pool genuine: Identity class with status healthy/degraded/down, failCount,
  nextRetryAt (fail>=5 -> down+5min, >=3 -> degraded+2min); markSuccess auto-recover.
  Round-robin across available, filters down/cooldown.
- Auto token refresh real: startup getTokenFromCookie(), scheduler every 24h;
  refreshExpiredTokens() <1d left; manual /refresh-token.
- Session cleanup: startChatDeletionScheduler(60) deletes page-2 chats hourly.
- Settings: API_KEY, AUTO_REFRESH_TOKEN, TOKEN_REFRESH_INTERVAL_HOURS,
  VISION_FALLBACK_MODEL, DEBUG_MODE.
- SSE: setSseHeaders + createKeepAlive (15s ping), safe [DONE].
- **No malicious sinks** (child_process/eval/exfil/webhook/discord): NONE found. Clean.

### FreeQwenApi (y13sint, 326â˜…) â€” VERIFIED CLEAN & REAL
Read: src/api/tokenManager.js, config tree
- Browser-auth once -> session tokens in session/tokens.json + per-account dirs;
  JWT validated (starts eyJ, 3 parts) before saving.
- Round-robin + cooldown: getAvailableToken() filters valid; markRateLimited(id, hours);
  markInvalid(id); removeToken.
- Path-traversal protected for acc_* account dirs.
- No malicious sinks found. Clean.

### Qwen-Free-API (xiaoY233, 53â˜…) â€” RISK to borrow from directly
Read: src/api/controllers/chat.ts, src/lib/configs/service-config.ts
- Auth = tongyi_sso_ticket / login_aliyunid_ticket (alternate credential);
  generateCookie(ticket); but X-Xsrf-Token is HARDCODED (48b9ee49-...) â€” fragile.
- Uses qianwen.biz.aliyun.com + http2 + removeConversation (auto cleanup).
  Value to us = SSO-ticket idea + session cleanup, NOT the fragile impl.
- Original LLM-Red-Team/qwen-free-api had malicious code; this fork says removed;
  found none here, but treat as risk.

### qwen-code-oai-proxy (aptdnfapt, 173â˜…) â€” VERIFIED DEAD
README: DEPRECATED â€” Qwen free usage ended, 401s. Uses ~/.qwen/oauth_creds_. Not useful.

### qwen-ai-reverse-api (Wu-jiyan, 29â˜…, archived) â€” CLEAN but limited
Multi-token round-robin, VLESS proxy pool, token health; archived; auto-register
needs Playwright. Medium value.

---

## 2. What I can confidently borrow (verified, with risks)

| Borrow | From (verified) | Notes / risk | Where in gate |
|---|---|---|---|
| Per-account circuit-breaker + health | QwenChat2Api | clean, drop-in | accountManager.ts, dashboard |
| Auto token refresh + valid-until | QwenChat2Api | clean | tokenRefresh.ts, auth.ts |
| Auto session cleanup (stale, not in-flight) | QwenChat2Api | clean | qwen.ts/pool |
| Round-robin w/ cooldown + JWT validation | FreeQwenApi | clean | accountManager.ts |
| SSO-ticket fallback auth | xiaoY233 | risky impl; borrow idea only | loginService.ts |
| Stream fix: only emit when length grows | xiaoY233 | verify vs our SSE | streamLoop.ts |
| VLESS proxy pool (IP rotation) | qwen-ai-reverse-api | archived; P3; cloud only | â€” |

## 3. The Qwen-Focused Improvement Plan (verified)

### P0 â€” Reliability: kill stuck mid-task

| # | Improvement | Files |
|---|---|---|
| Q1 | Per-account health/circuit-breaker (degraded/down/recover; pickAccount prefers healthy) | accountManager.ts |
| Q2 | Mid-stream auto-retry on next account (retry when no output yet on upstream error) | chat.ts, chatStreaming.ts |
| Q3 | Rate-limit/200-body error surfacing (detect RateLimited; mark cooldown; real error) | streamLoop.ts, helpers |
| Q4 | Auto token refresh + valid-until (24h silent lock; manual refresh; log failures) | tokenRefresh.ts, auth.ts |
| Q5 | Auto session cleanup (stale chats, never in-flight) | qwen.ts, pool |

### P1 â€” Speed / stream quality

| # | Improvement | Files |
|---|---|---|
| S1 | One resettable idle timer (keeper 300s) | streamLoop.ts, anthropic.ts |
| S2 | Only emit when text length grows (no dup output, faster) | streamLoop.ts |
| S3 | Session-pool pre-warm + acquire-timeout tuning | sessionPool.ts |
| S4 | Header/fingerprint micro-cache | qwen.ts, bxUaGenerator.ts |
| S5 | JWT token validation gate (reject non-eyJ) | accountManager.ts |

### P2 â€” Agent capability parity

| # | Improvement | Files |
|---|---|---|
| C1 | Context compression >300k (summarize older turns) | chat.ts, chatHelpers.ts |
| C2 | SSO-ticket fallback auth (robust impl) | loginService.ts |
| C3 | Vision/image/video/web-search parity (chatType) | routes |
| C4 | /v1/completions + Gemini/Claude adapters | routes |

### P3 â€” Ops/security
- General plan A1-A8 + optional VLESS proxy-pool (cloud only).

## 4. Verification
- Soak: 50-request burst x3 accounts; 0 idle-timeouts, 0 [DONE]-after-failure, p50 <10s.
- Agent battery: stream, parallel/sequential tools, vision, 300k context, all-throttled.
- Week-long daily tasks with 0 manual re-logs (validates Q4/Q5).
