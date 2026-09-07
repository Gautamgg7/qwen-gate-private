/*
 * File: accountManager.ts
 * Account management extracted from auth.ts.
 * Handles account CRUD, discovery, persistence, and the account file watcher.
 */
import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AccountEntry } from '../types/auth.ts';
import { projectPath } from '../utils/paths.ts';
import { config } from './configService.ts';
import { loginFresh } from './loginService.ts';
import { logStore } from './logStore.ts';
import { configureAccount } from './qwenModels.ts';

/** In-memory account registry. Mutations must stay synchronous. */
export const accounts: AccountEntry[] = [];

const ACCOUNTS_FILE = projectPath('.qwen', 'accounts.json');
const FALLBACK_ACCOUNTS_FILE = projectPath('.qwen', 'accounts.jsonc');
const QWEN_DIR = projectPath('.qwen');

const OLD_ACCOUNTS_FILE = projectPath('qwen_profile', 'accounts.json');

function getProfileDirForEmail(email: string): string {
  const safe = email
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '_');
  return projectPath('.qwen', 'browser-profiles', safe);
}

export function migrateFromOldPaths(): void {
  try {
    if (!existsSync(OLD_ACCOUNTS_FILE)) return;
    if (existsSync(ACCOUNTS_FILE) || existsSync(FALLBACK_ACCOUNTS_FILE)) return;

    logStore.log('info', 'auth', 'Migrating data from qwen_profile/ to .qwen/ ...');

    const newDir = path.dirname(ACCOUNTS_FILE);
    if (!existsSync(newDir)) {
      mkdirSync(newDir, { recursive: true });
    }

    const accountsData = readFileSync(OLD_ACCOUNTS_FILE, 'utf-8');
    writeFileSync(ACCOUNTS_FILE, accountsData, 'utf-8');
    logStore.log('info', 'auth', 'Migrated accounts.json from qwen_profile/ to .qwen/');
    logStore.log('info', 'auth', 'Note: old token files are ignored — tokens are now read from browser profiles.');
    logStore.log('info', 'auth', 'Migration complete. Old files preserved.');
  } catch (err: any) {
    logStore.log('error', 'auth', `Migration error: ${err.message}`);
  }
}

export interface CookieData {
  email: string;
  token: string;
  refreshToken: string | null;
  savedAt: number;
  expiresAt: number;
}
/** Strip // and /* * / JSONC comments before JSON.parse */
function stripJsoncComments(text: string): string {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

interface PersistedAccountData {
  email: string;
  password: string;
  throttledUntil?: number;
  disabled?: boolean;
}
export function parseAccountsFromEnv(): Array<{ email: string; password: string }> {
  const result: Array<{ email: string; password: string }> = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^ACCOUNT\d+$/i.test(key) || !value) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;
    const email = trimmed.substring(0, colonIdx).trim();
    const password = trimmed.substring(colonIdx + 1).trim();
    if (email && password) {
      result.push({ email, password });
    }
  }
  return result;
}
export function discoverSavedAccounts(): Array<{ email: string; password: string }> {
  return parseAccountsFromEnv();
}

/**
 * Decode a JWT token and return its payload, or null if invalid.
 */
export function decodeJwt(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}
/* ── AES-256-GCM password encryption ── */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const MASTER_KEY_FILE = projectPath('.qwen', 'master.key');

function getEncryptionKey(): string {
  // 1. If a master key file exists, use it (survives API_KEY changes)
  try {
    if (existsSync(MASTER_KEY_FILE)) {
      return readFileSync(MASTER_KEY_FILE, 'utf-8').trim();
    }
  } catch {
    // Fall through to other strategies
  }

  // 2. Use API_KEY as encryption key (backward compatibility)
  const apiKey = config.get('API_KEY');
  if (apiKey) return apiKey;

  // 3. Generate a persistent master key on first use
  try {
    const dir = path.dirname(MASTER_KEY_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const newKey = crypto.randomBytes(32).toString('hex');
    writeFileSync(MASTER_KEY_FILE, newKey, 'utf-8');
    return newKey;
  } catch {
    // 4. Fallback: hostname-based key (only when filesystem is unwritable)
    const machineId = `${os.hostname()}-${projectPath('.')}`;
    return crypto.createHash('sha256').update(machineId).digest('hex');
  }
}

function deriveKey(keyMaterial: string): Buffer {
  return crypto.scryptSync(keyMaterial, 'qwen-gate-salt', 32);
}

export function encrypt(plaintext: string): string {
  const key = deriveKey(getEncryptionKey());
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) return encryptedText;
  const [ivHex, authTagHex, encrypted] = parts;
  try {
    const key = deriveKey(getEncryptionKey());
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    logStore.log('error', 'auth', 'Decryption failed — wrong API_KEY or corrupted data');
    return '';
  }
}

