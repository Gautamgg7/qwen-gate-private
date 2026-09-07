/**
 * lightpandaBrowser — Lightpanda browser integration for Qwen Gate.
 *
 * Lightpanda is a lightweight headless browser (Zig-based, ~170MB binary)
 * that speaks CDP (Chrome DevTools Protocol). We connect via Playwright's
 * `chromium.connectOverCDP()` to use the existing Playwright API against
 * the Lightpanda backend.
 *
 * Benefits over cloakbrowser/Chromium:
 *   - ~16x less memory (123MB vs 2GB for 100 pages)
 *   - ~9x faster (5s vs 46s for 100 pages)
 *   - No profile lock issues (stateless CDP sessions)
 *   - Better suited for headless API automation
 *
 * Usage:
 *   import { getLightpandaBrowser, getLightpandaContext } from './lightpandaBrowser.ts';
 *   const browser = await getLightpandaBrowser();
 *   const context = await browser.newBrowserContext();
 *   const page = await context.newPage();
 *   await page.goto('https://chat.qwen.ai');
 *   // ... use as normal Playwright page
 *   await context.close();
 *
 * The Lightpanda server is started automatically if not already running
 * (binary must be installed at /home/z/my-project/bin/lightpanda or
 * specified via LIGHTPANDA_BINARY env var).
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { logStore } from './logStore.ts';

let lightpandaProcess: any = null;
let lightpandaPort: number = 9222;
let lightpandaBrowser: any = null;
let startupPromise: Promise<any> | null = null;

const DEFAULT_BINARY_PATH = '/home/z/my-project/bin/lightpanda';

/**
 * Find the lightpanda binary. Checks env var first, then default install path.
 */
function findBinary(): string | null {
  const envPath = process.env.LIGHTPANDA_BINARY;
  if (envPath && existsSync(envPath)) return envPath;
  if (existsSync(DEFAULT_BINARY_PATH)) return DEFAULT_BINARY_PATH;
  // Try common system install paths
  for (const p of ['/usr/local/bin/lightpanda', '/usr/bin/lightpanda']) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Start the Lightpanda CDP server (idempotent — only starts once).
 * Returns the WebSocket URL for Playwright to connect via connectOverCDP.
 */
async function startLightpandaServer(): Promise<string> {
  if (lightpandaBrowser) {
    try {
      // Test if still alive
      await lightpandaBrowser.version();
      return lightpandaBrowser.wsEndpoint();
    } catch {
      lightpandaBrowser = null;
    }
  }

  if (startupPromise) return startupPromise;
  startupPromise = (async () => {
    const binaryPath = findBinary();
    if (!binaryPath) {
      throw new Error(
        'Lightpanda binary not found. Install with: ' +
          'curl -L -o /home/z/my-project/bin/lightpanda ' +
          'https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-linux ' +
          '&& chmod a+x /home/z/my-project/bin/lightpanda',
      );
    }

    lightpandaPort = parseInt(process.env.LIGHTPANDA_PORT || '9222', 10);

    logStore.log('info', 'lightpanda', `Starting Lightpanda CDP server on port ${lightpandaPort}...`);

    // Spawn Lightpanda server
    lightpandaProcess = spawn(binaryPath, [
      'serve',
      '--host', '127.0.0.1',
      '--port', String(lightpandaPort),
      '--log-level', process.env.LIGHTPANDA_LOG_LEVEL || 'warning',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: 'true' },
    });

    lightpandaProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logStore.log('debug', 'lightpanda', `[lightpanda] ${msg.substring(0, 200)}`);
    });

    lightpandaProcess.on('error', (err: Error) => {
      logStore.log('error', 'lightpanda', `Lightpanda process error: ${err.message}`);
      lightpandaProcess = null;
      lightpandaBrowser = null;
      startupPromise = null;
    });

    lightpandaProcess.on('exit', (code: number | null) => {
      logStore.log('warn', 'lightpanda', `Lightpanda server exited (code=${code})`);
      lightpandaProcess = null;
      lightpandaBrowser = null;
      startupPromise = null;
    });

    // Wait for the CDP server to be ready (up to 10s)
    const wsUrl = `ws://127.0.0.1:${lightpandaPort}`;
    for (let i = 0; i < 20; i++) {
      try {
        const resp = await fetch(`http://127.0.0.1:${lightpandaPort}/json/version`);
        if (resp.ok) {
          const data: any = await resp.json();
          logStore.log('info', 'lightpanda', `Lightpanda CDP ready: version=${data['Lightpanda-Version'] || '?'}`);
          return data.webSocketDebuggerUrl || wsUrl;
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Lightpanda server failed to start within 10s`);
  })();
  return startupPromise;
}

/**
 * Get a Playwright browser instance connected to the Lightpanda CDP server.
 * The browser is cached and reused across calls. Don't call `browser.close()`
 * — use `releaseContext()` to release individual contexts/pages instead.
 */
export async function getLightpandaBrowser(): Promise<any> {
  if (lightpandaBrowser && !lightpandaBrowser._closed) {
    try {
      await lightpandaBrowser.version();
      return lightpandaBrowser;
    } catch {
      lightpandaBrowser = null;
    }
  }
  const wsUrl = await startLightpandaServer();
  const { chromium } = await import('playwright');
  lightpandaBrowser = await chromium.connectOverCDP(wsUrl);
  logStore.log('info', 'lightpanda', 'Connected to Lightpanda via Playwright CDP');
  return lightpandaBrowser;
}

/**
 * Create a fresh browser context on Lightpanda. Caller is responsible for
 * calling `context.close()` when done to free resources.
 */
export async function getLightpandaContext(): Promise<any> {
  const browser = await getLightpandaBrowser();
  return await browser.newContext();
}

/**
 * Create a fresh page on Lightpanda (convenience method —
 * creates its own context, closes it when the page closes).
 */
export async function getLightpandaPage(): Promise<any> {
  const context = await getLightpandaContext();
  const page = await context.newPage();
  // Auto-close context when page closes
  page._lightpandaContext = context;
  const originalClose = page.close.bind(page);
  page.close = async (...args: any[]) => {
    try {
      await originalClose(...args);
    } finally {
      try { await context.close(); } catch {}
    }
  };
  return page;
}

/**
 * Check if Lightpanda is available (binary installed and server can start).
 */
export async function isLightpandaAvailable(): Promise<boolean> {
  const binaryPath = findBinary();
  if (!binaryPath) return false;
  try {
    await getLightpandaBrowser();
    return true;
  } catch {
    return false;
  }
}

/**
 * Shutdown the Lightpanda server and disconnect Playwright.
 * Call on app shutdown.
 */
export async function disposeLightpanda(): Promise<void> {
  if (lightpandaBrowser) {
    try { await lightpandaBrowser.close(); } catch {}
    lightpandaBrowser = null;
  }
  if (lightpandaProcess) {
    try { lightpandaProcess.kill(); } catch {}
    lightpandaProcess = null;
  }
  startupPromise = null;
}
