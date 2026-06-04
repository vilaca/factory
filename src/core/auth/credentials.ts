import { randomUUID } from 'crypto';
import type { Config, ProviderKey } from '../config/types.js';
import { updateGlobalConfig } from '../config/index.js';

/**
 * Helpers over the multi-key credential store.
 * The store lives at `Config.keys[providerName]: ProviderKey[]`.
 */

/** Last 4 chars of the token. Always returned even for short tokens. */
export function keyFingerprint(token: string): string {
  return token.length <= 4 ? token : token.slice(-4);
}

/**
 * Pick the next key to try when the active key has just failed. Skips
 * already-tried keys, biases toward keys with no recent failure, and
 * returns undefined when the eligible pool is empty.
 *
 * `failureLog` (when provided) maps keyId → last-failure timestamp (ms);
 * keys whose last failure is within `recentFailureWindowMs` are
 * deprioritised but not excluded — exhausting fresh keys still rotates
 * to a recently-failed one before giving up.
 */
export function selectNextKey(
  keys: ProviderKey[],
  tried: ReadonlySet<string>,
  options: {
    failureLog?: ReadonlyMap<string, number>;
    /** Optional `keyId → last-cache-read timestamp (ms)` map. When two
     *  keys are otherwise equally healthy, the one with the most recent
     *  cache read wins — the provider's prompt cache is per-key, so
     *  staying on a warm key avoids paying the full tokenization cost
     *  again. Failure / rate-limit signals still take precedence over
     *  warmth (correctness wins over cost). */
    warmthLog?: ReadonlyMap<string, number>;
    recentFailureWindowMs?: number;
    now?: number;
  } = {},
): ProviderKey | undefined {
  const now = options.now ?? Date.now();
  const window = options.recentFailureWindowMs ?? 5 * 60 * 1000;
  const eligible = keys.filter(k => !tried.has(k.id));
  if (eligible.length === 0) return undefined;
  const fresh: ProviderKey[] = [];
  const stale: ProviderKey[] = [];
  for (const k of eligible) {
    const failedAt = options.failureLog?.get(k.id);
    if (failedAt !== undefined && now - failedAt < window) stale.push(k);
    else fresh.push(k);
  }
  const byCreatedAt = (a: ProviderKey, b: ProviderKey): number =>
    a.createdAt.localeCompare(b.createdAt);
  fresh.sort(byCreatedAt);
  stale.sort(byCreatedAt);

  // Within each health bucket, promote warm keys ahead of cold ones.
  // Warmer (more recent cache read) wins over equally-warm. Cold keys
  // keep their createdAt order so the legacy "oldest-first when nothing
  // is warm" behavior is preserved end-to-end.
  const promoteWarm = (group: ProviderKey[]): ProviderKey[] => {
    if (!options.warmthLog || options.warmthLog.size === 0) return group;
    const warm: Array<{ key: ProviderKey; warmth: number }> = [];
    const cold: ProviderKey[] = [];
    for (const k of group) {
      const w = options.warmthLog.get(k.id);
      if (w !== undefined) warm.push({ key: k, warmth: w });
      else cold.push(k);
    }
    warm.sort((a, b) => b.warmth - a.warmth);
    return [...warm.map(w => w.key), ...cold];
  };

  const orderedFresh = promoteWarm(fresh);
  const orderedStale = promoteWarm(stale);
  return orderedFresh[0] ?? orderedStale[0];
}

/** Human label for the picker: `<label> · …<last4>` or just `…<last4>`. */
export function describeKey(key: ProviderKey): string {
  const fp = keyFingerprint(key.token);
  return key.label ? `${key.label} · …${fp}` : `…${fp}`;
}

/** Returns the list of keys saved for `provider`. */
export function listKeys(cfg: Config, provider: string): ProviderKey[] {
  return cfg.keys?.[provider] ?? [];
}

/**
 * Returns the chosen key for `provider`. With `id` provided, returns the
 * matching entry (or undefined if it's gone). Without `id`, returns the
 * first entry.
 */
export function getKey(cfg: Config, provider: string, id?: string): ProviderKey | undefined {
  const list = listKeys(cfg, provider);
  if (id !== undefined) return list.find(k => k.id === id);
  return list[0];
}

/** Append a new key to the store and persist. Returns the saved entry.
 *  Goes through `updateGlobalConfig` so two concurrent `addKey` calls
 *  serialise rather than each reading the same baseline and clobbering one
 *  another's append. */
export async function addKey(
  provider: string,
  token: string,
  opts: { label?: string; extras?: Record<string, string> } = {},
): Promise<ProviderKey> {
  const entry: ProviderKey = {
    id: randomUUID(),
    token,
    createdAt: new Date().toISOString(),
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.extras ? { extras: opts.extras } : {}),
  };
  await updateGlobalConfig(cfg => ({
    keys: { ...cfg.keys, [provider]: [...(cfg.keys?.[provider] ?? []), entry] },
  }));
  return entry;
}

/** Drop a key by id. Silent no-op if `id` doesn't match. */
export async function deleteKey(provider: string, id: string): Promise<void> {
  await updateGlobalConfig(cfg => {
    const existing = cfg.keys?.[provider];
    if (!existing) return {};
    const next = existing.filter(k => k.id !== id);
    if (next.length === existing.length) return {};
    return { keys: { ...cfg.keys, [provider]: next } };
  });
}