// Backward-compatible aliases for existing callers
function encryptPassword(password: string): string {
  return encrypt(password);
}

function decryptPassword(encryptedText: string): string {
  return decrypt(encryptedText);
}

// O(1) email→account lookup index (synced with accounts array mutations)
const emailIndex = new Map<string, AccountEntry>();

export function rebuildEmailIndex(): void {
  emailIndex.clear();
  for (const acct of accounts) {
    emailIndex.set(acct.email.toLowerCase().trim(), acct);
  }
}

export function saveAccountsToFile(accounts: readonly AccountEntry[]): void {
  const dir = path.dirname(ACCOUNTS_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const data: PersistedAccountData[] = accounts
    .filter((a) => a.password)
    .map((a) => ({
      email: a.email,
      password: a.password, // plaintext
      ...(a.throttledUntil > Date.now() ? { throttledUntil: a.throttledUntil } : {}),
      ...(a.disabled !== undefined ? { disabled: a.disabled } : {}),
    }));
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}
export function loadAccountsFromFile(): Array<{ email: string; password: string; throttledUntil?: number; disabled?: boolean }> {
  const tryLoad = (filePath: string): Array<{ email: string; password: string; throttledUntil?: number; disabled?: boolean }> | null => {
    try {
      if (!existsSync(filePath)) return null;
      const raw = readFileSync(filePath, 'utf-8');
      const data: PersistedAccountData[] = JSON.parse(stripJsoncComments(raw));
      return data
        .filter((d) => d.email && d.password)
        .map((d) => ({
          email: d.email,
          password: decryptPassword(d.password),
          throttledUntil: d.throttledUntil,
          disabled: d.disabled ?? false,
        }));
    } catch (err: any) {
      logStore.log('error', 'auth', `Failed to load ${filePath}: ${err.message}`);
      return null;
    }
  };

  return tryLoad(ACCOUNTS_FILE) ?? tryLoad(FALLBACK_ACCOUNTS_FILE) ?? [];
}
export async function addAccount(email: string, password: string): Promise<{ loginSucceeded: boolean; loginError?: string }> {
  const normalizedEmail = email.toLowerCase().trim();
  const existing = accounts.find((a) => a.email.toLowerCase().trim() === normalizedEmail);
  if (existing) {
    throw new Error(`Account with email ${normalizedEmail} already exists`);
  }
  const entry: AccountEntry = {
    email: normalizedEmail,
    password,
    state: null,
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    disabled: false,
  };
  accounts.push(entry);
  rebuildEmailIndex();
  saveAccountsToFile(accounts);

  // Step 1: Create and authorize the browser profile
  const { openBrowserProfile } = await import('./browserProfiles.ts');
  let profileResult = await openBrowserProfile(normalizedEmail, password, { headless: true });
  if (profileResult === 'captcha') {
    logStore.log('info', 'account', `Captcha for ${normalizedEmail} — opening headed browser...`);
    profileResult = await openBrowserProfile(normalizedEmail, password, { headless: false });
  }

  if (profileResult === 'success') {
    // Step 2: Extract token from the now-authenticated profile
    const { loadCookiesFromProfile } = await import('./auth.ts');
    const profileState = await loadCookiesFromProfile(normalizedEmail);
    if (profileState) {
      entry.state = profileState;
      await configureAccount(normalizedEmail).catch((err) =>
        logStore.log('error', 'account', `Failed to configure ${normalizedEmail}: ${err.message}`),
      );
      return { loginSucceeded: true };
    }
  }

  // Fallback: try API login if profile authorization failed
  const newState = await loginFresh(normalizedEmail, password);
  if (newState) {
    entry.state = newState;
    await configureAccount(normalizedEmail).catch((err) =>
      logStore.log('error', 'account', `Failed to configure ${normalizedEmail}: ${err.message}`),
    );
    return { loginSucceeded: true };
  } else {
    const msg = `Login failed: wrong password or CAPTCHA required for ${normalizedEmail}. Check system logs.`;
    logStore.log('warn', 'auth', msg);
    return { loginSucceeded: false, loginError: msg };
  }
}
export async function removeAccount(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  const index = accounts.findIndex((a) => a.email.toLowerCase().trim() === normalizedEmail);
  if (index === -1) {
    throw new Error(`Account with email ${normalizedEmail} not found`);
  }
  accounts.splice(index, 1);
  rebuildEmailIndex();
  saveAccountsToFile(accounts);
  const { removeAccountContext } = await import('./playwright.ts');
  removeAccountContext(normalizedEmail);
  const profileDir = getProfileDirForEmail(normalizedEmail);
  if (existsSync(profileDir)) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch (err: any) {
      logStore.log('error', 'auth', `Failed to delete Chromium profile for ${normalizedEmail}: ${err.message}`);
    }
  }
}
/**
 * Re-scan accounts and merge changes into the live accounts array.
 */
