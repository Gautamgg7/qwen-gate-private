/**
 * browserChatFetch — Fallback for chat completions when browserless wreq-js
 * gets blocked by Qwen's WAF (FAIL_SYS_USER_VALIDATE / RGV587_ERROR).
 *
 * Uses the cloakbrowser profile (already authenticated with real cookies
 * and AWSC fireyejs.js loaded) to make the chat completions request directly
 * from a real browser context. The fireyejs.js generates the proper bx-ua
 * and bx-pp tokens for each request, bypassing the WAF.
 *
 * The response stream is piped back as a ReadableStream<Uint8Array> so the
 * existing chatStreaming/chatNonStreaming handlers can consume it as SSE.
 */

import { logStore } from './logStore.ts';
import { QWEN_API_BASE } from './qwen.ts';
import { getProfileDir } from './playwright.ts';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fallbackBrowser: any = null;

async function getBrowser(): Promise<any> {
  if (fallbackBrowser && !(fallbackBrowser as any)._closed) {
    return fallbackBrowser;
  }
  const { launch: cloakLaunch } = await import('cloakbrowser');
  fallbackBrowser = await cloakLaunch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  return fallbackBrowser;
}

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
  } catch (err: any) {
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

export interface BrowserFetchResult {
  stream: ReadableStream<Uint8Array>;
  status: number;
  headers: Record<string, string>;
}

/**
 * Make a chat completions request via the browser.
 * The browser has the real AWSC fireyejs.js loaded, which generates proper
 * bx-ua and bx-pp tokens per-request that pass Qwen's WAF.
 *
 * Returns a ReadableStream of SSE bytes plus status/headers.
 */
export async function browserChatFetch(
  email: string,
  url: string,
  payload: any,
  cookieStr: string,
): Promise<BrowserFetchResult> {
  let context: any = null;
  let page: any = null;
  let tempProfile: { tempDir: string; cleanup: () => void } | null = null;
  try {
    // Copy the profile to a temp dir so we can launch a fresh browser context
    // without conflicting with the main login profile (which is locked).
    tempProfile = await makeTempProfileCopy(email);
    const { launchPersistentContext } = await import('cloakbrowser');
    context = await launchPersistentContext({
      userDataDir: tempProfile.tempDir,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    page = await context.newPage();

    // Navigate to chat.qwen.ai so AWSC fireyejs.js loads and runs
    await page.goto(QWEN_API_BASE, { waitUntil: 'load', timeout: 30_000 }).catch(() => {});
    // Wait for AWSC to initialize (fireyejs needs a few seconds to bootstrap)
    await page.waitForTimeout(3000);

    // Make the fetch call from inside the browser page context. The browser
    // will automatically include the AWSC-generated bx-ua, bx-pp headers via
    // the fireyejs.js XHR/fetch interceptor.
    const fetchResult = await page.evaluate(
      async (req: { url: string; payload: any; cookie: string }) => {
        try {
          if (req.cookie) {
            // Set cookie via document.cookie (some browsers respect this)
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
          // Check first 200 bytes to see if it's WAF or SSE
          const reader = (response.body as any)?.getReader();
          let firstChunk = '';
          if (reader) {
            const { value } = await reader.read();
            if (value) {
              firstChunk = new TextDecoder().decode(value);
            }
            // Cancel the reader — we'll redo the request below for streaming
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
      throw new Error(`Browser fetch probe failed: ${(fetchResult as any).error}`);
    }

    // If the probe still hit WAF, throw — there's nothing more we can do
    const firstChunk = (fetchResult as any).firstChunk || '';
    if (firstChunk.includes('FAIL_SYS_USER_VALIDATE') || firstChunk.includes('RGV587_ERROR')) {
      throw new Error(`Browser fallback also hit WAF: ${firstChunk.slice(0, 200)}`);
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
          ).catch(() => {
            // Page may close before this resolves — that's fine
          });

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
            // Clear the queue
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
    try {
      if (page) await page.close();
    } catch {}
    try {
      if (context) await context.close();
    } catch {}
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

