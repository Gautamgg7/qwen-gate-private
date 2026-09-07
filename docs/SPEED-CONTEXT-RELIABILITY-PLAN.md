# Qwen Gate â€” Speed, Huge-Context & "Never-Stops-Mid-Task" Improvement Plan

> Research + code-grounded analysis date: 2026-09-06. All claims verified in our source.
> Status: PLAN ONLY. No code changed.

---

## A. Where the time actually goes today (from our code)

1. **Per-request `POST /chats/new` (~200-600ms)** â€” `sessionPool.acquire()` calls
   `createSessionWithHeaders()` on EVERY request; the pool is NOT pre-warmed
   (`initialize()` is effectively empty). Every turn pays this RTT.
2. **Big-context path adds +1-4s**: context.txt -> OSS upload -> parse -> parse/status
   polling (4+ network hops).
3. **Multi-turn agents re-pay everything**: each turn = fresh chat + full history
   re-sent + context.txt re-uploaded (issue #44 workaround). No server-side
   prefix/context caching benefit because sessions are thrown away
   (DELETE_SESSION=true default).
4. **Heuristic token estimation** (chars / ~3.5) â€” imprecise; can over-truncate
   (quality loss) or overshoot the model window.
5. **Stream hot path**: MAX_INLINE_CHARS=50000 chars (~14k tokens â€” low vs 1M
   context), per-chunk setTimeout(0) flush, O(n?) buffer slicing (audit P-1/2/4).
6. **getBasicHeaders() fetched per session** â€” not TTL-cached.

---

## B. Speed â€” priority ranked

| # | Change (short) | Expected win | Source pattern | Risk / notes |
|---|----------------|--------------|----------------|--------------|
| B1 | Pre-warmed session pool (create N fresh chats/account at startup + refill; acquire pops a ready session) | Removes /chats/new RTT from every request (~200-600ms/TTFT) | GLM-Free-API SESSION_POOL_SIZE; FreeQwenApi | Low; must GC stale sessions |
| B2 | Conversation reuse for multi-turn agents (parent_id continuation, keyed by client+model, TTL + max-turn + LRU) | Biggest agent-TTFT win: lets Qwen server reuse prefix/KV for later turns | FreeQwenApi keep-context; vLLM prefix caching | Medium; guard against context rot (reset when too large), keep per-account isolation |
| B3 | Content-hash context.txt reuse (same blob -> reuse file_id, skip re-upload) | Saves 4 RTTs/turn for agents re-sending same history | QwenChat2Api cleanup + GLM file-reuse concept | Low-med; per-account file_id cache |
| B4 | Header micro-cache (getBasicHeaders per account, 30-60s TTL) | Saves extra upstream call per session | existing bx cache | Low |
| B5 | Expose knobs: SESSION_POOL_SIZE, session TTL, per-account concurrency | tune-ability | â€” | Low |
| B6 | Stream hot path: one resettable idle timer (done), remove per-chunk setTimeout(0) batching, fix O(n?) buffer slicing | Lower CPU/GC on big streams, smoother output | audit P-1/2/3/4 | Low-med, test SSE ordering |
| B7 | (P2) wreq-js connection reuse w/ keepalive + graceful tokio fallback | fewer TLS handshakes | â€” | HIGH risk (documented epoll/Bun crash) â€” behind a flag only |

---

## C. Huge context â€” "like a real API"

| # | Change (short) | Expected win | Risk / notes |
|---|----------------|-------------|--------------|
| C1 | Real tokenizer or calibrated estimator for context budgeting (feed API usage back to self-calibrate char/token ratios) | No premature truncation (quality) and no window overshoot | Med; pick a light WASM/JS Qwen tokenizer or ratio calibration loop |
| C2 | Raise inline limit intelligently (50k chars is only ~14k tokens); keep more inline when budget allows, push overflow to merged context.txt | Faster for medium contexts (skip file) | Must respect ~10MB body cap |
| C3 | Hierarchical summarization (map-reduce) for >~300k tokens: recent N turns verbatim + compact <chat_history> summary of older turns | Coherent long tasks AND low TTFT; handles "1M context" like centralvii compressor | Med; summary pass itself costs tokens/time on the first long request |
| C4 | File-upload pipeline: content-hash reuse + parallel uploads + tighter parse-status poll | Fewer RTTs on big contexts | Med |
| C5 | Clean context_window error when still over budget (LiteLLM pattern) instead of silent truncation | Honest failures, agent can re-plan | Low |

---

## D. "Never stops before completion"

1. **Idle timeout** â€” DONE (60s->300s default, honest SSE error before [DONE]).
2. **Mid-stream retry on next account** when no meaningful output yet (covers the
   long-thinking-then-fail class; do NOT retry after significant content emitted).
3. **200-body rate-limit/error detection** -> throttle account + real error (PR #68).
4. **Account health scoring + circuit breaker** (healthy/degraded/down; auto-recover);
   pickAccount prefers healthy (QwenChat2Api identity-pool pattern).
5. **Keep-alive heartbeat** already 15s comment ping â€” ensure never treated as content.
6. **Backpressure on wrapped ReadableStream** (audit P-15) â€” avoid CPU/memory spikes.
7. **Treat tokio "Bad file descriptor"/wreq crashes as retryable** -> log + failover.

---

## E. Output quality

| # | Change (short) | Risk |
|---|---------------|------|
| E1 | Stable system-prefix + stable tool-schema ordering (aids caching + model compliance) | Low |
| E2 | Emit only when content length grows (no dup output) â€” align with our dedup fields | Low-med |
| E3 | Tool-call parser edge cases: parallel calls in ONE block, escaped JSON, multi-byte args | Med |
| E4 | Preserve reasoning_content streaming integrity (already) + keep amplification guard tuned | Low |

---

## F. Verification

- Soak: 50 requests x 3 accounts; assert 0 idle-timeouts, 0 [DONE]-after-failure,
  p50 TTFT < 10s.
- Agent loop: 10-round tool task; measure per-turn TTFT before/after B2 (expect
  large drop on later turns).
- Long-context: synthetic ~500k-token file + Q&A; assert no silent truncation and
  coherent answer.
- Context-pool GC: run 100 rounds; assert session count stable + no context rot.
- Week-long daily tasks with 0 manual re-logs (validates auth path).

---

*End â€” recommended order: B1, B2, B3, C1, C2, then D2-D4, then E & F.*