export async function reloadAccounts(): Promise<void> {
  if (accountWatcher && !watcherReady) {
    return;
  }
  // Discover from BOTH env vars and the persisted accounts file.
  // discoverSavedAccounts() only reads ACCOUNTn env vars — without merging the
  // file, the watcher treated every file-based account as "not discovered" and
  // removed it from memory on each accounts.json change (add/throttle/cookie
  // save), making the dashboard count flicker between 0/2/3.
  const seenEmails = new Set<string>();
  const discovered: Array<{ email: string; password: string }> = [];
  for (const d of [...discoverSavedAccounts(), ...loadAccountsFromFile()]) {
    const key = d.email.toLowerCase().trim();
    if (!key || seenEmails.has(key) || !d.password) continue;
    seenEmails.add(key);
    discovered.push({ email: key, password: d.password });
  }
  const discoveredEmails = new Set(discovered.map((d) => d.email));
  const existingEmails = new Set(accounts.map((a) => a.email.toLowerCase().trim()));
  let added = 0;
  let removed = 0;
  for (const d of discovered) {
    const email = d.email.toLowerCase().trim();
    if (!existingEmails.has(email)) {
      const entry: AccountEntry = {
        email,
        password: d.password,
        state: null,
        lastUsed: 0,
        throttledUntil: 0,
        refreshInFlight: null,
        loginAttempt: 0,
        inFlight: 0,
        totalRequests: 0,
        disabled: false,
      };
      const { loadCookiesFromProfile } = await import('./auth.ts');
      const profileState = await loadCookiesFromProfile(email);
      if (profileState) {
        entry.state = profileState;
      }
      accounts.push(entry);
      added++;
    }
  }
  for (let i = accounts.length - 1; i >= 0; i--) {
    const acct = accounts[i];
    if (!discoveredEmails.has(acct.email.toLowerCase().trim())) {
      const profileDir = getProfileDirForEmail(acct.email);
      if (existsSync(profileDir)) {
        continue;
      }
      if (acct.inFlight > 0) {
        continue;
      }
      accounts.splice(i, 1);
      removed++;
    }
  }
  if (added > 0 || removed > 0) rebuildEmailIndex();
}
let accountWatcher: any = null;
let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let watcherReady = false;
let watcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Set up fs.watch on .qwen/ directory with 500ms debounce to detect accounts.json changes.
 */
