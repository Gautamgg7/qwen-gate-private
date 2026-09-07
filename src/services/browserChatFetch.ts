/**
 * browserChatFetch — Fallback for chat completions when browserless wreq-js
 * gets blocked by Qwen's WAF (FAIL_SYS_USER_VALIDATE / RGV587_ERROR).
 *
 * Tries multiple backends in order of preference:
 *   1. browser_oxide bridge (Rust stealth engine via Go bridge) — fastest,
 *      native BoringSSL TLS, V8 JavaScript, ~15x lighter than Chrome
 *   2. Lightpanda (lightweight Zig browser via CDP) — fast, no profile lock
 *   3. cloakbrowser (stealth Chromium with persistent profile) — fallback
 *
 * The response stream is piped back as a ReadableStream<Uint8Array> so the
 * existing chatStreaming/chatNonStreaming handlers can consume it as SSE.
 */

import { logStore } from './logStore.ts';
import { QWEN_API_BASE } from './qwen.ts';
import { getProfileDir } from './playwright.ts';
import { isBridgeAvailable, bridgeChatFetch, bridgeChatFetchStream } from './browserOxideBridge.ts';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Copy the persistent profile to a temp dir so we can launch a separate
 * browser context without conflicting with the main login profile (which
 * is already locked by the login browser context).
 */
