/**
 * browserlessFetch — wreq-js worker wrapper for browserless TLS/HTTP2 impersonation.
 *
 * Uses a Node.js sidecar worker running wreq-js (Rust + BoringSSL) with
 * Chrome 142 fingerprint to bypass Alibaba WAF.
 *
 * Manages:
 *   - TLS/HTTP2 impersonation (Chrome 142 via wreq worker)
 *   - bx-umidtoken auto-extraction + caching
 *   - bx-v / bx-et static headers
 *   - WAF detection + recovery via Playwright cookie refresh
 */

import { logCrash, logEvent, logFetchCall } from '../utils/wreqCrashLogger.ts';
import { extractBxUmidtoken } from './bxTokenExtractor.ts';
import { generateBxPp, generateBxUa, refreshCookiesViaBrowser, resetBxUaCache } from './fireyejsRunner.ts';
import { logStore } from './logStore.ts';
import { QWEN_API_BASE } from './qwen.ts';
import { tokenCache } from './tokenCache.ts';
import { disposeWreqWorker, wreqFetch } from './wreqFetch.ts';

// wreq-js (BoringSSL) is the only transport — bypasses library-level WAF
// detection that impers (libcurl/OpenSSL) couldn't.

// Single-flight guard: one cookie refresh per account at a time
const cookieRefreshInFlight = new Map<string, Promise<string | null>>();
const BX_UMIDTOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const BX_UA_TTL_MS = 15 * 60 * 1000;

export interface BrowserlessFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  accountEmail?: string;
  signal?: AbortSignal;
  /** Keep the session alive for streaming. Default false — session is closed after response. */
  stream?: boolean;
}

/** Ensure bx-umidtoken is in headers, fetching from cache or sg-wum endpoint. */
async function ensureBxUmidtoken(headers: Record<string, string>): Promise<void> {
  if (headers['bx-umidtoken']) return;
  const token = await tokenCache.getOrSet('bx-umidtoken', extractBxUmidtoken, BX_UMIDTOKEN_TTL_MS);
  headers['bx-umidtoken'] = token;
}

// ─── acw_tc cookie (Alibaba WAF) ────────────────────────────────────────────

let acwTcRefreshTimer: ReturnType<typeof setInterval> | null = null;
const ACW_TC_REFRESH_MS = 15 * 60 * 1000; // 15 minutes

/** Fetch acw_tc cookie from the Qwen root page via wreq worker. */
async function refreshAcwTcCookie(): Promise<string | null> {
  try {
    logEvent('refreshAcwTcCookie', 'fetching acw_tc from root');
    const resp = await wreqFetch(QWEN_API_BASE, {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml' },
      debugLogDir: process.env.DEBUG_IMPERS_DIR,
    });
    logFetchCall('refreshAcwTcCookie', QWEN_API_BASE, 'GET', resp.status);
    let acwTc: string | null = null;
    const setCookie = resp.headers.get('set-cookie');
    if (setCookie && setCookie.includes('acw_tc=')) {
      const match = setCookie.match(/acw_tc=([^;]+)/);
      if (match) acwTc = match[1];
    }
    if (acwTc) {
      tokenCache.set('acw_tc', acwTc, ACW_TC_REFRESH_MS * 2);
      logStore.log('debug', 'browserless', `acw_tc cookie refreshed: ${acwTc.substring(0, 16)}...`);
      logEvent('refreshAcwTcCookie', 'acw_tc obtained', { acwTc: acwTc.substring(0, 16) });
    } else {
      logEvent('refreshAcwTcCookie', 'no acw_tc in response');
    }
    return acwTc;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStore.log('warn', 'browserless', `acw_tc refresh failed: ${msg}`);
    logCrash('refreshAcwTcCookie', err);
    return null;
  }
}

/** Start periodic acw_tc refresh (idempotent). */
function startAcwTcRefresh(): void {
  if (acwTcRefreshTimer) return;
  setTimeout(() => {
    refreshAcwTcCookie().catch(() => {});
  }, 1000);
  acwTcRefreshTimer = setInterval(() => {
    refreshAcwTcCookie().catch(() => {});
  }, ACW_TC_REFRESH_MS);
}

/** Inject acw_tc cookie into headers from cache. */
async function ensureAcwTcCookie(headers: Record<string, string>): Promise<void> {
  startAcwTcRefresh();

  let acwTc = tokenCache.get('acw_tc') ?? null;
  if (!acwTc) {
    acwTc = await refreshAcwTcCookie();
  }
  if (acwTc) {
    const existing = headers['cookie'] || '';
    if (!existing.includes('acw_tc=')) {
      headers['cookie'] = existing ? `${existing}; acw_tc=${acwTc}` : `acw_tc=${acwTc}`;
    }
  }
}