export function setupAccountWatcher(): void {
  if (accountWatcher) return;
  if (!existsSync(QWEN_DIR)) {
    mkdirSync(QWEN_DIR, { recursive: true });
  }
  try {
    accountWatcher = watch(QWEN_DIR, (_eventType: string, filename: string | null) => {
      if (!filename || filename !== 'accounts.json') return;
      if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = setTimeout(() => {
        reloadDebounceTimer = null;
        reloadAccounts().catch((err) => {
          logStore.log('error', 'auth', `Hot-reload failed: ${err.message}`);
        });
      }, 500);
    });
    accountWatcher.on('error', (err: any) => {
      logStore.log('error', 'auth', `Account watcher error: ${err.message}`);
      try {
        accountWatcher?.close();
      } catch {
        // non-blocking: watcher may already be closed
      }
      accountWatcher = null;
      watcherReady = false;
      if (watcherRetryTimer) clearTimeout(watcherRetryTimer);
      watcherRetryTimer = setTimeout(() => {
        watcherRetryTimer = null;
        setupAccountWatcher();
      }, 10000);
      watcherRetryTimer.unref();
    });
    setTimeout(() => {
      watcherReady = true;
    }, 2000);
  } catch (err: any) {
    logStore.log('error', 'auth', `Failed to set up account watcher: ${err.message}`);
  }
}
/**
 * Enable hot-reload by starting the account file watcher.
 */
export function enableHotReload(): void {
  setupAccountWatcher();
}
export function resetWatcherState(): void {
  watcherReady = false;
  if (watcherRetryTimer) {
    clearTimeout(watcherRetryTimer);
    watcherRetryTimer = null;
  }
}
export function isAvailable(acct: AccountEntry): boolean {
  if (acct.disabled) return false;
  if (!acct.state) return false;
  if (acct.throttledUntil > Date.now()) return false;
  // Circuit breaker (D4): skip accounts in degraded/down state
  const health = accountHealth.get(acct.email.toLowerCase().trim());
  if (health && health.degradedUntil > Date.now()) return false;
  return true;
}

// ── Account health scoring / circuit breaker (D4) ──────────────────
// Tracks per-account success/failure in a rolling window. When failures
// exceed the threshold, the account is marked degraded and temporarily
// excluded from pickAccount. Successful requests restore it.

interface AccountHealth {
  successes: number;
  failures: number;
  degradedUntil: number;
  lastFailureAt: number;
}

const accountHealth = new Map<string, AccountHealth>();
const HEALTH_WINDOW_MS = 5 * 60 * 1000; // 5-minute rolling window
const DEGRADED_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
const DOWN_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const DEGRADE_THRESHOLD = 3; // consecutive failures → degraded
const DOWN_THRESHOLD = 5; // consecutive failures → down

function getHealth(email: string): AccountHealth {
  const key = email.toLowerCase().trim();
  let h = accountHealth.get(key);
  if (!h) {
    h = { successes: 0, failures: 0, degradedUntil: 0, lastFailureAt: 0 };
    accountHealth.set(key, h);
  }
  return h;
}

export function recordAccountSuccess(email: string): void {
  const h = getHealth(email);
  h.successes++;
  // Decay failures on success — allows auto-recovery
  if (h.failures > 0) h.failures = Math.max(0, h.failures - 1);
  if (h.failures < DEGRADE_THRESHOLD && h.degradedUntil > 0) {
    h.degradedUntil = 0;
    logStore.log('info', 'account', `[Health] ${email.split('@')[0]} recovered (failures decayed to ${h.failures})`);
  }
  // Prune old window entries
  if (h.lastFailureAt > 0 && Date.now() - h.lastFailureAt > HEALTH_WINDOW_MS) {
    h.failures = 0;
  }
}

export function recordAccountFailure(email: string): void {
  const h = getHealth(email);
  h.failures++;
  h.lastFailureAt = Date.now();
  const threshold = config.getFloat('ACCOUNT_HEALTH_THRESHOLD', 0.6);
  // Circuit breaker thresholds scaled by the health threshold config
  const degradeAt = Math.max(2, Math.round(DEGRADE_THRESHOLD * (1 / Math.max(0.1, threshold))));
  const downAt = degradeAt + 2;
  if (h.failures >= downAt) {
    h.degradedUntil = Date.now() + DOWN_COOLDOWN_MS;
    logStore.log('warn', 'account', `[Health] ${email.split('@')[0]} marked DOWN (${h.failures} failures) — cooldown ${DOWN_COOLDOWN_MS / 1000}s`);
  } else if (h.failures >= degradeAt) {
    h.degradedUntil = Date.now() + DEGRADED_COOLDOWN_MS;
    logStore.log('warn', 'account', `[Health] ${email.split('@')[0]} marked DEGRADED (${h.failures} failures) — cooldown ${DEGRADED_COOLDOWN_MS / 1000}s`);
  }
}

