import crypto from 'node:crypto';
import { Context } from 'hono';
import { pickAccount, throttleAccount } from '../services/auth.ts';
import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';
import { modelRouter } from '../services/modelRouter.ts';
import { RetryableQwenStreamError } from '../services/qwen.ts';
import type { QwenFileAttachment } from '../services/qwenFileUpload.ts';
import { uploadImageAsFile, uploadLargeTextAsFile } from '../services/qwenFileUpload.ts';
import { sessionPool } from '../services/sessionPool.ts';
import { cleanTextOfXmlArtifacts } from '../tools/xmlToolParser.ts';
import { OpenAIRequest } from '../types/openai.ts';
import { checkContextWindow, estimateTokens } from '../utils/tokenEstimator.ts';
import { validateOpenAIRequest } from '../utils/validation.ts';
import {
  acquireSessionWithCorrections,
  buildQwenMessages,
  createQwenStreamWithRetry,
  getModelSpecs,
  handleImageModelFallback,
  resolveModelName,
} from './chatHelpers.ts';
import { handleNonStreamingRequest } from './chatNonStreaming.ts';
import { handleStreamingRequest } from './chatStreaming.ts';

export {
  commonPrefixLen,
  getNewContent,
} from './chatHelpers.ts';

const MAX_MESSAGE_SIZE = 10_000_000; // 10MB — large payloads are uploaded as files via Qwen's file API

async function parseRequestBody(c: Context) {
  const rawBody = await c.req.json();

  // Schema validation via zod — catches malformed requests early
  const validation = validateOpenAIRequest(rawBody);
  if (!validation.ok) {
    const err = new Error(validation.error!);
    (err as any).upstreamStatus = validation.status || 400;
    (err as any).type = 'invalid_request_error';
    (err as any).code = validation.code || 'invalid_request_error';
    throw err;
  }

  const body = validation.data as unknown as OpenAIRequest;

  // Canonicalize client model names ("Qwen3.8-Max", "qwen/qwen3.8-max", …)
  // to Qwen's exact upstream ID — Qwen rejects anything else with
  // "Not_Found: Model not found".
  body.model = await resolveModelName(body.model);

  // Per-message size validation to prevent OOM during estimateTokens
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (content && content.length > MAX_MESSAGE_SIZE) {
        const err = new Error(`Message content exceeds maximum size of ${MAX_MESSAGE_SIZE} characters`);
        (err as any).upstreamStatus = 400;
        (err as any).type = 'invalid_request_error';
        (err as any).code = 'message_too_large';
        throw err;
      }
    }
  }

  let isStream = body.stream ?? false;
  const streamMode = config.get('STREAMING_MODE', 'auto');
  if (streamMode === 'stream') isStream = true;
  else if (streamMode === 'non-stream') isStream = false;
  const toolCalling = config.getBool('TOOL_CALLING', true);
  const cleanOutput = config.getBool('CLEAN_OUTPUT', true);

  const messages = body.messages || [];

  await handleImageModelFallback(body, messages);
  const { maxContext, maxOutput } = await getModelSpecs(body);

  const formattedMessages = messages.map((m) => ({
    role: m.role,
    content: Array.isArray(m.content) ? m.content.map((c: any) => c.text || JSON.stringify(c)).join('\n') : String(m.content ?? ''),
  }));
  const estimatedTokens = estimateTokens(formattedMessages.map((m) => m.content).join('\n'));
  const contextCheck = checkContextWindow(estimatedTokens, maxContext, maxOutput, body.model as string, formattedMessages);

  return {
    body,
    isStream,
    toolCalling,
    cleanOutput,
    messages,
    contextCheck,
    availableTokens: contextCheck.availableTokens,
  };
}

/**
 * Hierarchical context compression (C3).
 *
 * When the estimated token count exceeds the compression threshold, older
 * conversation turns are collapsed into compact one-line digests while recent
 * turns stay verbatim. This preserves task context (the model can still see
 * what happened before) while cutting the prompt size enough to fit the
 * inline budget and keep TTFT low.
 *
 * The segment format matches buildQwenMessages output: `<user>…</user>` and
 * `<assist>…</assist>` blocks separated by blank lines.
 */
