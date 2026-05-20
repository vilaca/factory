import fs from 'fs';
import path from 'path';
import type { TokenUsage } from '../../providers/types.js';
import { writeFileAtomic } from '../../utils/atomic-write.js';
import { factoryHomePath } from '../../utils/factory-paths.js';

/**
 * Per-key usage analytics. Stored separately from the credentials file so
 * that frequent updates (every successful turn / rotation) don't keep
 * touching the secrets file. The stats file is plain JSON, mode 0o600,
 * lives at `~/.factory/key-stats.json`. Lossy by design — a session crash
 * may lose up to ~30s of buffered counter increments, which is acceptable
 * for "is this key healthy?" reporting.
 */

interface KeyStat {
  successCount: number;
  rateLimitCount: number;
  authErrorCount: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  /** Cumulative input tokens served from cache for this key. */
  cachedInputTokens?: number;
  /** Cumulative input tokens NOT served from cache (raw - cached). */
  uncachedInputTokens?: number;
  /** Cumulative cache-creation tokens billed for this key (Anthropic). */
  cacheCreationTokens?: number;
  /** ISO timestamp of the last turn that read >0 tokens from cache. Used as
   * a cheap "warm" badge in /keys without a rolling-window decay. */
  lastCacheReadAt?: string;
}

interface AllKeyStats {
  [provider: string]: { [keyId: string]: KeyStat };
}

function statsFilePath(): string {
  return factoryHomePath('key-stats.json');
}

function emptyStat(): KeyStat {
  return { successCount: 0, rateLimitCount: 0, authErrorCount: 0 };
}

let cache: AllKeyStats | null = null;
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_DEBOUNCE_MS = 30_000;

async function readFromDisk(): Promise<AllKeyStats> {
  try {
    const raw = await fs.promises.readFile(statsFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AllKeyStats;
    }
  } catch {
    // Missing / unreadable / bad JSON — start fresh.
  }
  return {};
}

async function flush(): Promise<void> {
  if (!dirty || !cache) return;
  dirty = false;
  const filePath = statsFilePath();
  const dir = path.dirname(filePath);
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(filePath, JSON.stringify(cache, null, 2) + '\n');
  } catch {
    // Stats persistence is best-effort. Re-flag dirty so the next flush
    // tries again — if stats are *consistently* unwritable (read-only fs)
    // we'll keep retrying, but that's harmless.
    dirty = true;
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DEBOUNCE_MS);
  // Don't keep the event loop alive just for stats persistence.
  flushTimer.unref?.();
}

// Holds the in-flight readFromDisk promise so concurrent first-time callers
// share one read instead of each kicking off their own. Without this, two
// recordX calls racing on a cold cache would each populate `cache` from
// disk, the later resolution would clobber the earlier reference, and any
// mutation made on the orphaned reference would be lost on the next flush.
let pendingRead: Promise<AllKeyStats> | null = null;
async function ensureCache(): Promise<AllKeyStats> {
  if (cache) return cache;
  pendingRead ??= readFromDisk()
    .then(c => {
      cache = c;
      return c;
    })
    .finally(() => {
      pendingRead = null;
    });
  return pendingRead;
}

function getOrCreate(stats: AllKeyStats, provider: string, keyId: string): KeyStat {
  let perProvider = stats[provider];
  if (!perProvider) {
    perProvider = {};
    stats[provider] = perProvider;
  }
  let entry = perProvider[keyId];
  if (!entry) {
    entry = emptyStat();
    perProvider[keyId] = entry;
  }
  return entry;
}

/** Increment successCount and stamp lastSuccessAt. */
export async function recordSuccess(provider: string, keyId: string): Promise<void> {
  const stats = await ensureCache();
  const entry = getOrCreate(stats, provider, keyId);
  entry.successCount++;
  entry.lastSuccessAt = new Date().toISOString();
  dirty = true;
  scheduleFlush();
}

/** Accumulate cache-aware token counters for a successful turn. Called
 *  alongside recordSuccess from the agent loop. Lossy on crash like the
 *  rest of this file — same 30s debounce, same atomic flush. */
export async function recordTokenUsage(
  provider: string,
  keyId: string,
  usage: TokenUsage,
): Promise<void> {
  const stats = await ensureCache();
  const entry = getOrCreate(stats, provider, keyId);
  const cached = usage.cachedPromptTokens ?? 0;
  const total = usage.promptTokens ?? 0;
  const uncached = Math.max(0, total - cached);
  entry.cachedInputTokens = (entry.cachedInputTokens ?? 0) + cached;
  entry.uncachedInputTokens = (entry.uncachedInputTokens ?? 0) + uncached;
  if (typeof usage.cacheCreationTokens === 'number') {
    entry.cacheCreationTokens = (entry.cacheCreationTokens ?? 0) + usage.cacheCreationTokens;
  }
  if (cached > 0) {
    entry.lastCacheReadAt = new Date().toISOString();
  }
  dirty = true;
  scheduleFlush();
}

/** Increment the appropriate failure bucket and stamp lastFailureAt. */
export async function recordFailure(
  provider: string,
  keyId: string,
  reason: 'rate-limit' | 'auth',
): Promise<void> {
  const stats = await ensureCache();
  const entry = getOrCreate(stats, provider, keyId);
  if (reason === 'rate-limit') entry.rateLimitCount++;
  else entry.authErrorCount++;
  entry.lastFailureAt = new Date().toISOString();
  dirty = true;
  scheduleFlush();
}

/** Read-only snapshot for UI rendering. */
export async function getStats(provider: string, keyId: string): Promise<KeyStat | undefined> {
  const stats = await ensureCache();
  return stats[provider]?.[keyId];
}

/** Read-only snapshot of every key's stats for a given provider. */
export async function listStatsForProvider(
  provider: string,
): Promise<{ [keyId: string]: KeyStat }> {
  const stats = await ensureCache();
  return { ...(stats[provider] ?? {}) };
}

/** Returns a map of `keyId → last-cache-read timestamp (ms epoch)` for the
 *  given provider, restricted to keys whose `lastCacheReadAt` falls within
 *  `ttlMs`. The rotation tiebreaker (call-model) reads this to prefer
 *  warm keys when several are equally healthy — newer reads beat older
 *  reads, which is a coarse but accurate proxy for "this key's prompt
 *  cache is still alive on the provider side". */
export async function getWarmthLog(provider: string, ttlMs: number): Promise<Map<string, number>> {
  const stats = await ensureCache();
  const out = new Map<string, number>();
  const now = Date.now();
  for (const [keyId, stat] of Object.entries(stats[provider] ?? {})) {
    const ts = stat.lastCacheReadAt;
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && now - ms < ttlMs) {
      out.set(keyId, ms);
    }
  }
  return out;
}

/** Force an immediate flush. Call on session-end so the user doesn't lose
 *  the last few minutes of counters when shutting down. */
export async function flushKeyStats(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();
}

/** Test-only — drop the in-memory cache and timer. Mirrors the credentials
 *  test pattern. */
export function _resetKeyStatsForTests(): void {
  cache = null;
  pendingRead = null;
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