export function getAccountHealthSummary(): Array<{ email: string; failures: number; degraded: boolean; degradedUntil: string | null }> {
  return getAllAccountEmails().map((email) => {
    const h = accountHealth.get(email.toLowerCase().trim());
    return {
      email,
      failures: h?.failures || 0,
      degraded: !!h && h.degradedUntil > Date.now(),
      degradedUntil: h?.degradedUntil && h.degradedUntil > Date.now() ? new Date(h.degradedUntil).toISOString() : null,
    };
  });
}
export async function pickAccount(excludeEmail?: string): Promise<AccountEntry | null> {
  // No lock needed — all operations are synchronous and fast.
  // Worst case for concurrent access: slightly imbalanced inFlight count,
  // which is acceptable for load-balancing purposes.
  try {
    let available = accounts.filter(isAvailable);
    if (excludeEmail) {
      available = available.filter((a) => a.email !== excludeEmail);
    }
    if (available.length === 0) {
      // All accounts are throttled or unauthenticated — return null instead
      // of falling back to a throttled account (which would guaranteed fail).
      // The caller should return a proper "all accounts exhausted" error.
      if (accounts.length === 0) {
        return null;
      }
      const throttled = accounts.filter((a) => a.throttledUntil > Date.now()).length;
      const noState = accounts.filter((a) => !a.state).length;
      logStore.log('warn', 'auth', `All ${accounts.length} accounts exhausted — ${throttled} throttled, ${noState} unauthenticated`);
      return null;
    }
    const pool = available.filter((a) => a.inFlight === 0);
    const candidates = pool.length > 0 ? pool : available;
    // Single-pass O(N) min-find instead of O(N log N) sort
    let bestIdx = 0;
    for (let i = 1; i < candidates.length; i++) {
      const a = candidates[i];
      const b = candidates[bestIdx];
      if (
        a.inFlight < b.inFlight ||
        (a.inFlight === b.inFlight && a.totalRequests < b.totalRequests) ||
        (a.inFlight === b.inFlight && a.totalRequests === b.totalRequests && (a.lastUsed || 0) < (b.lastUsed || 0))
      ) {
        bestIdx = i;
      }
    }
    const picked = candidates[bestIdx];
    logStore.log(
      'debug',
      'auth',
      `[Account] Picked ${picked.email} — inFlight=${picked.inFlight} totalReqs=${picked.totalRequests} lastUsed=${picked.lastUsed ? Date.now() - picked.lastUsed + 'ms ago' : 'never'}${excludeEmail ? ` (excluded: ${excludeEmail})` : ''}`,
    );
    picked.lastUsed = Date.now();
    // Reset stuck inFlight: if counter > 0 and last increment was > 30s ago, it leaked
    // (was 60s — too long: a hung stream ties up the account for 60s before reset).
    // 30s is enough for any normal request to be in flight, short enough to recover
    // quickly from leaked counters caused by browserlessFetch errors that don't
    // go through the normal release path.
    if (picked.inFlight > 0 && picked.lastInFlightAt && Date.now() - picked.lastInFlightAt > 30_000) {
      logStore.log(
        'warn',
        'auth',
        `[Account] Reset stuck inFlight for ${picked.email} (was ${picked.inFlight}, stuck for ${Math.round((Date.now() - picked.lastInFlightAt) / 1000)}s)`,
      );
      picked.inFlight = 0;
      picked.lastInFlightAt = 0;
    }
    picked.inFlight++;
    picked.lastInFlightAt = Date.now();
    // Safety valve: reset if counter drifts unreasonably high (10, was 20)
    if (picked.inFlight > 10) {
      picked.inFlight = 1;
      picked.lastInFlightAt = Date.now();
    }
    return picked;
  } catch (err: any) {
    logStore.log('error', 'auth', 'pickAccount error:', err);
    return null;
  }
}
export function incrementInFlight(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct) {
    acct.inFlight++;
    acct.lastInFlightAt = Date.now();
  }
}
export function decrementInFlight(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct && acct.inFlight > 0) {
    acct.inFlight--;
    if (acct.inFlight === 0) acct.lastInFlightAt = 0;
  }
}
export function incrementTotalRequests(email: string): void {
  const acct = getAccountByEmail(email);
  if (acct) acct.totalRequests++;
}
export function hasInFlight(email: string): boolean {
  const acct = getAccountByEmail(email);
  return acct ? acct.inFlight > 0 : false;
}
export function getAccountByEmail(email: string): AccountEntry | null {
  return emailIndex.get(email.toLowerCase().trim()) || null;
}
export function setAccountDisabled(email: string, disabled: boolean): void {
  const acct = getAccountByEmail(email);
  if (!acct) throw new Error(`Account not found: ${email}`);
  acct.disabled = disabled;
  saveAccountsToFile(accounts);
}

