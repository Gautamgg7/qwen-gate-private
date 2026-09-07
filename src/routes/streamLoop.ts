import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';
import { cleanTextOfXmlArtifacts, parseXmlToolCalls } from '../tools/xmlToolParser.ts';
import { type AmplificationGuardState, checkAmplificationGuard, getSnapshotDelta, parseQwenErrorPayload } from './chatHelpers.ts';
import { filterContentPipeline, processStreamData, type StreamProcessingCtx, type StreamProcessingState } from './chatStreamingHelpers.ts';
import { checkFinalAmplification, scheduleCleanup } from './cleanupHelpers.ts';
import { buildChunkEvent, buildUsage, makeChoice, writeEvent, writeReasoningEvent } from './writeHelpers.ts';
import { calibrateTokenEstimator } from '../utils/tokenEstimator.ts';

/** Shared TextDecoder — stateless, safe to reuse across streams */
export const sharedDecoder = new TextDecoder();

export interface StreamLoopResult {
  buffer: string;
  nextParentId: string | null;
  error?: string;
}

export async function runStreamLoop(
  c: { req: { raw?: { signal?: AbortSignal } } },
  reader: ReadableStreamDefaultReader<Uint8Array>,
  streamState: StreamProcessingState,
  streamCtx: StreamProcessingCtx,
  ampState: AmplificationGuardState,
  bufferRef: { text: string },
): Promise<StreamLoopResult> {
  let streamDone = false;
  let nextParentId = streamState.nextParentId;

  while (true) {
    if (streamDone) break;
    if (c.req.raw?.signal?.aborted) {
      reader.cancel();
      break;
    }

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let readResult: Awaited<ReturnType<typeof reader.read>>;
    let idleTimedOut = false;
    try {
      readResult = await Promise.race([
        reader.read(),
        new Promise<any>((_, reject) => {
          idleTimer = setTimeout(
            () => {
              idleTimedOut = true;
              reject(
                new Error(
                  // 300s default: Qwen max-effort thinking on large agentic
                  // contexts can be silent for several minutes. A 60s default
                  // killed healthy streams mid-task (client saw a clean [DONE]
                  // even though generation was cut off).
                  `Upstream stream idle timeout — no data for ${Math.max(10_000, config.getInt('STREAM_IDLE_TIMEOUT_MS', 300_000)) / 1000}s`,
                ),
              );
            },
            Math.max(10_000, config.getInt('STREAM_IDLE_TIMEOUT_MS', 300_000)),
          );
        }),
      ]);
    } catch (timeoutErr) {
      if (idleTimer) clearTimeout(idleTimer);
      if (!idleTimedOut) await reader.cancel();
      return { buffer: bufferRef.text, nextParentId, error: (timeoutErr as Error).message };
    }
    if (idleTimer) clearTimeout(idleTimer);
    if (readResult.done) break;
    if (readResult.value) ampState.rawInputBytes += readResult.value.length;

    const rawDecoded = sharedDecoder.decode(readResult.value, { stream: true });
    bufferRef.text += rawDecoded;
    const lines = bufferRef.text.split('\n');
    bufferRef.text = lines.pop() || '';

    let sseYieldCounter = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const dataStr = trimmed.slice(6);
      if (dataStr === '[DONE]') {
        streamDone = true;
        break;
      }

      try {
        const chunk = JSON.parse(dataStr);

        const result = await processStreamData(chunk, streamState, streamCtx);
        // Yield to the event loop every 4th SSE event (B6) — gives Bun socket
        // flush points while cutting setTimeout(0) overhead 4x vs per-event.
        // Without any yield, one upstream-batched read with N complete lines
        // writes all N events back-to-back — the client sees "everything at
        // once" instead of a stream.
        sseYieldCounter++;
        if (sseYieldCounter % 4 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
        if (result === 'break_stream') {
          streamDone = true;
          break;
        }
      } catch (e) {
        console.error('[Chat] Streaming: parse error on chunk, ignoring partial:', (e as Error)?.message, 'raw:', dataStr.slice(0, 200));
      }
    }
    nextParentId = streamState.nextParentId;
  }

  return { buffer: bufferRef.text, nextParentId };
}