// ─── WAF check ──────────────────────────────────────────────────────────────

const wafCheck = (r: Response): boolean => {
  if (r.status === 302) return true;
  if (r.status === 403) return true;
  if (r.status === 200) {
    try {
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('text/html')) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
};

// ─── WAF-in-body detection ──────────────────────────────────────────────────
// baxia sometimes bounces with HTTP 200 + application/json body
// {"ret":["FAIL_SYS_USER_VALIDATE",...]} instead of 302/403/HTML. wafCheck()
// misses those, the "successful" response carries zero data frames, and the
// client sees an empty stream. This sniffs the body for the WAF signature.
const WAF_BODY_RE = /FAIL_SYS_USER_VALIDATE|aliyun_waf|RGV587_ERROR|_____tmd_____|x5secdata/i;

interface WafBodyResult {
  waf: boolean;
  response: Response;
}

async function sniffResponseForWaf(response: Response, isStream: boolean): Promise<WafBodyResult> {
  if (response.status !== 200) return { waf: false, response };
  const ct = (response.headers.get('content-type') || '').toLowerCase();
  // Real SSE streams: don't touch (downstream empty-probe handles those).
  if (ct.includes('text/event-stream')) return { waf: false, response };
  // JSON / plain-text body: buffer, sniff, rebuild so the body stays readable.
  const text = await response.text().catch(() => '');
  const waf = WAF_BODY_RE.test(text);
  const cleanHeaders = new Headers(response.headers);
  cleanHeaders.delete('content-length');
  cleanHeaders.delete('content-encoding');
  const rebuilt = new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: cleanHeaders,
  });
  if (isStream) {
    (rebuilt as any)._wreqClose = () => {
      /* worker session is per-request — nothing to close */
    };
  }
  return { waf, response: rebuilt };
}

/**
 * Make a browserless HTTP request to Qwen API.
 *
 * Returns a standard Web API Response object.
 * Use `response.body.getReader()` for SSE streaming.
 */