export function throttleAccount(email: string, durationMs?: number): void {
  const acct = getAccountByEmail(email);
  if (!acct) return;
  const cooldown = durationMs || config.getInt('RATE_LIMIT_COOLDOWN_MS', 120000);
  acct.throttledUntil = Date.now() + cooldown;
  const unlockTime = new Date(acct.throttledUntil).toISOString();
  const hours = Math.ceil(cooldown / 3600000);
  logStore.log('warn', 'auth', `Throttled ${email} — unlocks at ${unlockTime} (${hours}h)`);
  // Persist so restart respects the cooldown
  saveAccountsToFile(accounts);
}
export function isAccountThrottled(email: string): boolean {
  const acct = getAccountByEmail(email);
  if (!acct) return true;
  return acct.throttledUntil > Date.now();
}
export function getAccountStats(): Array<{
  email: string;
  authenticated: boolean;
  throttled: boolean;
  disabled: boolean;
  throttledRemainingMs: number;
  throttledUnlockAt: string | null;
  tokenExpiresInMs: number;
  lastUsedAgoMs: number;
  inFlight: number;
  totalRequests: number;
}> {
  const now = Date.now();
  return accounts.map((a) => ({
    email: a.email,
    authenticated: a.state !== null,
    throttled: a.throttledUntil > now,
    disabled: a.disabled ?? false,
    throttledRemainingMs: Math.max(0, a.throttledUntil - now),
    throttledUnlockAt: a.throttledUntil > now ? new Date(a.throttledUntil).toISOString() : null,
    tokenExpiresInMs: a.state ? Math.max(0, a.state.expiresAt - now) : 0,
    lastUsedAgoMs: a.lastUsed ? now - a.lastUsed : -1,
    inFlight: a.inFlight,
    totalRequests: a.totalRequests,
  }));
}
export function getAccountCount(): number {
  return accounts.length;
}
export function getAvailableCount(): number {
  return accounts.filter(isAvailable).length;
}
export function getAllAccountEmails(): string[] {
  return accounts.map((a) => a.email);
}
export function getAccounts(): readonly AccountEntry[] {
  return [...accounts];
}
export async function getToken(): Promise<string | null> {
  const acct = await pickAccount();
  if (acct) {
    decrementInFlight(acct.email);
    return acct.state?.token || null;
  }
  return null;
}
export async function getTokenWithAccount(email?: string): Promise<{ token: string; email: string } | null> {
  let acct: AccountEntry | null;
  let picked = false;
  if (email) {
    acct = getAccountByEmail(email);
    if (acct && !isAvailable(acct) && acct.state) {
      // Account exists but throttled — still return it
    }
  } else {
    acct = await pickAccount();
    picked = true;
  }
  if (!acct?.state?.token) {
    if (picked && acct) decrementInFlight(acct.email);
    return null;
  }
  acct.lastUsed = Date.now();
  if (picked) decrementInFlight(acct.email);
  return { token: acct.state.token, email: acct.email };
}
