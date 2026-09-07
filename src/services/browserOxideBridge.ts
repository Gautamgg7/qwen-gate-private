/**
 * browserOxideBridge — TypeScript client for the Go-based qwen-gate-bridge
 * that wraps the Rust browser_oxide stealth browser engine.
 *
 * Architecture:
 *   ┌─ TypeScript (qwen-gate) ─┐         ┌─ Go bridge ─┐         ┌─ Rust (browser_oxide) ─┐
 *   │  browserOxideBridge.ts   │ ──HTTP──>│ qg-bridge   │ ──CDP──>│ browser_oxide engine  │
 *   └──────────────────────────┘         └─────────────┘         └───────────────────────┘
 *
 * The bridge exposes a simple REST API:
 *   GET  /health        - liveness check
 *   POST /navigate      - navigate to URL, return title/html_size/verdict
 *   POST /evaluate      - run JS in current page
 *   POST /fetch         - stealth HTTP fetch via browser_oxide
 *   POST /chat-fetch    - make chat completions request via browser
 *                        (so fireyejs.js generates bx-ua/bx-pp tokens)
 *
 * The Rust engine (browser_oxide) provides:
 *   - Native BoringSSL TLS fingerprint (JA3/JA4)
 *   - V8 JavaScript runtime (deno_core)
 *   - Real HTML/CSS/DOM/canvas
 *   - CDP-compatible WebSocket server
 *   - Stealth profiles: chrome_148_macos, firefox_135_macos, etc.
 *
 * This is the lightweight replacement for Playwright/cloakbrowser —
 * ~15x less memory than headless Chrome, ~9x faster, and stealth native
 * (no CDP/WebDriver detection vectors).
 */

import { logStore } from './logStore.ts';

const DEFAULT_BRIDGE_URL = process.env.QG_BRIDGE_URL || 'http://127.0.0.1:9223';

let bridgeUrl: string = DEFAULT_BRIDGE_URL;
let healthChecked = false;
let bridgeAvailable = false;

/**
 * Set the bridge URL (called once at startup if needed).
 */
export function setBridgeUrl(url: string): void {
  bridgeUrl = url.replace(/\/+$/, '');
  healthChecked = false;
  bridgeAvailable = false;
}

/**
 * Check if the Go bridge (and underlying browser_oxide) is available.
 * Result is cached after first check.
 */
export async function isBridgeAvailable(): Promise<boolean> {
  if (healthChecked) return bridgeAvailable;
  healthChecked = true;
  try {
    const resp = await fetch(`${bridgeUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data: any = await resp.json();
      bridgeAvailable = !!data.ok;
      if (bridgeAvailable) {
        logStore.log('info', 'browserOxide', `Bridge connected: ${bridgeUrl} (profile: ${data.profile || 'default'})`);
      } else {
        logStore.log('warn', 'browserOxide', `Bridge reported not ok: ${JSON.stringify(data)}`);
      }
    } else {
      bridgeAvailable = false;
      logStore.log('debug', 'browserOxide', `Bridge health check failed: HTTP ${resp.status}`);
    }
  } catch (err: any) {
    bridgeAvailable = false;
    logStore.log('debug', 'browserOxide', `Bridge unavailable: ${err.message}`);
  }
  return bridgeAvailable;
}

/**
 * Refresh the bridge health check.
 */
export async function refreshBridgeCheck(): Promise<boolean> {
  healthChecked = false;
  return await isBridgeAvailable();
}

/**
 * Navigate to a URL via the bridge and return page info.
 */
export async function bridgeNavigate(url: string, profile?: string): Promise<{
  title: string;
  html_size: number;
  verdict: string;
  url: string;
}> {
  if (!(await isBridgeAvailable())) {
    throw new Error('browser_oxide bridge not available');
  }
  const resp = await fetch(`${bridgeUrl}/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, profile }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`bridge navigate failed: HTTP ${resp.status} - ${err.substring(0, 200)}`);
  }
  return await resp.json();
}

/**
 * Evaluate JavaScript in the current page.
 */
export async function bridgeEvaluate(js: string): Promise<{ result: string }> {
  if (!(await isBridgeAvailable())) {
    throw new Error('browser_oxide bridge not available');
  }
  const resp = await fetch(`${bridgeUrl}/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ js }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`bridge evaluate failed: HTTP ${resp.status} - ${err.substring(0, 200)}`);
  }
  return await resp.json();
}

/**
 * Make a chat completions request via the browser_oxide engine.
 * The browser's fireyejs.js generates proper bx-ua/bx-pp tokens that bypass
 * Qwen's WAF — this is the stealth fallback when browserless wreq-js fails.
 *
 * Returns the response body as a string (parsed SSE data) plus status/headers.
 */
export async function bridgeChatFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  cookies: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  if (!(await isBridgeAvailable())) {
    throw new Error('browser_oxide bridge not available');
  }
  const resp = await fetch(`${bridgeUrl}/chat-fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, method, headers, body, cookies }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`bridge chat-fetch failed: HTTP ${resp.status} - ${err.substring(0, 200)}`);
  }
  const data: any = await resp.json();
  return {
    status: data.status,
    headers: data.headers || {},
    body: data.body || '',
  };
}

/**
 * Make a stealth HTTP fetch via the browser_oxide engine.
 * Uses the native BoringSSL TLS fingerprint, no Chromium.
 */
export async function bridgeFetch(
  url: string,
  method: string = 'GET',
  headers: Record<string, string> = {},
  body: string = '',
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  if (!(await isBridgeAvailable())) {
    throw new Error('browser_oxide bridge not available');
  }
  const resp = await fetch(`${bridgeUrl}/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, method, headers, body }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`bridge fetch failed: HTTP ${resp.status} - ${err.substring(0, 200)}`);
  }
  const data: any = await resp.json();
  return {
    status: data.status,
    headers: data.headers || {},
    body: data.body || '',
  };
}

/**
 * Make a chat completions request via browser_oxide, returning a stream.
 *
 * The bridge returns the full body (not streamed), so we wrap it as a
 * ReadableStream for compatibility with the existing chatStreaming handler.
 */
export async function bridgeChatFetchStream(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  cookies: string,
): Promise<ReadableStream<Uint8Array>> {
  const result = await bridgeChatFetch(url, method, headers, body, cookies);
  // Wrap the body string as a stream
  const encoder = new TextEncoder();
  const bytes = encoder.encode(result.body);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
