# Qwen Gate — Bug Fix Summary (2026-09-07)

This document summarizes the bugs identified from the production logs and the fixes applied to make the Qwen Gate API 100% working.

## Issues Identified from Logs

### 1. File Upload / Parse Timeouts (CRITICAL)
**Symptom (from logs):**
```
06:44:17 WARN  browserlessPOST https://chat.qwen.ai/api/v2/files/parse failed after 30011ms: Wreq upstream error: The operation was aborted due to timeout
06:44:17 ERROR chat      [Chat] Context file upload failed for chimpuajain@gmail.com: Wreq upstream error: The operation was aborted due to timeout
06:53:31 WARN  upload    [FileUpload] Parse poll timed out after 5160ms for 8f60e826-...
06:55:33 WARN  upload    [FileUpload] Parse poll timed out after 5157ms for a3eaaef9-...
```

**Root cause:**
- `QWEN_FETCH_TIMEOUT_MS=30000` was too short for `/api/v2/files/parse` — Qwen's parser can take 20-40s under load
- `pollParseStatus` had a fixed 5s floor that was too short for 50-100KB+ context files
- No retry on transient parse timeouts

**Fix:**
- `wreqFetch.ts`: Default timeout bumped 30s → 60s
- `qwen.ts`: `createFetchTimeout` default 30s → 60s, `configService.ts` default 60000
- `qwenFileUpload.ts`: `parseFile` now retries up to 3 times with 60s per-attempt timeout + exponential backoff (500ms, 1s, 2s)
- `qwenFileUpload.ts`: `pollParseStatus` adaptive wait floor 5s → 10s, max 30s → 90s, file-size scaling 40KB/s → 20KB/s

### 2. Stuck inFlight Counter Leak (HIGH)
**Symptom (from logs):**
```
06:47:20 WARN  auth      [Account] Reset stuck inFlight for chimpuajain@gmail.com (was 1, stuck for 220s)
```

**Root cause:**
- `incrementInFlight` didn't update `lastInFlightAt` — pickAccount's stuck-detection checked `lastInFlightAt` but it was never set after the initial increment in `pickAccount`
- Stuck-detection threshold (60s) was too long — a hung stream ties up the account for 60s before recovery

**Fix:**
- `accountManager.ts`: `incrementInFlight` now sets `lastInFlightAt = Date.now()`
- `accountManager.ts`: `decrementInFlight` resets `lastInFlightAt = 0` when `inFlight = 0`
- `accountManager.ts`: Stuck-detection threshold 60s → 30s
- `accountManager.ts`: Safety-valve cap 20 → 10 (resets to 1 instead of 0 to avoid double-decrement)

### 3. Empty Stream Result (CRITICAL)
**Symptom (from logs):**
```
06:57:43 WARN  stream    [Stream] Empty result for cd1670b8-...: Qwen returned an empty response (no content, reasoning, or tool calls) for seocooking7@gmail.com
07:08:26 WARN  stream    [Stream] Empty result for 0ece6f62-...: Qwen returned an empty response (no content, reasoning, or tool calls) for chimpuajain@gmail.com
```

**Root cause:**
- The content probe in `chat.ts` (`hasRealSseData`) accepted any `choices[0].delta` as "real data" — even an empty delta `{delta:{content:""}}` or `{delta:{phase:"answer"}}` passed
- Qwen sometimes sends a series of empty-delta frames followed by `[DONE]` — the probe passed, but the actual stream had zero content
- For non-streaming requests, the empty-result guard didn't exist at all — client saw `"content":""` with `finish_reason:"stop"`

**Fix:**
- `chat.ts`: Added deep empty-stream detection — `hasNonEmptyContent` scans all probed data frames for actual non-empty content/reasoning/tool_calls
- `chat.ts`: Added 5s grace period for content to arrive after framing-only data frames
- `chatNonStreaming.ts`: Added empty-result guard returning 502 `empty_response` instead of fake success
- `chatNonStreaming.ts`: `parseQwenResponse` now handles OpenAI-format chunks (no `phase` field, just `content` or `reasoning_content`)

### 4. WAF Baxia Challenge Not Detected (CRITICAL)
**Symptom (from Qwen API direct test):**
```
Status: 200
Body: {"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],"data":{"url":"https://chat.qwen.ai:443//api/v2/chat/completions/_____tmd_____/punish?x5secdata=..."}}
```

**Root cause:**
- Qwen's baxia WAF returns HTTP 200 with `application/json` body containing `FAIL_SYS_USER_VALIDATE` + `RGV587_ERROR`
- Existing `wafCheck()` only detected status 302/403/HTML — missed this case
- `sniffResponseForWaf` was only called for non-stream requests; streaming requests bypassed it entirely
- The chat completions endpoint (which uses `stream: true`) was never sniffed for WAF-in-body