export async function handlePostStreamCompletion(
  args: {
    streamWriter: any;
    completionId: string;
    model: string;
    streamState: StreamProcessingState;
    ampState: AmplificationGuardState;
    logId: string;
    resolvedEmail: string;
    emittedToolCallCount: number;
    buffer: string;
    enableContentFiltering: boolean;
    includeUsage: boolean;
  },
  cleanup: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    heartbeatInterval: any;
    chatId: string;
    sessionHeaders: any;
    email: string;
    sessionPool: { release: (chatId: string, parentId: string | null, headers: any, email: string) => void };
  },
): Promise<void> {
  const {
    streamWriter,
    completionId,
    model,
    streamState,
    ampState,
    logId,
    resolvedEmail,
    emittedToolCallCount,
    buffer,
    enableContentFiltering,
    includeUsage,
  } = args;
  const { reader, heartbeatInterval, chatId, sessionHeaders, email, sessionPool } = cleanup;
  // Track whether this stream produced a usable result. A poisoned session
  // (empty response / upstream error) must NOT be retained for the next
  // conversation turn — retaining it made every subsequent turn reuse the
  // broken chat and fail with "empty response" forever.
  let releaseOk = true;

  try {
    // ── Flush partial content FIRST ──────────────────────────────────
    // If upstream aborted mid-stream (content filter, rate limit, etc.),
    // the chunks the user already saw must stay visible. Flush the
    // accumulated buffer before surfacing any error, so the client keeps
    // the partial answer instead of rolling back to a bare server error.
    if (streamState.pendingChunk) {
      streamState.lastFullContent += streamState.pendingChunk;
      streamState.pendingChunk = '';
    }

    // Count tool calls from the final assembled content
    const finalToolCalls = streamState.lastFullContent ? parseXmlToolCalls(streamState.lastFullContent).toolCalls.length : 0;
    const effectiveToolCallCount = Math.max(emittedToolCallCount, finalToolCalls);

    // Populate parsedToolCalls from full accumulated content (per-chunk extraction
    // never sees complete blocks since individual SSE deltas are too small).
    if (streamState.lastFullContent && effectiveToolCallCount > emittedToolCallCount) {
      const parsed = parseXmlToolCalls(streamState.lastFullContent).toolCalls;
      // Avoid double-counting: only add tool calls that weren't already emitted
      for (const tc of parsed.slice(emittedToolCallCount)) {
        logStore.updateEntry(logId, (entry) => {
          entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.parameters) });
        });
      }
    }

    const pipelineResult = filterContentPipeline(streamState.lastFullContent, enableContentFiltering);
    const flushCleaned = pipelineResult.cleanText;
    const flushThinking = pipelineResult.thinking;

    if (flushThinking) {
      const thinkDelta = getSnapshotDelta(flushThinking, streamState.lastThinkingSnapshot);
      if (thinkDelta) {
        streamState.lastThinkingSnapshot = flushThinking;
        await writeReasoningEvent(streamWriter, completionId, model, thinkDelta);
      }
    }
    if (flushCleaned) {
      const contentDelta = getSnapshotDelta(flushCleaned, streamState.lastFilteredSnapshot);
      if (contentDelta) {
        streamState.lastFilteredSnapshot = flushCleaned;
        if (
          checkAmplificationGuard(
            ampState,
            contentDelta.length,
            logId,
            resolvedEmail,
            model,
            streamState.lastRawContent,
            streamState.lastVStrRaw,
          )
        ) {
          // guard triggered — skip content emission
        } else {
          const ct = contentDelta.replace(/[\n\s]*$/, '');
          if (ct) {
            logStore.addProcessedOutput(logId, ct);
            ampState.emittedOutputBytes += ct.length;
            // Emit the end-of-stream delta in ≤256-char pieces with a flush
            // yield between each — prevents the whole remaining answer from
            // arriving as one burst right before finish_reason.
            for (let i = 0; i < ct.length; i += 256) {
              await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({ content: ct.slice(i, i + 256) })]));
              await new Promise((r) => setTimeout(r, 0));
            }
          }
        }
      }
    }

    // ── Upstream error: emit it AFTER the partial content ────────────
    const upstreamError =
      parseQwenErrorPayload(buffer) || (streamState.upstreamError ? { message: streamState.upstreamError, status: 502 as const } : null);
      if (upstreamError) {
      const cleanErrorMessage = cleanTextOfXmlArtifacts(upstreamError.message).cleanedText || upstreamError.message;
      // The session may be in an inconsistent state after an upstream error —
      // evict it instead of retaining for the next turn.
      releaseOk = false;
      // D3: Rate-limit walls delivered inside HTTP 200 bodies — mark the
      // account so pickAccount skips it, and record the health failure.
      if (/RateLimited|daily usage limit/i.test(cleanErrorMessage) && resolvedEmail) {
        try {
          const { throttleAccount: throttle, recordAccountFailure: recordFail } = await import('../services/auth.ts');
          throttle(resolvedEmail, 60 * 60 * 1000); // 1 hour cooldown
          recordFail(resolvedEmail);
          logStore.log('warn', 'stream', `[D3] Rate-limit wall detected for ${resolvedEmail} — throttled 1h`);
        } catch {
          /* best effort — the error is still surfaced to the client */
        }
      }
      // Append the error as a final content chunk — the partial answer
      // stays visible, and the user sees why the stream stopped.
      await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({ content: `\n\n[Error] ${cleanErrorMessage}` })]));
      await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({}, 'stop')]));
      await streamWriter.write('data: [DONE]\n\n');
      logStore.updateEntry(logId, (entry) => {
        entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
        entry.finalResponse.finishReason = 'upstream_error';
      });
      logStore.finalizeRequest(logId);
      return;
    }

    // ── Empty-result guard (FIX) ──────────────────────────────────────
    // Qwen occasionally "completes" with an HTTP-200 body that produced no
    // content, no reasoning, and no tool calls (empty body or instant [DONE]).
    // Without this, OpenCode/agents get a fake successful empty turn. Surface
    // it as an error so the client retries instead of silently continuing.
    const emittedAnything =
      (streamState.lastFullContent || '').trim().length > 0 ||
      (streamState.reasoningBuffer || '').trim().length > 0 ||
      effectiveToolCallCount > 0;
    if (!emittedAnything) {
      // Poisoned session: evict (releaseOk=false) so the broken chat is NOT
      // retained for the next conversation turn — retaining it caused every
      // subsequent turn to reuse the dead chat and fail with the same error.
      releaseOk = false;
      const emptyMsg = `Qwen returned an empty response (no content, reasoning, or tool calls) for ${resolvedEmail || '?'}`;
      logStore.log('warn', 'stream', `[Stream] Empty result for ${logId}: ${emptyMsg}`);
      logStore.addError(logId, emptyMsg);
      try {
        await writeEvent(
          streamWriter,
          buildChunkEvent(completionId, model, [makeChoice({ content: `\n\n[Error] ${emptyMsg}` })]),
        );
        await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({}, 'stop')]));
      } catch {
        /* client may be gone */
      }
      await streamWriter.write('data: [DONE]\n\n');
      logStore.updateEntry(logId, (entry) => {
        entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
        entry.finalResponse.finishReason = 'empty_response';
      });
      logStore.finalizeRequest(logId);
      return;
    }

    const usage = buildUsage(streamState.promptTokens, streamState.completionTokens, streamState.reasoningBuffer);

    // Self-calibrate the token estimator (C1): compare our pre-request estimate
    // against Qwen's real reported usage. Converges over ~50 samples.
    if (streamState.initialPromptTokenEstimate && streamState.promptTokens) {
      calibrateTokenEstimator(streamState.initialPromptTokenEstimate, streamState.promptTokens);
    }

    const finalFinishReason = effectiveToolCallCount > 0 ? 'tool_calls' : 'stop';

    await writeEvent(
      streamWriter,
      buildChunkEvent(completionId, model, [makeChoice({}, finalFinishReason)], includeUsage ? undefined : { usage }),
    );

    if (includeUsage) {
      await writeEvent(streamWriter, buildChunkEvent(completionId, model, [], { usage }));
    }
    await streamWriter.write('data: [DONE]\n\n');

    checkFinalAmplification(ampState, logId, resolvedEmail, logStore);

    logStore.updateEntry(logId, (entry) => {
      const now = Date.now();
      const startedAt = new Date(entry.timestamp).getTime();
      if (startedAt) entry.latency_ms = now - startedAt;
      if (streamState.lastFullContent) entry.remainingText = streamState.lastFullContent;
      if (streamState.reasoningBuffer) entry.reasoningContent = streamState.reasoningBuffer;
      entry.finalResponse = {
        finishReason: finalFinishReason || 'stop',
        toolCallCount: effectiveToolCallCount,
        contentPreview: (streamState.lastFullContent || '').substring(0, 100),
      };
    });

    logStore.finalizeRequest(logId);
  } catch (err) {
    console.error('[Chat] handlePostStreamCompletion error:', err);
    logStore.addError(logId, err instanceof Error ? err.message : String(err));
    // Preserve data that was set before flush (content, reasoning, etc.)
    logStore.updateEntry(logId, (entry) => {
      if (streamState.lastFullContent) entry.remainingText = streamState.lastFullContent;
      if (streamState.reasoningBuffer) entry.reasoningContent = streamState.reasoningBuffer;
      entry.finalResponse = entry.finalResponse || { finishReason: 'error', toolCallCount: 0, contentPreview: '' };
    });
    logStore.finalizeRequest(logId);
    // Always write [DONE] so the SSE stream terminates cleanly, even on error
    try {
      await streamWriter.write('data: [DONE]\n\n');
    } catch {
      /* stream may already be closed */
    }
  } finally {
    // Always release session to prevent pool exhaustion, even if writeEvent fails.
    // releaseOk=false evicts the poisoned session (no retention, no warm return,
    // deleteSession on Qwen's side, recordAccountFailure on the account).
    scheduleCleanup(reader, heartbeatInterval, chatId, streamState.nextParentId, sessionHeaders, email, sessionPool, releaseOk);
  }
}