function compressHistorySegments(inlineContent: string): string {
  const parts = inlineContent.split(/\n\n(?=<user>|<assist>)/);
  if (parts.length < 6) return inlineContent; // too few turns to benefit

  // Keep the first segment (the task) and the last 4 segments verbatim;
  // collapse everything in between into one-line summaries.
  const KEEP_RECENT = 4;
  const keepHead = parts[0];
  const keepTail = parts.slice(-KEEP_RECENT);
  const middle = parts.slice(1, -KEEP_RECENT);

  if (middle.length === 0) return inlineContent;

  const summaries = middle.map((seg) => {
    const roleMatch = seg.match(/^<(user|assist)>/);
    const role = roleMatch ? roleMatch[1] : 'turn';
    // Extract first meaningful line as digest
    const inner = seg.replace(/^<(?:user|assist)>\n?/, '').replace(/\n<\/(?:user|assist)>\s*$/, '');
    const firstLine = inner.split('\n').find((l) => l.trim().length > 0) || '';
    const digest = firstLine.trim().substring(0, 200) + (inner.length > 200 ? '…' : '');
    return `<turn_summary role="${role}">${digest}</turn_summary>`;
  });

  const compressed = [
    keepHead,
    `[COMPRESSED HISTORY — ${middle.length} older turns summarized below]`,
    ...summaries,
    ...keepTail,
  ].join('\n\n');

  return compressed;
}