async function makeTempProfileCopy(email: string): Promise<{ tempDir: string; cleanup: () => void }> {
  const profileDir = getProfileDir(email);
  if (!existsSync(profileDir)) {
    throw new Error(`No profile dir for ${email} — cannot use browser fallback`);
  }
  const tempDir = mkdtempSync(join(tmpdir(), `qg-fallback-`));
  try {
    // Copy only the Default subdirectory (Cookies, Local Storage, etc.) —
    // skip SingletonLock which would prevent launch.
    cpSync(join(profileDir, 'Default'), join(tempDir, 'Default'), { recursive: true });
  } catch {
    // If Default doesn't exist, try copying the whole profile (excluding lock files)
    try {
      cpSync(profileDir, tempDir, {
        recursive: true,
        filter: (src) => !src.includes('Singleton') && !src.includes('Lock'),
      });
    } catch (err2: any) {
      rmSync(tempDir, { recursive: true, force: true });
      throw new Error(`Failed to copy profile: ${err2.message}`);
    }
  }
  // Remove any SingletonLock file that may have been copied
  try {
    rmSync(join(tempDir, 'SingletonLock'), { force: true });
    rmSync(join(tempDir, 'SingletonCookie'), { force: true });
    rmSync(join(tempDir, 'SingletonSocket'), { force: true });
  } catch {}
  return {
    tempDir,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

/**
 * Extract cookies from the persistent profile's Cookies SQLite file.
 * Returns an array of Playwright Cookie objects that can be added to a
 * Lightpanda browser context.
 */
async function extractProfileCookies(email: string): Promise<Array<{ name: string; value: string; domain: string; path: string }>> {
  const profileDir = getProfileDir(email);
  const { launchPersistentContext } = await import('cloakbrowser');
  // We use cloakbrowser ONLY to read the cookies (very short-lived) — the
  // chat request itself goes through Lightpanda with these cookies.
  const tempProfile = await makeTempProfileCopy(email);
  try {
    const context = await launchPersistentContext({
      userDataDir: tempProfile.tempDir,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    try {
      const cookies = await context.cookies();
      return cookies.map((c: any) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.chat.qwen.ai',
        path: c.path || '/',
      }));
    } finally {
      try { await context.close(); } catch {}
    }
  } finally {
    tempProfile.cleanup();
  }
}

export interface BrowserFetchResult {
  stream: ReadableStream<Uint8Array>;
  status: number;
  headers: Record<string, string>;
}

/**
 * Make a chat completions request via the best available browser backend.
 *
 * Tries backends in order:
 *   1. browser_oxide bridge (if available — preferred, fastest, stealthy)
 *   2. Lightpanda (if available — fast CDP backend)
 *   3. cloakbrowser (fallback — stealth Chromium with persistent profile)
 */
export async function browserChatFetch(
  email: string,
  url: string,
  payload: any,
  cookieStr: string,
): Promise<BrowserFetchResult> {
  // ── 1. Try browser_oxide bridge (Rust stealth engine via Go bridge) ──
  try {
    if (await isBridgeAvailable()) {
      logStore.log('info', 'browserFallback', `Using browser_oxide bridge for chat fetch (${email})`);
      const bodyStr = JSON.stringify(payload);
      const headers: Record<string, string> = {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'source': 'web',
      };
      const result = await bridgeChatFetch(url, 'POST', headers, bodyStr, cookieStr);
      // Check if response is WAF challenge
      const wafBody = (result.body || '').substring(0, 500);
      if (wafBody.includes('FAIL_SYS_USER_VALIDATE') || wafBody.includes('RGV587_ERROR')) {
        throw new Error(`browser_oxide bridge also hit WAF: ${wafBody.substring(0, 200)}`);
      }
      // Wrap body string as a ReadableStream
      const encoder = new TextEncoder();
      const bytes = encoder.encode(result.body);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      logStore.log('info', 'browserFallback', `browser_oxide bridge returned status=${result.status}, body=${result.body.length} bytes`);
      return {
        stream,
        status: result.status || 200,
        headers: result.headers,
      };
    }
  } catch (err: any) {
    logStore.log('warn', 'browserFallback', `browser_oxide bridge fetch failed: ${err.message} — trying Lightpanda`);
  }

  // ── 2. Try Lightpanda (lightweight Zig browser via CDP) ──
  try {
    return await browserChatFetchViaLightpanda(email, url, payload, cookieStr);
  } catch (err: any) {
    logStore.log('warn', 'browserFallback', `Lightpanda browser fetch failed: ${err.message} — falling back to cloakbrowser`);
  }

  // ── 3. Fallback to cloakbrowser (stealth Chromium with persistent profile) ──
  return await browserChatFetchViaCloakbrowser(email, url, payload, cookieStr);
}

/**
 * Lightpanda-based browser fetch — preferred path.
 * Extracts cookies from the persistent profile and uses them in a fresh
 * Lightpanda context. No profile lock issues.
 */
async function browserChatFetchViaLightpanda(
  email: string,
  url: string,
  payload: any,
  cookieStr: string,
): Promise<BrowserFetchResult> {
  const { getLightpandaBrowser } = await import('./lightpandaBrowser.ts');
  const browser = await getLightpandaBrowser();

  let context: any = null;
  let page: any = null;
  try {
    context = await browser.newContext();

    // Extract cookies from the persistent cloakbrowser profile and add them
    // to the Lightpanda context. This avoids locking the cloakbrowser profile.
    let cookies: Array<{ name: string; value: string; domain: string; path: string }> = [];
    try {
      cookies = await extractProfileCookies(email);
      if (cookies.length > 0) {
        await context.addCookies(cookies);
        logStore.log('debug', 'browserFallback', `[Lightpanda] Added ${cookies.length} cookies from profile`);
      }
    } catch (err: any) {
      logStore.log('warn', 'browserFallback', `[Lightpanda] Cookie extraction failed: ${err.message} — relying on cookie header`);
    }

    // Also inject any cookies from cookieStr via document.cookie on navigate
    page = await context.newPage();

    // Navigate to chat.qwen.ai so AWSC fireyejs.js loads and runs
    await page.goto(QWEN_API_BASE, { waitUntil: 'load', timeout: 30_000 }).catch(() => {});
    // Wait for AWSC to initialize (fireyejs needs a few seconds to bootstrap)
    await page.waitForTimeout(3000);

    // Make the fetch call from inside the browser page context
    const fetchResult = await page.evaluate(
      async (req: { url: string; payload: any; cookie: string }) => {
        try {
          if (req.cookie) {
            const parts = req.cookie.split(';');
            for (const part of parts) {
              try { document.cookie = part.trim(); } catch {}
            }
          }
          // Probe request — just check status/headers
          const response = await fetch(req.url, {
            method: 'POST',
            headers: {
              'accept': 'application/json, text/plain, */*',
              'content-type': 'application/json',
              'source': 'web',
            },
            body: JSON.stringify(req.payload),
            credentials: 'include',
          });
          const status = response.status;
          const headers: Record<string, string> = {};
          response.headers.forEach((v: string, k: string) => {
            headers[k] = v;
          });
          const reader = (response.body as any)?.getReader();
          let firstChunk = '';
          if (reader) {
            const { value } = await reader.read();
            if (value) {
              firstChunk = new TextDecoder().decode(value);
            }
            try { await reader.cancel(); } catch {}
          }
          return { status, headers, firstChunk: firstChunk.slice(0, 500) };
        } catch (err: any) {
          return { error: err?.message || String(err) };
        }
      },
      { url, payload, cookie: cookieStr },
    );

    if ((fetchResult as any).error) {
      throw new Error(`Lightpanda fetch probe failed: ${(fetchResult as any).error}`);
    }

    // If the probe still hit WAF, throw — there's nothing more we can do
    const firstChunk = (fetchResult as any).firstChunk || '';
    if (firstChunk.includes('FAIL_SYS_USER_VALIDATE') || firstChunk.includes('RGV587_ERROR')) {
      throw new Error(`Lightpanda also hit WAF: ${firstChunk.slice(0, 200)}`);
    }

    // Now do the actual streaming request and pipe back via polling
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // Init the stream state in the page
          await page.evaluate(() => {
            (window as any).__qgStreamChunks = [];
            (window as any).__qgStreamDone = false;
            (window as any).__qgStreamError = null;
          });

          // Start the streaming fetch in the background (don't await)
          page.evaluate(
            async (req: { url: string; payload: any; cookie: string }) => {
              try {
                if (req.cookie) {
                  const parts = req.cookie.split(';');
                  for (const part of parts) {
                    try { document.cookie = part.trim(); } catch {}
                  }
                }
                const response = await fetch(req.url, {
                  method: 'POST',
                  headers: {
                    'accept': 'application/json, text/plain, */*',
                    'content-type': 'application/json',
                    'source': 'web',
                  },
                  body: JSON.stringify(req.payload),
                  credentials: 'include',
                });
                const reader = (response.body as any).getReader();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value) {
                    (window as any).__qgStreamChunks.push(Array.from(new Uint8Array(value)));
                  }
                }
                (window as any).__qgStreamDone = true;
              } catch (err: any) {
                (window as any).__qgStreamError = err?.message || String(err);
                (window as any).__qgStreamDone = true;
              }
            },
            { url, payload, cookie: cookieStr },
          ).catch(() => {});

          // Poll for chunks until done
          while (true) {
            const state = await page.evaluate(() => ({
              chunks: (window as any).__qgStreamChunks || [],
              done: (window as any).__qgStreamDone || false,
              error: (window as any).__qgStreamError,
            })).catch(() => ({ chunks: [], done: true, error: 'page closed' }));
            if (state.error) {
              controller.error(new Error(`Stream error: ${state.error}`));
              return;
            }
            for (const chunk of state.chunks) {
              controller.enqueue(new Uint8Array(chunk));
            }
            await page.evaluate(() => {
              (window as any).__qgStreamChunks = [];
            }).catch(() => {});
            if (state.done) {
              controller.close();
              return;
            }
            await new Promise((r) => setTimeout(r, 50));
          }
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return {
      stream,
      status: fetchResult.status || 200,
      headers: (fetchResult as any).headers || {},
    };
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
  }
}

