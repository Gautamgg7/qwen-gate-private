import crypto from 'node:crypto';
import { decrementInFlight, getAccountByEmail, getAllAccountEmails, incrementTotalRequests, pickAccount, recordAccountFailure, recordAccountSuccess, throttleAccount } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { config } from './configService.ts';
import { logStore } from './logStore.ts';
import { type BasicHeaders, getBasicHeaders } from './playwright.ts';
import { QWEN_API_BASE } from './qwen.ts';

interface PoolEntry {
  chatId: string;
  parentId: string | null;
  inUse: boolean;
  cachedHeaders?: { cookie: string; userAgent: string };
  accountEmail?: string;
  createdAt: number;
  turnCount: number;
}

interface ConversationSlot {
  entry: PoolEntry;
  nextParentId: string | null;
  lastUsedAt: number;
}

export function formatQwenEnvelopeError(json: any): string {
  const code = json?.data?.code || json?.code || 'unknown';
  const details = json?.data?.details || json?.details || json?.message || '';
  return details ? `${code}: ${details}` : String(code);
}

/** TTL cache of getBasicHeaders() results per account (B4). */
class HeaderCache {
  private cache = new Map<string, { headers: BasicHeaders; fetchedAt: number }>();

  async get(email: string | undefined): Promise<BasicHeaders> {
    const key = email || 'default';
    const ttl = config.getInt('HEADER_CACHE_TTL_MS', 60_000);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.fetchedAt < ttl) return hit.headers;
    const headers = await getBasicHeaders(email);
    this.cache.set(key, { headers, fetchedAt: Date.now() });
    if (this.cache.size > 64) {
      let oldestKey: string | undefined;
      let oldestTs = Number.POSITIVE_INFINITY;
      for (const [k, v] of this.cache) {
        if (v.fetchedAt < oldestTs) {
          oldestTs = v.fetchedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }
    return headers;
  }
}

const headerCache = new HeaderCache();
export class SessionPool {
  private activeSessions = new Set<string>();
  private activeCount = 0;
  private releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private warmPool = new Map<string, PoolEntry[]>();
  private conversations = new Map<string, ConversationSlot>();
  private warmRefills = new Set<string>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  /** chatId -> conversation slot key, set on acquire when reuse is enabled. */
  private entryConvKey = new Map<string, string>();

  async initialize(): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) return;
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => {
      this.gc().catch(() => {});
    }, 60_000);
    if (typeof this.gcTimer.unref === 'function') this.gcTimer.unref();
  }

  private async gc(): Promise<void> {
    const now = Date.now();
    const warmTtl = config.getInt('SESSION_IDLE_TTL_MS', 900_000);
    for (const [email, sessions] of this.warmPool) {
      const expired = sessions.filter((s) => !s.inUse && now - s.createdAt >= warmTtl);
      const fresh = sessions.filter((s) => !s.inUse && now - s.createdAt < warmTtl);
      for (const s of expired) {
        this.activeSessions.delete(s.chatId);
        this.entryConvKey.delete(s.chatId);
        this.deleteSession(s.chatId, s.cachedHeaders, email).catch(() => {});
      }
      if (fresh.length > 0) this.warmPool.set(email, fresh);
      else this.warmPool.delete(email);
    }
    for (const [key, slot] of this.conversations) {
      if (now - slot.lastUsedAt > warmTtl) {
        this.conversations.delete(key);
        this.entryConvKey.delete(slot.entry.chatId);
        if (!slot.entry.inUse) {
          this.activeSessions.delete(slot.entry.chatId);
          this.deleteSession(slot.entry.chatId, slot.entry.cachedHeaders, slot.entry.accountEmail).catch(() => {});
        }
      }
    }
  }

  private convKey(email: string | undefined, raw: string): string {
    const hashValue = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
    return `${(email || 'default').toLowerCase()}::${hashValue}`;
  }