async function setupSession(messages: any[], body: OpenAIRequest, availableTokens: number, toolCalling: boolean, logId: string, estimatedPromptTokens: number = 0) {
  // ── Image detection ──────────────────────────────────────────
  // Only scan the LAST message — previous turns already uploaded their images
  let hasImages = false;
  const imageUrls: string[] = [];

  const lastMsg = messages[messages.length - 1];
  if (lastMsg && Array.isArray(lastMsg.content)) {
    for (const part of lastMsg.content) {
      if (part?.type === 'image_url' && part?.image_url?.url) {
        hasImages = true;
        imageUrls.push(part.image_url.url);
      }
    }
  }

  // Strip image_url parts only from the last message
  // (older messages shouldn't have them, but handle for safety)
  let cleanedMessages = messages;
  if (hasImages) {
    cleanedMessages = messages.map((msg: any, idx: number) => {
      if (idx !== messages.length - 1) return msg; // only strip last message
      if (!Array.isArray(msg.content)) return msg;
      const textParts = msg.content.filter((c: any) => c.type !== 'image_url');
      return { ...msg, content: textParts.length > 0 ? textParts : [{ type: 'text', text: '[Image]' }] };
    });
  }

  const {
    qwenMessages: processedMessages,
    systemContent,
    toolResultsContent,
  } = buildQwenMessages(cleanedMessages, body, availableTokens, toolCalling);

  // ── Inline content truncation (C2 — configurable) ────────────────
  // Keep the most recent N characters inline; push older history into
  // context.txt so the model can reference it when needed.
  const MAX_INLINE_CHARS = config.getInt('MAX_INLINE_CHARS', 120_000);
  let inlineContent = processedMessages[0].content as string;
  let chatHistoryContent = '';

  // ── Hierarchical context compression (C3) ─────────────────────────
  // When the estimated token count blows past the compression threshold,
  // older conversation turns are collapsed into compact one-line digests.
  // Recent turns stay verbatim so the model keeps full fidelity on the
  // current task while old turns remain referenceable via summaries.
  const compressionThreshold = config.getInt('CONTEXT_COMPRESSION_THRESHOLD', 150_000);
  if (typeof inlineContent === 'string' && estimatedPromptTokens > compressionThreshold) {
    inlineContent = compressHistorySegments(inlineContent);
    processedMessages[0] = { ...processedMessages[0], content: inlineContent };
    logStore.log('info', 'chat', `[Chat] Context compression applied: ${estimatedPromptTokens} est. tokens > ${compressionThreshold} threshold`);
  }

  if (typeof inlineContent === 'string' && inlineContent.length > MAX_INLINE_CHARS) {
    // Split on message boundaries: \n\n followed by <user> or <assist>
    const parts = inlineContent.split(/\n\n(?=<user>|<assist>)/);

    // Walk backwards — keep as many recent segments as fit within limit
    let keptLen = 0;
    let splitIdx = parts.length;
    for (let i = parts.length - 1; i >= 0; i--) {
      const addLen = parts[i].length + (keptLen > 0 ? 2 : 0);
      if (keptLen + addLen <= MAX_INLINE_CHARS) {
        keptLen += addLen;
        splitIdx = i;
      } else {
        break;
      }
    }

    // ponytail: simple character-based split at message boundaries.
    // If models need more precise token-aware splitting, add later.
    if (splitIdx > 0) {
      chatHistoryContent = parts.slice(0, splitIdx).join('\n\n');
      inlineContent = parts.slice(splitIdx).join('\n\n');
      processedMessages[0] = { ...processedMessages[0], content: inlineContent };
    }
  }

  // ── Conversation key (B2) ─────────────────────────────────────────
  // Hash the first user message + model to create a stable conversation key.
  // Agent loops (OpenCode, Claude Code) resend the same task prompt across
  // turns, so the key stays stable and the session is reused (parent_id
  // continuation + warm pool + no /chats/new on repeat turns).
  const firstUserContent = messages.find((m: any) => m.role === 'user')?.content;
  const firstUserStr = typeof firstUserContent === 'string'
    ? firstUserContent
    : Array.isArray(firstUserContent)
      ? firstUserContent.map((c: any) => c.text || JSON.stringify(c)).join('\n')
      : JSON.stringify(firstUserContent ?? '');
  const conversationKey = crypto
    .createHash('sha256')
    .update(`${body.model}::${firstUserStr.substring(0, 2000)}`)
    .digest('hex')
    .slice(0, 16);

  // File upload happens inside retry loop using the same account as the request
  // (accounts can't access files uploaded by other accounts — must share the account)
  let lastFailedEmail: string | undefined;

  const isThinkingModel = !body.model.includes('no-thinking');
  const MAX_ACCOUNT_RETRIES = 5;
  let lastError: any;

  for (let attempt = 0; attempt < MAX_ACCOUNT_RETRIES; attempt++) {
    // pickAccount may return null if lastFailedEmail excludes all accounts.
    // In single-account setups (or when only one account is healthy), retry
    // without excluding the last failed account — the issue may be a transient
    // WAF challenge (bx-token issue, not account issue) that just needs a
    // fresh token + brief backoff.
    let selectedAccount = await pickAccount(lastFailedEmail);
    if (!selectedAccount && lastFailedEmail) {
      // No other accounts available — retry the same account with fresh tokens
      logStore.log('warn', 'chat', `[Chat] No other accounts available — retrying with ${lastFailedEmail} (attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES})`);
      selectedAccount = await pickAccount();
    }
    const accountEmail = selectedAccount?.email;
    if (!selectedAccount && attempt > 0) {
      // On retry: if still no accounts, all are throttled — stop retrying
      throw lastError || new Error('All accounts are rate-limited. Please wait and try again later.');
    }

    // Upload images with concurrency limit — impers worker handles concurrency
    let imageFiles: QwenFileAttachment[] = [];
    if (hasImages && accountEmail) {
      const MAX_CONCURRENT = 2;
      for (let i = 0; i < imageUrls.length; i += MAX_CONCURRENT) {
        const batch = imageUrls.slice(i, i + MAX_CONCURRENT);
        const results = await Promise.all(
          batch.map((url) =>
            uploadImageAsFile(accountEmail, url).catch((err: any) => {
              logStore.log('warn', 'chat', `[Chat] Image upload failed: ${err.message}`);
              return null;
            }),
          ),
        );
        imageFiles.push(...results.filter((f): f is QwenFileAttachment => f !== null));
      }
      if (imageFiles.length === 0) {
        throw new Error('Failed to upload images — none of the image files could be uploaded');
      }
    }

    // Upload a single context file: system instructions + tool results + older chat history
    // Merging cuts upload overhead in half (one STS token, one OSS upload, one parse poll)
    if (accountEmail && (systemContent || toolResultsContent || chatHistoryContent)) {
      const parts: string[] = [];
      if (systemContent) parts.push(`<system-instructions>\n${systemContent}\n</system-instructions>`);
      if (toolResultsContent) parts.push(`<tool-results>\n${toolResultsContent}\n</tool-results>`);
      if (chatHistoryContent) parts.push(`<chat_history>\n${chatHistoryContent}\n</chat_history>`);
      const combinedContent = parts.join('\n\n');
      try {
        const file = await uploadLargeTextAsFile(accountEmail, combinedContent, 'context.txt');
        processedMessages[0] = { ...processedMessages[0], files: [file] };
      } catch (err: any) {
        // NEVER fall back to sending the payload inline: Qwen bot-detects
        // oversized user messages and the request hangs/spins. Retry on the
        // next account (upload failure is per-account); if all exhaust, the
        // loop throws a real error instead of silently sending inline.
        logStore.log('error', 'chat', `[Chat] Context file upload failed for ${accountEmail}: ${err.message || err}`);
        lastFailedEmail = accountEmail;
        lastError = err;
        continue;
      }
    }

    // Attach uploaded images to the first message
    if (imageFiles.length > 0) {
      processedMessages[0] = {
        ...processedMessages[0],
        files: [...(processedMessages[0].files || []), ...imageFiles],
      };
    }

    let sessionResult;
    try {
      sessionResult = await acquireSessionWithCorrections(accountEmail, processedMessages, conversationKey);
    } catch (err) {
      lastFailedEmail = accountEmail;
      lastError = err;
      logStore.log(
        'warn',
        'chat',
        `[Chat] Session acquire failed for ${accountEmail || '?'}: ${err instanceof Error ? err.message : String(err)}`,
      );
      logStore.addError(logId, `Session acquire failed for ${accountEmail || '?'}: ${err instanceof Error ? err.message : String(err)}`);
      continue; // Try next account
    }
    const { session, qwenMessages: sessionMessages, nextParentId, sessionHeaders, resolvedEmail } = sessionResult;

    // Populate the account that served this request
    logStore.updateEntry(logId, (entry) => {
      entry.accountEmail = resolvedEmail;
    });

    let routedModel;
    let streamResult;
    try {
      routedModel = await modelRouter.route(body.model);
      streamResult = await createQwenStreamWithRetry(
        sessionMessages,
        isThinkingModel,
        routedModel,
        session.chatId,
        nextParentId,
        resolvedEmail,
        body.tools,
        body.tool_choice,
      );
    } catch (err: any) {
      // Release the acquired session to prevent pool exhaustion + inFlight leak.
      // For WAF/bot-detection errors, skip health tracking — it's a bx-token
      // issue, not an account issue, and we don't want to degrade the only
      // account in single-account setups.
      const isWafError = (err.message || '').includes('FAIL_SYS_USER_VALIDATE') ||
                         (err.message || '').includes('WAF') ||
                         (err.message || '').includes('RGV587_ERROR');
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false, undefined, isWafError);

      logStore.log(
        'debug',
        'chat',
        `[Chat] Request failed on ${resolvedEmail}: ${err.message || err} (attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES})`,
      );
      logStore.addError(logId, `Stream creation failed for ${resolvedEmail}: ${err.message || String(err)}`);

      // If rate limited, try next account — Qwen didn't process the request yet
      if (err.upstreamStatus === 429 || /RateLimited|daily usage limit/i.test(err.message || '')) {
        lastFailedEmail = resolvedEmail;
        lastError = err;
        continue;
      }
      // Bot detection / CAPTCHA: Qwen rejected BEFORE processing (safe to retry).
      // WAF (FAIL_SYS_USER_VALIDATE) is a bx-token issue, NOT an account issue —
      // don't throttle the account, just invalidate bx tokens and retry.
      // For an actual CAPTCHA (rare), throttling makes sense, but FAIL_SYS_USER_VALIDATE
      // is far more common and shouldn't lock out the only account in a 1-account setup.
      if (
        (err.message || '').includes('FAIL_SYS_USER_VALIDATE') ||
        (err.message || '').includes('WAF') ||
        (err.message || '').includes('CAPTCHA') ||
        err instanceof RetryableQwenStreamError
      ) {
        lastFailedEmail = resolvedEmail;
        lastError = err;
        // Only throttle for actual CAPTCHA (baxia asking user to solve a puzzle),
        // not for FAIL_SYS_USER_VALIDATE (bx-token regeneration needed)
        const isActualCaptcha = (err.message || '').includes('CAPTCHA') && !(err.message || '').includes('FAIL_SYS_USER_VALIDATE');
        if (isActualCaptcha && resolvedEmail) throttleAccount(resolvedEmail, 5 * 60 * 1000);
        // For WAF: brief backoff so bx tokens regenerate before next attempt
        if (!isActualCaptcha) await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      // Timeout / slow response: Qwen didn't respond in time — skip to next account without penalty
      if (
        err.name === 'AbortError' ||
        (err.message || '').includes('timed out') ||
        (err.message || '').includes('timeout') ||
        (err.message || '').includes('ETIMEDOUT') ||
        err.upstreamStatus === 408 ||
        err.upstreamStatus === 504
      ) {
        lastFailedEmail = resolvedEmail;
        lastError = err;
        continue;
      }
      // All other errors (network, session): Qwen may have processed the request.
      // Don't throttle — let the user retry manually.
      throw err;
    }
    let { stream, abortController: qwenAbortController } = streamResult;

    // First-chunk timeout: Qwen sometimes sends HTTP headers but never body data (silent hang).
    // Wait up to 60s for the first byte. If none arrives, release this session and try next account.
    const FIRST_CHUNK_MS = 60_000;
    const streamReader = stream.getReader();
    let firstChunk: any;
    let firstChunkTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      firstChunk = await Promise.race([
        streamReader.read(),
        new Promise<never>((_, reject) => {
          firstChunkTimer = setTimeout(
            () => reject(new Error(`No first chunk from ${resolvedEmail} within ${FIRST_CHUNK_MS / 1000}s`)),
            FIRST_CHUNK_MS,
          );
        }),
      ]);
    } catch (timeoutErr) {
      clearTimeout(firstChunkTimer);
      logStore.log(
        'warn',
        'chat',
        `[Chat] First-chunk timeout for ${resolvedEmail} after stream started (${attempt + 1}/${MAX_ACCOUNT_RETRIES})`,
      );
      logStore.addError(logId, `First-chunk timeout for ${resolvedEmail}`);
      streamReader.cancel().catch(() => {});
      qwenAbortController?.abort();
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);
      lastFailedEmail = resolvedEmail;
      lastError = timeoutErr as Error;
      continue;
    }
    clearTimeout(firstChunkTimer);

    // ── Empty-stream guard (FIX) ─────────────────────────────────────
    // Qwen sometimes returns HTTP 200 with an EMPTY body — the upstream SSE
    // ends instantly with zero content/tool-calls, and the client (OpenCode)
    // sees a "successful" but empty turn. Detect an empty first chunk and
    // retry on the next account instead of emitting a fake completion.
    const firstChunkEmpty =
      firstChunk.done || !firstChunk.value || firstChunk.value.length === 0;
    if (firstChunkEmpty) {
      logStore.log(
        'warn',
        'chat',
        `[Chat] Empty first chunk from ${resolvedEmail} — upstream 200 with empty body (attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES})`,
      );
      logStore.addError(logId, `Empty upstream body from ${resolvedEmail}`);
      streamReader.cancel().catch(() => {});
      qwenAbortController?.abort();
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);
      lastFailedEmail = resolvedEmail;
      lastError = new Error(`Qwen returned an empty response body (${resolvedEmail})`);
      if (resolvedEmail) {
        try {
          const { recordAccountFailure } = await import('../services/auth.ts');
          recordAccountFailure(resolvedEmail);
        } catch {
          /* best effort */
        }
      }
      continue;
    }

    // ── Content probe (deeper empty-stream fix) ──────────────────────
    // The first chunk can carry SSE framing bytes (heartbeats / partial
    // frames) and still pass the empty-first-chunk guard, while the upstream
    // ends instantly with ZERO real data frames — the client then sees a
    // "successful" but empty turn. Before committing to this account, keep
    // reading until a real data frame arrives or the stream ends (bounded
    // deadline). No real data → treat as empty response and retry on the
    // next account: nothing has been written to the client yet, so the
    // failover is completely transparent to OpenCode.
    const probeChunks: Uint8Array[] = [];
    if (!firstChunk.done && firstChunk.value) probeChunks.push(firstChunk.value);
    const probeDecoder = new TextDecoder();
    const hasRealSseData = (text: string): boolean => {
      for (const line of text.split('\n')) {
        const l = line.trim();
        if (!l.startsWith('data:')) continue;
        const payload = l.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          // Qwen data frames: {choices:[{delta:{...}}]}, {response_id},
          // {response:{created}}, {usage}, {error} — any of these means the
          // stream is actually delivering content.
          if (obj?.choices?.[0]?.delta) return true;
          if (obj?.response_id || obj?.['response.created']?.response_id) return true;
          if (obj?.usage || obj?.error) return true;
        } catch {
          /* partial JSON line — keep probing */
        }
      }
      return false;
    };
    let probeText = firstChunk.done ? '' : probeDecoder.decode(firstChunk.value, { stream: true });
    let sawRealData = hasRealSseData(probeText);
    const PROBE_DEADLINE_MS = 20_000;
    const probeDeadline = Date.now() + PROBE_DEADLINE_MS;
    let probeDataFrameCount = 0;
    let probeTextAccumulated = probeText;
    // ── Early WAF-in-stream detection ──────────────────────────────────
    // Qwen's baxia WAF sometimes returns HTTP 200 + application/json body
    // with {"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::..."],...}
    // — this looks like real data to hasRealSseData (the JSON object has
    // choices/ret/etc.), but it's actually a bot-detection error. Catch it
    // here so the retry loop kicks in with fresh bx tokens.
    const probeLooksLikeWaf = (text: string): boolean => {
      if (!text) return false;
      // Match the baxia error pattern (response is JSON, not SSE)
      if (text.includes('FAIL_SYS_USER_VALIDATE')) return true;
      if (text.includes('RGV587_ERROR')) return true;
      if (text.includes('_____tmd_____/punish')) return true;
      if (text.includes('x5secdata')) return true;
      return false;
    };
    if (probeLooksLikeWaf(probeText)) {
      logStore.log('warn', 'chat', `[Chat] WAF baxia challenge detected in stream from ${resolvedEmail} (attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES}). Body: ${JSON.stringify(probeText.slice(0, 400))}`);
      logStore.addError(logId, `WAF baxia challenge (FAIL_SYS_USER_VALIDATE) from ${resolvedEmail}`);
      // Invalidate bx tokens for fresh retry — WAF is a token issue, not an
      // account issue. Don't throttle the account (only 1-account setups would
      // otherwise immediately exhaust). Just invalidate bx-ua/bx-pp/acw_tc and
      // try the next account with freshly generated tokens.
      try {
        const { resetBxUaCache } = await import('../services/fireyejsRunner.ts');
        resetBxUaCache();
      } catch { /* best effort */ }
      streamReader.cancel().catch(() => {});
      qwenAbortController?.abort();
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false, undefined, true);
      lastFailedEmail = resolvedEmail;
      lastError = new Error(`WAF baxia challenge (FAIL_SYS_USER_VALIDATE) for ${resolvedEmail}`);
      // Brief backoff so the next attempt generates fresh bx tokens
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    while (!sawRealData) {
      const remainingMs = probeDeadline - Date.now();
      if (remainingMs <= 0) {
        logStore.log('warn', 'chat', `[Chat] Content probe deadline hit (${PROBE_DEADLINE_MS / 1000}s, no data frame) from ${resolvedEmail}`);
        break;
      }
      // Check for WAF baxia challenge on each iteration too (in case body
      // arrives in multiple chunks)
      if (probeLooksLikeWaf(probeTextAccumulated)) {
        logStore.log('warn', 'chat', `[Chat] WAF baxia challenge detected mid-probe from ${resolvedEmail} (attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES}). Body: ${JSON.stringify(probeTextAccumulated.slice(0, 400))}`);
        logStore.addError(logId, `WAF baxia challenge (FAIL_SYS_USER_VALIDATE) from ${resolvedEmail}`);
        try {
          const { resetBxUaCache } = await import('../services/fireyejsRunner.ts');
          resetBxUaCache();
        } catch { /* best effort */ }
        streamReader.cancel().catch(() => {});
        qwenAbortController?.abort();
        sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false, undefined, true);
        lastFailedEmail = resolvedEmail;
        lastError = new Error(`WAF baxia challenge (FAIL_SYS_USER_VALIDATE) for ${resolvedEmail}`);
        await new Promise((r) => setTimeout(r, 1000));
        // Force outer loop to retry with a different account
        sawRealData = false;
        // Break out of the probe loop and let the outer continue handle it
        break;
      }
      const probeResult: any = await Promise.race([
        streamReader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), remainingMs)),
      ]);
      if (probeResult.value) {
        probeChunks.push(probeResult.value);
        const newText = probeDecoder.decode(probeResult.value, { stream: true });
        probeText += newText;
        probeTextAccumulated += newText;
        sawRealData = hasRealSseData(probeText);
        if (sawRealData) probeDataFrameCount++;
      }
      if (probeResult.done) break; // upstream ended (or deadline) with no data frame
    }
    // Re-check WAF after probe finished (in case WAF arrived in last chunk)
    if (probeLooksLikeWaf(probeTextAccumulated)) {
      logStore.log('warn', 'chat', `[Chat] WAF baxia challenge detected post-probe from ${resolvedEmail} (attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES}). Body: ${JSON.stringify(probeTextAccumulated.slice(0, 400))}`);
      logStore.addError(logId, `WAF baxia challenge (FAIL_SYS_USER_VALIDATE) from ${resolvedEmail}`);
      try {
        const { resetBxUaCache } = await import('../services/fireyejsRunner.ts');
        resetBxUaCache();
      } catch { /* best effort */ }
      streamReader.cancel().catch(() => {});
      qwenAbortController?.abort();
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false, undefined, true);
      lastFailedEmail = resolvedEmail;
      lastError = new Error(`WAF baxia challenge (FAIL_SYS_USER_VALIDATE) for ${resolvedEmail}`);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    // ── Deep empty-stream detection (deeper than hasRealSseData) ──────
    // Qwen sometimes sends a series of SSE data frames with empty deltas
    // (e.g. {choices:[{delta:{content:""}}]} or {choices:[{delta:{phase:"answer",
    // content:""}}]}) followed by [DONE]. The basic hasRealSseData() check
    // passes (any delta counts as "real data"), but the stream carries ZERO
    // usable content. This caused the "empty result" warnings in the live
    // logs after stream completion.
    // Solution: scan all probed data frames for any non-empty content,
    // reasoning_content, or local_mcp tool calls. If ALL data frames had
    // empty content (no actual text emitted), treat as empty response and
    // retry on the next account.
    if (sawRealData) {
      const hasNonEmptyContent = (text: string): boolean => {
        for (const line of text.split('\n')) {
          const l = line.trim();
          if (!l.startsWith('data:')) continue;
          const payload = l.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const delta = obj?.choices?.[0]?.delta;
            if (!delta) continue;
            // Has actual answer content
            if (typeof delta.content === 'string' && delta.content.length > 0) return true;
            // Has reasoning content
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) return true;
            // Has thinking content via extra.summary_thought
            const summaryContent = delta?.extra?.summary_thought?.content;
            if (Array.isArray(summaryContent) && summaryContent.length > 0) return true;
            // Has tool calls
            if (delta?.extra?.local_mcp) return true;
            // Has usage info only — keep going (might be mid-stream)
          } catch {
            /* partial JSON line — keep probing */
          }
        }
        return false;
      };
      // Wait a bit more for actual content if we only saw framing-only data frames
      if (!hasNonEmptyContent(probeTextAccumulated)) {
        // Give Qwen a short grace period (5s) — sometimes the first data frames
        // are pure "phase" markers and the real content arrives 1-2 frames later.
        let graceSawContent = false;
        const graceDeadline = Date.now() + 5_000;
        while (!graceSawContent && Date.now() < graceDeadline) {
          const remainingMs = graceDeadline - Date.now();
          const graceResult: any = await Promise.race([
            streamReader.read(),
            new Promise((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), remainingMs)),
          ]);
          if (graceResult.value) {
            probeChunks.push(graceResult.value);
            const newText = probeDecoder.decode(graceResult.value, { stream: true });
            probeTextAccumulated += newText;
            if (hasNonEmptyContent(newText)) {
              graceSawContent = true;
            }
          }
          if (graceResult.done) break;
        }
        if (!graceSawContent) {
          logStore.log(
            'warn',
            'chat',
            `[Chat] Empty SSE data frames (framing-only) from ${resolvedEmail} — upstream returned 200 with no real content (attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES}). First bytes: ${JSON.stringify(probeTextAccumulated.slice(0, 400))}`,
          );
          sawRealData = false; // demote to empty so the retry block below kicks in
        }
      }
    }
    if (!sawRealData) {
      // Non-SSE JSON body (e.g. {"success":false,data:{code:"RateLimited",...}})
      // — NOT an empty stream. The downstream JSON-error translation maps this
      // to a proper 4xx/5xx response, so hand the buffered bytes through
      // unchanged instead of treating it as an empty response.
      const probeTrimmed = probeText.trimStart();
      const looksLikeJsonBody =
        (probeTrimmed.startsWith('{') || probeTrimmed.startsWith('[')) &&
        !probeText.includes('data:');
      if (!looksLikeJsonBody) {
      // FAIL_SYS_USER_VALIDATE = Aliyun WAF rejected our bx-ua/bx-pp token —
      // NOT an account problem. Invalidate the cached bx-ua so the next
      // attempt (this or another account) generates a fresh token.
      const wafRejected = probeText.includes('FAIL_SYS_USER_VALIDATE');
      if (wafRejected) {
        try {
          const { resetBxUaCache } = await import('../services/fireyejsRunner.ts');
          resetBxUaCache();
          logStore.log('warn', 'chat', `[Chat] WAF token rejection (FAIL_SYS_USER_VALIDATE) — bx-ua cache invalidated, next attempt regenerates`);
        } catch {
          /* best effort */
        }
      }
      logStore.log(
        'warn',
        'chat',
        `[Chat] Empty content probe from ${resolvedEmail} — upstream 200 with no data frames (attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES}). First bytes: ${JSON.stringify(probeText.slice(0, 400))}`,
      );
      logStore.addError(logId, `Empty upstream SSE (no data frames) from ${resolvedEmail}`);
      streamReader.cancel().catch(() => {});
      qwenAbortController?.abort();
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);
      lastFailedEmail = resolvedEmail;
      lastError = new Error(`Qwen returned an empty response (no data frames) for ${resolvedEmail}`);
      if (resolvedEmail) {
        try {
          const { recordAccountFailure } = await import('../services/auth.ts');
          recordAccountFailure(resolvedEmail);
        } catch {
          /* best effort */
        }
      }
      continue;
      } // end non-JSON empty-stream handling
    }

    // Reconstruct stream with ALL probed chunks prepended, then pipe remaining data through.
    // This lets us keep the chunks read during the probe while allowing async consumption.
    stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of probeChunks) controller.enqueue(chunk);
        try {
          while (true) {
            const { done, value } = await streamReader.read();
            if (done) break;
            // Honor backpressure: if the consumer is behind, wait before
            // enqueueing so the client's socket drains instead of receiving
            // a pre-filled queue all at once.
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              await new Promise((r) => setTimeout(r, 1));
            }
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    // Build finalPrompt for logStore debug logging only
    const finalPrompt = sessionMessages
      .map((m: any) => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        return `${m.role}: ${content}`;
      })
      .join('\n\n');
    logStore.updateEntry(logId, (entry) => {
      entry.promptToQwen = {
        systemPromptLength: 0,
        totalLength: finalPrompt.length,
        preview: finalPrompt.length > 1000 ? finalPrompt.substring(0, 1000) + '...' : finalPrompt,
      };
    });

    logStore.log('debug', 'chat', `[Chat] Request routed to ${resolvedEmail} — stream ready (attempt ${attempt + 1})`);

    return {
      sessionMessages,
      session,
      nextParentId,
      sessionHeaders,
      resolvedEmail,
      stream,
      qwenAbortController,
    };
  }

  // All account retries exhausted — throw a clean user-facing error
  throw lastError || new Error('All accounts are rate-limited. Please wait and try again later.');
}