export async function browserlessFetch(url: string, options: BrowserlessFetchOptions = {}): Promise<Response> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const { method = 'GET', headers = {}, body } = options;
    return globalThis.fetch(url, { method, headers, body });
  }

  const { method = 'GET', headers = {}, body, accountEmail, signal, stream } = options;

  // Auto-inject bx tokens
  await ensureBxUmidtoken(headers);

  if (!headers['bx-v']) headers['bx-v'] = '2.5.36';
  if (!headers['bx-et']) headers['bx-et'] = 'nosgn';

  if (!headers['bx-ua']) {
    const cached = tokenCache.get('bx-ua');
    if (cached) {
      headers['bx-ua'] = cached;
    } else {
      try {
        const generated = await generateBxUa();
        if (generated) headers['bx-ua'] = generated;
      } catch {
        /* fallback */
      }
    }
    if (!headers['bx-ua']) {
      headers['bx-ua'] = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
    }
  }

  if (!headers['bx-pp']) {
    try {
      const pp = await generateBxPp(body);
      if (pp) headers['bx-pp'] = pp;
    } catch {
      /* optional */
    }
  }

  await ensureAcwTcCookie(headers);

  const startTime = Date.now();

  // ─── Initial request via wreq worker ─────────────────────────────────
  try {
    logFetchCall('browserlessFetch', url, method);
    let response = await wreqFetch(url, {
      method,
      headers,
      body,
      signal,
      stream: !!stream,
      debugLogDir: process.env.DEBUG_IMPERS_DIR,
    });
    logFetchCall('browserlessFetch', url, method, response.status);

    // ─── WAF detection + recovery ─────────────────────────────────────
    if (wafCheck(response)) {
      logEvent('browserlessFetch', 'WAF detected', { url: url.split('?')[0], status: response.status });
      logStore.log('warn', 'browserless', `WAF detected on ${url.split('?')[0]} — trying HTTP refresh first...`);
      const currentCookie = headers['cookie'] || '';

      const freshAcwTc = await refreshAcwTcCookie();
      if (freshAcwTc && !currentCookie.includes('acw_tc=')) {
        headers['cookie'] = currentCookie ? `${currentCookie}; acw_tc=${freshAcwTc}` : `acw_tc=${freshAcwTc}`;
      }

      const responseText = await response.text().catch(() => '');
      const isStillWaf = !responseText || responseText.includes('aliyun_waf') || responseText.includes('<html');
      if (!isStillWaf) {
        // The acw_tc refresh worked — response body is valid
        return response;
      }

      logStore.log('warn', 'browserless', `HTTP refresh failed — trying Playwright browser...`);
      const key = accountEmail || '_default_';
      let promise = cookieRefreshInFlight.get(key);
      if (!promise) {
        promise = refreshCookiesViaBrowser(currentCookie).finally(() => {
          cookieRefreshInFlight.delete(key);
        });
        cookieRefreshInFlight.set(key, promise);
      }
      const freshCookies = await promise;
      if (freshCookies) {
        headers['cookie'] = freshCookies;
        tokenCache.delete('bx-ua');
        tokenCache.delete('bx-pp');
        tokenCache.delete('acw_tc');
        await ensureBxUmidtoken(headers);
        headers['bx-ua'] = (await generateBxUa()) || headers['bx-ua'];
        const pp = await generateBxPp(body);
        if (pp) headers['bx-pp'] = pp;
        logStore.log('info', 'browserless', `Retrying ${url.split('?')[0]} with fresh cookies...`);

        logEvent('browserlessFetch', 'WAF retry', { url: url.split('?')[0] });
        logFetchCall('browserlessFetch.retry', url, method);
        response = await wreqFetch(url, {
          method,
          headers,
          body,
          signal,
          stream: !!stream,
          debugLogDir: process.env.DEBUG_IMPERS_DIR,
        });
        logFetchCall('browserlessFetch.retry', url, method, response.status);
        if (wafCheck(response)) {
          tokenCache.delete('bx-ua');
          tokenCache.delete('bx-pp');
          resetBxUaCache();
          throw new Error(`403 WAF challenge persists after cookie refresh for ${url.split('?')[0]} — bx tokens invalidated for retry`);
        }
      }
      if (!freshCookies) {
        throw new Error(`Cookie refresh failed for ${url.split('?')[0]} — cannot retry`);
      }
    }

    const elapsed = Date.now() - startTime;
    logStore.log('debug', 'browserless', `${method} ${url.split('?')[0]} → ${response.status} (${elapsed}ms)`);

    // ─── WAF-in-body sniffing for STREAMING requests ─────────────────
    // For stream: true, the response content-type is normally text/event-stream
    // — but if Qwen bounces the request as a WAF challenge, the content-type
    // is application/json and the body contains:
    //   {"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::..."],"data":{"url":"..."}}
    // Without sniffing, this passes through and the client sees an empty stream
    // (no data frames). Sniff the body when content-type is JSON (not SSE),
    // detect WAF, and try a browser-based cookie refresh + fresh bx tokens retry.
    if (stream) {
      const ct = (response.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('application/json') || ct.includes('text/plain') || ct.includes('text/html')) {
        const sniffed = await sniffResponseForWaf(response, true);
        if (sniffed.waf) {
          logStore.log('warn', 'browserless', `WAF-in-body detected on streaming ${url.split('?')[0]} — trying browser cookie refresh before retry`);
          // Try browser-based cookie refresh (same as wafCheck() path)
          const currentCookie = headers['cookie'] || '';
          const key = accountEmail || '_default_';
          let promise = cookieRefreshInFlight.get(key);
          if (!promise) {
            promise = refreshCookiesViaBrowser(currentCookie).finally(() => {
              cookieRefreshInFlight.delete(key);
            });
            cookieRefreshInFlight.set(key, promise);
          }
          const freshCookies = await promise;
          if (freshCookies) {
            headers['cookie'] = freshCookies;
            tokenCache.delete('bx-ua');
            tokenCache.delete('bx-pp');
            tokenCache.delete('acw_tc');
            resetBxUaCache();
            await ensureBxUmidtoken(headers);
            headers['bx-ua'] = (await generateBxUa()) || headers['bx-ua'];
            const pp = await generateBxPp(body);
            if (pp) headers['bx-pp'] = pp;
            logStore.log('info', 'browserless', `Retrying streaming ${url.split('?')[0]} with fresh browser cookies...`);
            try {
              response = await wreqFetch(url, {
                method,
                headers,
                body,
                signal,
                stream: !!stream,
                debugLogDir: process.env.DEBUG_IMPERS_DIR,
              });
              // Re-check the retry response for WAF
              const retryCt = (response.headers.get('content-type') || '').toLowerCase();
              if (!retryCt.includes('text/event-stream')) {
                const retrySniffed = await sniffResponseForWaf(response, true);
                if (retrySniffed.waf) {
                  logStore.log('warn', 'browserless', `WAF-in-body persists on streaming retry of ${url.split('?')[0]} — invalidating bx tokens for outer retry`);
                  tokenCache.delete('bx-ua');
                  tokenCache.delete('bx-pp');
                  tokenCache.delete('acw_tc');
                  resetBxUaCache();
                  throw new Error(`403 WAF challenge in streaming response body (FAIL_SYS_USER_VALIDATE) for ${url.split('?')[0]} — retry with fresh tokens`);
                }
                // Return the rebuilt response (with text body if non-SSE)
                return retrySniffed.response;
              }
              // For text/event-stream: stash noop close
              (response as any)._wreqClose = () => {};
              return response;
            } catch (retryErr) {
              // Retry failed — invalidate tokens and re-throw so outer retry loop catches it
              tokenCache.delete('bx-ua');
              tokenCache.delete('bx-pp');
              tokenCache.delete('acw_tc');
              resetBxUaCache();
              throw retryErr;
            }
          }
          // Browser refresh failed — invalidate tokens and throw
          tokenCache.delete('bx-ua');
          tokenCache.delete('bx-pp');
          tokenCache.delete('acw_tc');
          resetBxUaCache();
          throw new Error(`403 WAF challenge in streaming response body (FAIL_SYS_USER_VALIDATE) for ${url.split('?')[0]} — browser refresh failed`);
        }
        // Even if not WAF, if response is JSON (not SSE) for a streaming request,
        // it's likely an error envelope — surface it as a normal error so the
        // client sees the error message instead of an empty stream.
        const bodyText = await sniffed.response.text().catch(() => '');
        if (bodyText && !bodyText.startsWith('data:')) {
          logStore.log('warn', 'browserless', `Non-SSE response on streaming request to ${url.split('?')[0]} — content-type=${ct}, bodyLen=${bodyText.length}`);
          // Rebuild as a normal text response so the chat handler can see it
          const rebuilt = new Response(bodyText, {
            status: response.status,
            statusText: response.statusText,
            headers: { 'content-type': ct || 'application/json' },
          });
          (rebuilt as any)._wreqClose = () => {};
          return rebuilt;
        }
        // If it WAS SSE data, return the rebuilt response
        return sniffed.response;
      }
      // For text/event-stream: stash noop close function so qwen.ts doesn't break
      (response as any)._wreqClose = () => {
        // Worker creates fresh session per request — nothing to close.
      };
      return response;
    }

    // ─── WAF-in-body sniffing (non-stream) ────────────────────────────
    // baxia sometimes bounces with HTTP 200 + application/json body
    // {"ret":["FAIL_SYS_USER_VALIDATE",...]} — wafCheck() above can't see
    // it. Sniff the buffered body and fail loudly so callers retry with
    // freshly generated bx tokens instead of parsing a WAF page as data.
    const sniffed = await sniffResponseForWaf(response, false);
    if (sniffed.waf) {
      logStore.log('warn', 'browserless', `WAF-in-body detected on ${url.split('?')[0]} — invalidating bx tokens for fresh retry`);
      tokenCache.delete('bx-ua');
      tokenCache.delete('bx-pp');
      resetBxUaCache();
      throw new Error(`403 WAF challenge in response body (FAIL_SYS_USER_VALIDATE) for ${url.split('?')[0]} — retry with fresh tokens`);
    }

    return sniffed.response;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const msg = err instanceof Error ? err.message : String(err);

    // Classify crash type for easier analysis
    const errStr = msg.toLowerCase();
    if (errStr.includes('waf') || errStr.includes('aliyun_waf') || errStr.includes('403') || errStr.includes('302')) {
      logEvent('browserlessFetch', 'WAF error', { url: url.split('?')[0], method, error: msg.substring(0, 200), elapsed_ms: elapsed });
    } else {
      logCrash('browserlessFetch', err, { url: url.split('?')[0], method, elapsed_ms: elapsed });
    }

    logStore.log('warn', 'browserless', `${method} ${url.split('?')[0]} failed after ${elapsed}ms: ${msg}`);

    if (msg.includes('403') || msg.includes('FAIL_SYS_USER_VALIDATE')) {
      tokenCache.delete('bx-umidtoken');
    }

    throw err;
  }
}

/** Dispose the wreq worker process. Call on app shutdown. */
export async function disposeSession(_accountEmail?: string): Promise<void> {
  await disposeWreqWorker();
}