/**
 * cloakbrowser-based browser fetch — fallback when Lightpanda fails.
 * Copies the persistent profile to a temp dir to avoid SingletonLock conflicts.
 */
async function browserChatFetchViaCloakbrowser(
  email: string,
  url: string,
  payload: any,
  cookieStr: string,
): Promise<BrowserFetchResult> {
  let context: any = null;
  let page: any = null;
  let tempProfile: { tempDir: string; cleanup: () => void } | null = null;
  try {
    tempProfile = await makeTempProfileCopy(email);
    const { launchPersistentContext } = await import('cloakbrowser');
    context = await launchPersistentContext({
      userDataDir: tempProfile.tempDir,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    page = await context.newPage();

    await page.goto(QWEN_API_BASE, { waitUntil: 'load', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const fetchResult = await page.evaluate(
      async (req: { url: string; payload: any; cookie: string }) => {
        try {
          if (req.cookie) {
            const parts = req.cookie.split(';');
            for (const part of parts) {
              try { document.cookie = part.trim(); } catch {}
            }
          }
          const response = await fetch(req.url, {
            method: 'POST',
            headers: {
              'accept': 'application/json, text/plain, */*',
              'content-type': 'application/json',
              'source': 'web',
            },
            body: JSON.stringify(req.payload),
            credentials: 'include',
          });
          const status = response.status;
          const headers: Record<string, string> = {};
          response.headers.forEach((v: string, k: string) => { headers[k] = v; });
          const reader = (response.body as any)?.getReader();
          let firstChunk = '';
          if (reader) {
            const { value } = await reader.read();
            if (value) firstChunk = new TextDecoder().decode(value);
            try { await reader.cancel(); } catch {}
          }
          return { status, headers, firstChunk: firstChunk.slice(0, 500) };
        } catch (err: any) {
          return { error: err?.message || String(err) };
        }
      },
      { url, payload, cookie: cookieStr },
    );

    if ((fetchResult as any).error) {
      throw new Error(`Cloakbrowser fetch probe failed: ${(fetchResult as any).error}`);
    }

    const firstChunk = (fetchResult as any).firstChunk || '';
    if (firstChunk.includes('FAIL_SYS_USER_VALIDATE') || firstChunk.includes('RGV587_ERROR')) {
      throw new Error(`Cloakbrowser fallback also hit WAF: ${firstChunk.slice(0, 200)}`);
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await page.evaluate(() => {
            (window as any).__qgStreamChunks = [];
            (window as any).__qgStreamDone = false;
            (window as any).__qgStreamError = null;
          });
          page.evaluate(
            async (req: { url: string; payload: any; cookie: string }) => {
              try {
                if (req.cookie) {
                  const parts = req.cookie.split(';');
                  for (const part of parts) {
                    try { document.cookie = part.trim(); } catch {}
                  }
                }
                const response = await fetch(req.url, {
                  method: 'POST',
                  headers: {
                    'accept': 'application/json, text/plain, */*',
                    'content-type': 'application/json',
                    'source': 'web',
                  },
                  body: JSON.stringify(req.payload),
                  credentials: 'include',
                });
                const reader = (response.body as any).getReader();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value) (window as any).__qgStreamChunks.push(Array.from(new Uint8Array(value)));
                }
                (window as any).__qgStreamDone = true;
              } catch (err: any) {
                (window as any).__qgStreamError = err?.message || String(err);
                (window as any).__qgStreamDone = true;
              }
            },
            { url, payload, cookie: cookieStr },
          ).catch(() => {});
          while (true) {
            const state = await page.evaluate(() => ({
              chunks: (window as any).__qgStreamChunks || [],
              done: (window as any).__qgStreamDone || false,
              error: (window as any).__qgStreamError,
            })).catch(() => ({ chunks: [], done: true, error: 'page closed' }));
            if (state.error) {
              controller.error(new Error(`Stream error: ${state.error}`));
              return;
            }
            for (const chunk of state.chunks) controller.enqueue(new Uint8Array(chunk));
            await page.evaluate(() => { (window as any).__qgStreamChunks = []; }).catch(() => {});
            if (state.done) { controller.close(); return; }
            await new Promise((r) => setTimeout(r, 50));
          }
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return { stream, status: fetchResult.status || 200, headers: (fetchResult as any).headers || {} };
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
    if (tempProfile) tempProfile.cleanup();
  }
}

/**
 * Check if browser fallback is available (profile dir exists for the email).
 */
export function isBrowserFallbackAvailable(email: string): boolean {
  const profileDir = getProfileDir(email);
  return existsSync(profileDir);
}


