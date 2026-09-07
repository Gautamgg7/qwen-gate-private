/**
 * browserOxidePython — Python bindings for the browser_oxide Rust stealth
 * browser engine.
 *
 * browser_oxide ships Python bindings via PyO3/maturin. We invoke them
 * via a Python subprocess to keep the TypeScript side simple — no FFI,
 * no Go bridge, just `python3 -c "..."`.
 *
 * The Python bindings provide:
 *   from browser_oxide import Browser, Profile, Verdict
 *   with Browser(profile=Profile.chrome()) as b:
 *       page = b.navigate("https://example.com")
 *       page.title, page.html, page.verdict, page.evaluate(js)
 *
 * Architecture:
 *   TypeScript (qwen-gate) ──subprocess──> Python ──PyO3──> Rust (browser_oxide)
 *
 * The Rust engine provides:
 *   - Native BoringSSL TLS fingerprint (JA3/JA4)
 *   - V8 JavaScript runtime (deno_core)
 *   - Real HTML/CSS/DOM/canvas
 *   - Stealth profiles: chrome_148_macos, firefox_135_macos, etc.
 *
 * Installation:
 *   1. Build browser_oxide from source (cargo build --release -p browser_oxide)
 *   2. Install Python bindings: cd crates/browser_oxide_py && maturin develop --release
 *   3. Verify: python3 -c "from browser_oxide import Browser; print('ok')"
 *
 * Or use the prebuilt wheel: pip install browser-oxide (when published)
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { logStore } from './logStore.ts';

let browserOxideAvailable: boolean | null = null;

/**
 * Check if browser_oxide Python bindings are available.
 * Cached after first check.
 */
export async function isBrowserOxideAvailable(): Promise<boolean> {
  if (browserOxideAvailable !== null) return browserOxideAvailable;
  browserOxideAvailable = await checkPythonBindings();
  if (browserOxideAvailable) {
    logStore.log('info', 'browserOxide', 'browser_oxide Python bindings available');
  } else {
    logStore.log('debug', 'browserOxide', 'browser_oxide Python bindings not available');
  }
  return browserOxideAvailable;
}

/**
 * Refresh the availability check (e.g. after install).
 */
export async function refreshBrowserOxideCheck(): Promise<boolean> {
  browserOxideAvailable = null;
  return await isBrowserOxideAvailable();
}

async function checkPythonBindings(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('python3', ['-c', 'from browser_oxide import Browser, Profile; print("ok")'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('ok')) resolve(true);
      else resolve(false);
    });
  });
}

export interface NavigateResult {
  title: string;
  html: string;
  html_size: number;
  verdict: string;
  url: string;
  text?: string;
}

/**
 * Navigate to a URL using browser_oxide stealth engine.
 * Returns page info (title, HTML, verdict).
 */
export async function browserOxideNavigate(url: string, profile: string = 'chrome'): Promise<NavigateResult> {
  if (!(await isBrowserOxideAvailable())) {
    throw new Error('browser_oxide Python bindings not available');
  }
  const script = `
import json
import sys
from browser_oxide import Browser, Profile

profile_map = {
    'chrome': Profile.chrome,
    'firefox': Profile.firefox,
    'iphone': Profile.iphone,
    'pixel': Profile.pixel,
}
profile_fn = profile_map.get('${profile}', Profile.chrome)

with Browser(profile=profile_fn()) as b:
    page = b.navigate(${JSON.stringify(url)})
    result = {
        'title': page.title,
        'html': page.html,
        'html_size': len(page.html),
        'verdict': str(page.verdict),
        'url': page.url,
    }
    print(json.dumps(result))
`;
  const output = await runPythonScript(script, 60_000);
  try {
    return JSON.parse(output);
  } catch (err) {
    throw new Error(`Failed to parse browser_oxide output: ${err.message}. Output: ${output.substring(0, 500)}`);
  }
}

export interface EvaluateResult {
  result: string;
}

/**
 * Evaluate JavaScript in a page using browser_oxide.
 * Note: this requires the page to be already navigated.
 */