function populateLogEntry(logEntry: any, body: OpenAIRequest, messages: any[]): void {
  const rawContent = messages.length > 0 ? messages[messages.length - 1].content : '';
  const lastMsg = typeof rawContent === 'string' ? rawContent : rawContent !== undefined ? JSON.stringify(rawContent) : '';
  logEntry.clientRequest = {
    messageCount: messages.length,
    roles: messages.map((m) => m.role),
    hasTools: !!body.tools?.length,
    toolNames: body.tools?.map((t: any) => t.function?.name || t.name) || [],
    tool_choice: body.tool_choice ? (typeof body.tool_choice === 'string' ? body.tool_choice : JSON.stringify(body.tool_choice)) : null,
    lastMessage: lastMsg.substring(0, 300),
    messages: messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
  };
}

export async function chatCompletions(c: Context) {
  const logId = crypto.randomUUID();
  const _requestStartTime = Date.now();
  try {
    const parsed = await parseRequestBody(c);
    const { body, isStream, toolCalling, cleanOutput, messages, contextCheck } = parsed;
    logStore.log(
      'debug',
      'chat',
      `[Chat] Request: model=${body.model} stream=${isStream} msgs=${messages.length} tools=${body.tools?.length || 0} msgSizes=[${messages.map((m: any) => `${m.role}:${typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length}`).join(',')}]`,
    );
    logStore.createEntry(logId, body.model, isStream);
    logStore.updateEntry(logId, (entry) => {
      entry.apiType = 'openai';
    });
    const logEntry = logStore.getEntry(logId);
    if (logEntry) populateLogEntry(logEntry, body, messages);

    if (!contextCheck.ok) {
      logStore.updateEntry(logId, (entry) => {
        entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
        entry.finalResponse.finishReason = 'context_window_exceeded';
      });
      logStore.finalizeRequest(logId);
      return c.json(
        {
          error: {
            message: contextCheck.message,
            type: 'invalid_request_error',
            param: 'messages',
            code: 'context_window_exceeded',
          },
        },
        400,
      );
    }

    const { session, nextParentId, sessionHeaders, resolvedEmail, stream, qwenAbortController } = await setupSession(
      messages,
      body,
      contextCheck.availableTokens!,
      toolCalling,
      logId,
      contextCheck.estimatedTotalTokens,
    );

    const completionId = 'chatcmpl-' + crypto.randomUUID();

    if (!isStream) {
      return handleNonStreamingRequest({
        c,
        logId,
        completionId,
        body,
        session,
        stream,
        resolvedEmail,
        initialParentId: nextParentId,
        sessionHeaders,
        toolCalling,
        cleanOutput,
      });
    }

    return await handleStreamingRequest({
      c,
      logId,
      completionId,
      body,
      session,
      stream,
      qwenAbortController,
      resolvedEmail,
      initialParentId: nextParentId,
      sessionHeaders,
      toolCalling,
      cleanOutput,
    });
  } catch (err: any) {
    console.error(`[Chat] <<< Request failed after ${Date.now() - _requestStartTime}ms: ${err?.message || err}`);
    console.error('Error in chatCompletions:', err);
    logStore.addError(logId, err.message || String(err));
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'error';
    });
    logStore.finalizeRequest(logId);

    // Rate limit errors after all accounts exhausted — clean user-facing message
    if (err.upstreamStatus === 429 || /RateLimited|daily usage limit/i.test(err.message || '')) {
      return c.json(
        {
          error: {
            message: 'All accounts have reached their daily usage limit. Please try again later.',
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
          },
        },
        429,
      );
    }

    const status = err.upstreamStatus || 500;
    const cleanMessage = cleanTextOfXmlArtifacts(err.message || String(err)).cleanedText || err.message || 'Internal error';
    return c.json(
      {
        error: {
          message: cleanMessage,
          type: err.type || 'server_error',
          code: err.code || undefined,
        },
      },
      status,
    );
  }
}