async acquire(email?: string, opts?: { conversationKey?: string }): Promise<PoolEntry> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      const mockId = process.env.TEST_SESSION_ID || 'mock-session';
      return { chatId: mockId, parentId: null, inUse: true, accountEmail: 'mock@test', createdAt: Date.now(), turnCount: 0 };
    }

    const reuseEnabled = config.getBool('CONVERSATION_REUSE', true);
    const convSlotKey = reuseEnabled && opts?.conversationKey ? this.convKey(email, opts.conversationKey) : null;

    if (convSlotKey) {
      const slot = this.conversations.get(convSlotKey);
      if (slot && !slot.entry.inUse) {
        const maxTurns = config.getInt('SESSION_MAX_TURNS', 50);
        const ttl = config.getInt('SESSION_IDLE_TTL_MS', 900_000);
        if (slot.entry.turnCount < maxTurns && Date.now() - slot.lastUsedAt < ttl) {
          slot.entry.inUse = true;
          slot.entry.turnCount++;
          slot.lastUsedAt = Date.now();
          this.activeSessions.add(slot.entry.chatId);
          this.activeCount++;
          this.entryConvKey.set(slot.entry.chatId, convSlotKey);
          return { ...slot.entry, parentId: slot.nextParentId };
        }
        this.conversations.delete(convSlotKey);
        this.entryConvKey.delete(slot.entry.chatId);
        this.deleteSession(slot.entry.chatId, slot.entry.cachedHeaders, slot.entry.accountEmail).catch(() => {});
      }
    }

    const warmSessions = email ? (this.warmPool.get(email) || []) : [];
    const warmEntry = warmSessions.find((s) => !s.inUse);
    if (warmEntry && email) {
      warmEntry.inUse = true;
      warmEntry.turnCount++;
      this.warmPool.set(email, warmSessions.filter((s) => s !== warmEntry));
      this.activeSessions.add(warmEntry.chatId);
      this.activeCount++;
      this.refillWarm(email);
      return warmEntry;
    }