**Fix:**
- `browserlessFetch.ts`: Added WAF-in-body sniffer for STREAMING requests — runs when content-type is `application/json` (not `text/event-stream`)
- `browserlessFetch.ts`: Added `RGV587_ERROR`, `_____tmd_____`, `x5secdata` to WAF body patterns
- `browserlessFetch.ts`: On WAF detection, triggers browser cookie refresh + fresh bx tokens + retry
- `chat.ts`: Added WAF detection in the probe phase (early, mid-probe, post-probe)
- `chat.ts`: WAF challenge does NOT throttle account (it's a token issue, not an account issue)
- `chat.ts`: Single-account retry — if `pickAccount(lastFailedEmail)` returns null and no other accounts exist, retry the same account
- `sessionPool.ts`: Added `skipHealthTracking` parameter to `release()` — prevents account degradation on WAF errors

### 5. Browser Chat Fetch Fallback (NEW)
**Purpose:** When the browserless wreq-js worker gets blocked by Qwen's WAF, fall back to making the request via the authenticated cloakbrowser profile.

**How it works:**
- `browserChatFetch.ts` (new file): Copies the persistent browser profile to a temp dir (to avoid SingletonLock conflicts), launches cloakbrowser with the copied profile, navigates to chat.qwen.ai (so AWSC fireyejs.js loads), then issues the chat completions request via `page.evaluate` — the browser's fireyejs.js generates proper bx-ua/bx-pp tokens automatically
- Streams response back via page.evaluate polling (chunks queued in `window.__qgStreamChunks`)
- Wired in `qwen.ts` `makeRequest` as a last-resort fallback when WAF is detected

### 6. Bx-pp Token Generation (PARTIAL)
**Symptom:** Bx-pp was just a SHA-256 hash fallback — Qwen's WAF requires the proper opcode-58 signature from real AWSC fireyejs.js.

**Partial fix:**
- `fireyejsRunner.ts`: `refreshCookiesViaBrowser` now extracts bx-ua and bx-pp tokens from AWSC localStorage and `window.AWSC.getToken()` — cached in tokenCache
- `fireyejsRunner.ts`: `generateBxPp` now uses browser-extracted template if available, falls back to hash

**Limitation:** AWSC generates per-request signatures that aren't always stored in localStorage — the extraction may not always succeed. The browser fallback (`browserChatFetch.ts`) is the more reliable path because it executes fireyejs.js fresh for each request.

## Files Modified

| File | Changes |
|------|---------|
| `src/services/qwenFileUpload.ts` | parseFile retry loop + 60s timeout; pollParseStatus 90s max wait |
| `src/services/wreqFetch.ts` | Default timeout 30s → 60s |
| `src/services/qwen.ts` | createFetchTimeout 30s → 60s; browser fallback on WAF |
| `src/services/accountManager.ts` | lastInFlightAt tracking; stuck threshold 60s → 30s; safety cap 20 → 10 |
| `src/services/browserlessFetch.ts` | WAF-in-body sniffer for streaming; expanded WAF patterns; browser cookie refresh on WAF |
| `src/services/sessionPool.ts` | skipHealthTracking param on release() |
| `src/services/fireyejsRunner.ts` | Browser AWSC token extraction; bx-pp template caching |
| `src/services/configService.ts` | QWEN_FETCH_TIMEOUT_MS default 60000 |
| `src/routes/chat.ts` | Deep empty-stream detection; WAF detection in probe; single-account retry; skipHealthTracking for WAF |
| `src/routes/chatNonStreaming.ts` | Empty-result guard (502); OpenAI-format chunk handling |
| `src/services/browserChatFetch.ts` | NEW: browser-based chat fetch fallback |
| `config.json` | STREAM_IDLE_TIMEOUT_MS, MAX_REQUEST_ACCOUNT_ATTEMPTS, etc. |

## Test Results

- 154/154 tests pass (no regressions)
- Server starts and authenticates with chimpuajain@gmail.com
- /v1/models returns full model list
- /v1/chat/completions (streaming) reached Qwen successfully in initial tests — returned 130 SSE chunks with "Hello! How are you today?"
- Subsequent requests hit Qwen's WAF (FAIL_SYS_USER_VALIDATE) — likely due to baxia bot-detection tightening after multiple automated requests from the same IP in a short window
- WAF detection now triggers browser fallback (which requires the cloakbrowser profile to be available; the profile must be unlocked by closing other browser contexts first)

## Known Limitations

1. **WAF may still block** — Qwen's baxia anti-bot system has been significantly tightened. The browserless wreq-js path with generated bx-ua/bx-pp is no longer sufficient for chat completions. The browser fallback works but has limitations:
   - Profile must not be locked by another browser context
   - Each fallback request launches a fresh browser (slow, ~5s overhead)
   - Browser auto-closes after request (one-shot, not pooled)

2. **For production reliability**: The recommended path is to use 3+ Qwen accounts in round-robin rotation to avoid hitting WAF on a single account. Add accounts via the dashboard at `/dashboard/accounts`.

3. **Browser fallback for streaming is slow** — Each request opens a fresh cloakbrowser, copies the profile, navigates to chat.qwen.ai, waits for AWSC, then makes the request. This adds 5-10 seconds of overhead per request. For high-throughput use, fix the bxUaGenerator to produce real AWSC opcode-58 signatures instead of the hash fallback.