export async function browserOxideEvaluate(url: string, js: string, profile: string = 'chrome'): Promise<EvaluateResult> {
  if (!(await isBrowserOxideAvailable())) {
    throw new Error('browser_oxide Python bindings not available');
  }
  const script = `
import json
from browser_oxide import Browser, Profile

profile_map = {
    'chrome': Profile.chrome,
    'firefox': Profile.firefox,
    'iphone': Profile.iphone,
    'pixel': Profile.pixel,
}
profile_fn = profile_map.get('${profile}', Profile.chrome)

with Browser(profile=profile_fn()) as b:
    page = b.navigate(${JSON.stringify(url)})
    result = page.evaluate(${JSON.stringify(js)})
    print(json.dumps({'result': str(result)}))
`;
  const output = await runPythonScript(script, 60_000);
  try {
    return JSON.parse(output);
  } catch (err) {
    throw new Error(`Failed to parse browser_oxide evaluate output: ${err.message}. Output: ${output.substring(0, 500)}`);
  }
}

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Make a stealth HTTP fetch using browser_oxide.
 * Navigates to the URL and returns the rendered HTML.
 * For pure HTTP fetches (not rendered pages), use browserlessFetch instead.
 */
export async function browserOxideFetch(url: string, profile: string = 'chrome'): Promise<FetchResult> {
  const nav = await browserOxideNavigate(url, profile);
  return {
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: nav.html,
  };
}

/**
 * Make a chat completions request through browser_oxide.
 * Navigates to chat.qwen.ai first (so fireyejs.js loads and generates
 * bx-ua/bx-pp tokens), then uses page.evaluate to call fetch() in the
 * browser context.
 *
 * This is the WAF bypass path — the browser generates real AWSC tokens.
 */
export async function browserOxideChatFetch(
  chatUrl: string,
  payload: any,
  cookies: string,
  profile: string = 'chrome',
): Promise<FetchResult> {
  if (!(await isBrowserOxideAvailable())) {
    throw new Error('browser_oxide Python bindings not available');
  }
  const payloadJson = JSON.stringify(payload);
  const script = `
import json
from browser_oxide import Browser, Profile

# Navigate to chat.qwen.ai first to load AWSC fireyejs.js
with Browser(profile=Profile.chrome()) as b:
    # Set cookies via document.cookie if provided
    cookies = ${JSON.stringify(cookies || '')}
    if cookies:
        # Navigate to chat.qwen.ai to set the domain
        page = b.navigate('https://chat.qwen.ai')
        # Set each cookie via JS
        for part in cookies.split(';'):
            part = part.strip()
            if part:
                try:
                    b.evaluate(f'document.cookie = "{part}"')
                except Exception:
                    pass
    else:
        page = b.navigate('https://chat.qwen.ai')

    # Wait for AWSC to initialize
    import time
    time.sleep(3)

    # Now make the chat completions request via fetch() in the page
    payload = ${payloadJson}
    fetch_js = f'''
    fetch(${JSON.stringify(chatUrl)}, {{
        method: 'POST',
        headers: {{
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'source': 'web',
        }},
        body: JSON.stringify({json.dumps(payload)}),
        credentials: 'include',
    }})
    .then(r => r.text().then(t => ({{status: r.status, body: t}})))
    .then(j => JSON.stringify(j))
    .catch(e => JSON.stringify({{error: e.message}}))
    '''
    result_str = b.evaluate(fetch_js)
    try:
        result = json.loads(result_str)
        if 'error' in result:
            print(json.dumps({'status': 0, 'headers': {}, 'body': '', 'error': result['error']}))
        else:
            print(json.dumps({{
                'status': result.get('status', 200),
                'headers': {{}},
                'body': result.get('body', ''),
            }}))
    except Exception as e:
        print(json.dumps({{
            'status': 0,
            'headers': {{}},
            'body': result_str,
            'error': str(e),
        }}))
`;
  const output = await runPythonScript(script, 180_000);
  try {
    return JSON.parse(output);
  } catch (err) {
    throw new Error(`Failed to parse browser_oxide chat fetch output: ${err.message}. Output: ${output.substring(0, 500)}`);
  }
}

/**
 * Run a Python script and return its stdout.
 * Throws on non-zero exit code or timeout.
 */
function runPythonScript(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-c', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: {
        ...process.env,
        // Suppress Python warnings
        PYTHONWARNINGS: 'ignore',
      },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`Failed to spawn python3: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Python exited with code ${code}. stderr: ${stderr.substring(0, 500)}`));
      }
    });
  });
}