const maxAttempts = email ? 1 : Math.max(1, getAllAccountEmails().length);
    let lastErr: unknown;
    const ACQUIRE_TIMEOUT = 30_000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const resolvedEmail = email || (await pickAccount())?.email;
      try {
        const result = await Promise.race([
          (async () => {
            const headers = await headerCache.get(resolvedEmail);
            const chatId = await this.createSessionWithHeaders(resolvedEmail, headers);
            return { headers, chatId };
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Session acquire timed out for ${resolvedEmail || '?'} after ${ACQUIRE_TIMEOUT}ms`)),
              ACQUIRE_TIMEOUT,
            ),
          ),
        ]);
        const { headers, chatId } = result;
        const entry: PoolEntry = {
          chatId,
          parentId: null,
          inUse: true,
          cachedHeaders: { cookie: headers.cookie, userAgent: headers.userAgent },
          accountEmail: headers.email || resolvedEmail,
          createdAt: Date.now(),
          turnCount: 1,
        };
        this.activeSessions.add(chatId);
        this.activeCount++;
        // Register conversation slot on first use so release() can retain it (B2).
        if (reuseEnabled && convSlotKey) {
          this.entryConvKey.set(chatId, convSlotKey);
          this.conversations.set(convSlotKey, {
            entry: { ...entry, turnCount: 1 },
            nextParentId: null,
            lastUsedAt: Date.now(),
          });
        }
        logStore.log('info', 'pool', 'Session acquired' + (entry.accountEmail ? ': ' + entry.accountEmail.split('@')[0] : ''));
        return entry;
      } catch (err: any) {
        lastErr = err;
        if (resolvedEmail) {
          decrementInFlight(resolvedEmail);
          if (!email && /pending activation|Bad_Request|Chats\/new returned no id/i.test(err?.message || '')) {
            throttleAccount(resolvedEmail, 30 * 60 * 1000);
            logStore.log('warn', 'pool', `Skipping account ${resolvedEmail}: ${err.message}`);
            continue;
          }
        }
        throw err;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error('Failed to acquire session');
  }

  private async refillWarm(email: string | undefined): Promise<void> {
    if (!email || this.warmRefills.has(email)) return;
    const poolSize = config.getInt('SESSION_POOL_SIZE', 0);
    if (poolSize < 1) return;
    const fillCount = async (): Promise<number> => (this.warmPool.get(email) || []).filter((s) => !s.inUse).length;
    if ((await fillCount()) >= poolSize) return;

    this.warmRefills.add(email);
    try {
      const acct = getAccountByEmail(email);
      if (!acct?.state?.token) return;
      while ((await fillCount()) < poolSize) {
        try {
          const headers = await headerCache.get(email);
          const chatId = await this.createSessionWithHeaders(email, headers);
          const entry: PoolEntry = {
            chatId,
            parentId: null,
            inUse: false,
            cachedHeaders: { cookie: headers.cookie, userAgent: headers.userAgent },
            accountEmail: email,
            createdAt: Date.now(),
            turnCount: 0,
          };
          this.activeSessions.add(chatId);
          const list = this.warmPool.get(email) || [];
          list.push(entry);
          this.warmPool.set(email, list);
        } catch (err: any) {
          logStore.log('debug', 'pool', `[Warm] Refill failed for ${email.split('@')[0]}: ${err.message}`);
          break;
        }
      }
    } finally {
      this.warmRefills.delete(email);
    }
  }
async release(
    chatId: string,
    newParentId: string | null,
    cachedHeaders?: { cookie: string; userAgent: string },
    accountEmail?: string,
    isSuccess: boolean = true,
    conversationKey?: string,
  ): Promise<void> {
    if (!this.activeSessions.has(chatId)) return;

    // Resolve conversation slot key: prefer the internal chatId->key map (B2),
    // fall back to an explicitly passed conversationKey.
    let convSlotKey: string | undefined = this.entryConvKey.get(chatId);
    if (!convSlotKey && conversationKey) convSlotKey = this.convKey(accountEmail, conversationKey);
    // Always clean up the mapping — the slot map itself decides retention below.
    this.entryConvKey.delete(chatId);

    if (accountEmail) {
      decrementInFlight(accountEmail);
      if (isSuccess) {
        incrementTotalRequests(accountEmail);
        recordAccountSuccess(accountEmail);
      } else {
        recordAccountFailure(accountEmail);
      }
    }

    this.activeSessions.delete(chatId);
    if (this.activeCount > 0) this.activeCount--;

    const existingTimer = this.releaseTimers.get(chatId);
    if (existingTimer) clearTimeout(existingTimer);
    this.releaseTimers.delete(chatId);

    const reuseEnabled = config.getBool('CONVERSATION_REUSE', true);

    // Conversation continuation: keep session alive for next turn when successful.
    if (reuseEnabled && convSlotKey && isSuccess && this.conversations.has(convSlotKey)) {
      const slot = this.conversations.get(convSlotKey)!;
      if (slot.entry.inUse) slot.entry.inUse = false;
      slot.nextParentId = newParentId;
      slot.lastUsedAt = Date.now();
      slot.entry.parentId = newParentId;
      this.conversations.set(convSlotKey, slot);
      logStore.log('debug', 'pool', `[Conv] Session ${chatId.substring(0, 8)} retained for next turn`);
      return;
    }
    if (convSlotKey && this.conversations.has(convSlotKey)) {
      this.conversations.delete(convSlotKey);
    }

    if (!reuseEnabled && !isSuccess) {
      const timer = setTimeout(() => {
        this.deleteSession(chatId, cachedHeaders, accountEmail);
        this.releaseTimers.delete(chatId);
      }, 0);
      if (typeof timer.unref === 'function') timer.unref();
      this.releaseTimers.set(chatId, timer);
      return;
    }

    const poolSize = config.getInt('SESSION_POOL_SIZE', 0);
    if (poolSize >= 1 && accountEmail && isSuccess && reuseEnabled) {
      const list = this.warmPool.get(accountEmail) || [];
      if (list.filter((s) => !s.inUse).length < poolSize) {
        list.push({
          chatId,
          parentId: newParentId,
          inUse: false,
          cachedHeaders,
          accountEmail,
          createdAt: Date.now(),
          turnCount: 0,
        });
        this.warmPool.set(accountEmail, list);
        logStore.log('debug', 'pool', `[Warm] Session ${chatId.substring(0, 8)} returned to warm pool`);
        return;
      }
    }

    const timer = setTimeout(() => {
      this.deleteSession(chatId, cachedHeaders, accountEmail);
      this.releaseTimers.delete(chatId);
    }, 0);
    if (typeof timer.unref === 'function') timer.unref();
    this.releaseTimers.set(chatId, timer);
    logStore.log('info', 'pool', 'Session released' + (accountEmail ? ': ' + accountEmail.split('@')[0] : '') + ' (deleted)');
  }
trackConversation(
    chatId: string,
    conversationKey: string,
    newParentId: string | null,
    cachedHeaders?: { cookie: string; userAgent: string },
    accountEmail?: string,
  ): void {
    if (!config.getBool('CONVERSATION_REUSE', true)) return;
    const key = this.convKey(accountEmail, conversationKey);
    this.conversations.set(key, {
      entry: {
        chatId,
        parentId: newParentId,
        inUse: false,
        cachedHeaders,
        accountEmail,
        createdAt: Date.now(),
        turnCount: 0,
      },
      nextParentId: newParentId,
      lastUsedAt: Date.now(),
    });
  }

  async deleteSession(chatId: string, cachedHeaders?: { cookie: string; userAgent: string }, accountEmail?: string): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) return;
    if (config.get('DELETE_SESSION', 'true') === 'false') return;

    for (const [key, slot] of this.conversations) {
      if (slot.entry.chatId === chatId) this.conversations.delete(key);
    }
    this.entryConvKey.delete(chatId);
    for (const [, sessions] of this.warmPool) {
      const idx = sessions.findIndex((s) => s.chatId === chatId);
      if (idx !== -1) {
        sessions.splice(idx, 1);
        break;
      }
    }

    let email = accountEmail;
    if (!email) {
      try {
        const headers = await getBasicHeaders();
        email = headers.email;
      } catch {
        console.error('[SessionPool] Failed to get email for session deletion');
        return;
      }
    }

    try {
      const tokenInfo = email ? await import('./auth.ts').then((m) => m.getTokenWithAccount(email!)) : null;
      const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';
      const response = await browserlessFetch(`${QWEN_API_BASE}/api/v2/chats/${chatId}`, {
        method: 'DELETE',
        headers: {
          accept: 'application/json, text/plain, */*',
          source: 'web',
          cookie: cookieStr,
          origin: QWEN_API_BASE,
        },
        accountEmail: email,
      });
      if (!response.ok) {
        logStore.log('debug', 'pool', `[SessionPool] Delete returned ${response.status} for ${chatId.substring(0, 8)}...`);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        logStore.log('debug', 'pool', `[SessionPool] Delete timeout for ${chatId.substring(0, 8)}...`);
      } else {
        logStore.log('debug', 'pool', `[SessionPool] Delete failed for ${chatId.substring(0, 8)}...: ${err.message}`);
      }
    }
  }

  getStats(): { total: number; available: number; inUse: number; waiting: number; warm: number; conversations: number } {
    let warm = 0;
    for (const [, sessions] of this.warmPool) warm += sessions.filter((s) => !s.inUse).length;
    return {
      total: this.activeSessions.size,
      available: this.activeSessions.size - this.activeCount,
      inUse: this.activeCount,
      waiting: 0,
      warm,
      conversations: this.conversations.size,
    };
  }

  private async createSessionWithHeaders(email: string | undefined, headers: BasicHeaders): Promise<string> {
    const acct = email ? getAccountByEmail(email) : null;

    const sessionBody = JSON.stringify({
      title: 'New Chat',
      models: [acct?.state?.token ? 'qwen3.7-plus' : 'qwen3.5-flash'],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    });

    const tokenInfo = email ? await import('./auth.ts').then((m) => m.getTokenWithAccount(email!)) : null;
    const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';

    const response = await browserlessFetch(`${QWEN_API_BASE}/api/v2/chats/new`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
        source: 'web',
        cookie: cookieStr,
        origin: QWEN_API_BASE,
        referer: 'https://chat.qwen.ai/',
      },
      body: sessionBody,
      accountEmail: email,
    });

    if (!response.ok) {
      const bodySnippet = await response
        .text()
        .then((t) => t.substring(0, 200))
        .catch(() => 'unknown');
      logStore.log('warn', 'session', `Chats/new returned ${response.status}: ${bodySnippet.substring(0, 100)}`);
      throw new Error(`Chats/new returned ${response.status}`);
    }

    const responseText = await response.text();
    if (responseText.startsWith('<')) {
      logStore.log('warn', 'session', `Chats/new returned HTML instead of JSON (${responseText.substring(0, 80)}...) — baxia challenge`);
      throw new Error(`Chats/new blocked by WAF — cookies may be expired`);
    }
    let json: any;
    try {
      json = JSON.parse(responseText);
    } catch {
      logStore.log('warn', 'session', `Chats/new returned non-JSON: ${responseText.substring(0, 120)}`);
      throw new Error(`Chats/new returned non-JSON response`);
    }
    if (!json.data?.id) {
      const message = formatQwenEnvelopeError(json);
      throw new Error(`Chats/new returned no id: ${message}`);
    }

    return json.data.id;
  }
}

export const sessionPool = new SessionPool();