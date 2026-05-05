import { randomUUID } from 'crypto';
import type { Config, ProviderKey } from './config-types.js';
import { loadGlobalConfig, saveGlobalConfig } from './config.js';
import { DESCRIPTOR_LIST } from '../providers/descriptors.js';

/**
 * Helpers over the multi-key credential store. The store lives at
 * `Config.keys[providerName]: ProviderKey[]`. Pre-multi-key configs keep
 * working via the legacy `<provider>Token` fields — `listKeys` synthesises
 * a virtual entry for them on read, and `migrateLegacyKeys` rewrites the
 * config to bake those entries in on the next save.
 */

const LEGACY_KEY_ID = 'legacy';

/** Provider name → legacy `<provider>Token` config field. */
const LEGACY_TOKEN_KEY: Record<string, keyof Config> = (() => {
  const map: Record<string, keyof Config> = {};
  for (const d of DESCRIPTOR_LIST) {
    if (d.configTokenKey) map[d.name] = d.configTokenKey;
  }
  return map;
})();

/** Last 4 chars of the token. Always returned even for short tokens. */
export function keyFingerprint(token: string): string {
  return token.length <= 4 ? token : token.slice(-4);
}

/** Human label for the picker: `<label> · …<last4>` or just `…<last4>`. */
export function describeKey(key: ProviderKey): string {
  const fp = keyFingerprint(key.token);
  return key.label ? `${key.label} · …${fp}` : `…${fp}`;
}

function legacyTokenFor(cfg: Config, provider: string): string | undefined {
  const field = LEGACY_TOKEN_KEY[provider];
  if (!field) return undefined;
  const value = cfg[field];
  return typeof value === 'string' && value ? value : undefined;
}

function legacyExtrasFor(cfg: Config, provider: string): Record<string, string> | undefined {
  // WorkersAI is the only provider with a per-key non-token field today.
  if (provider === 'workersai' && cfg.workersAiAccountId) {
    return { accountId: cfg.workersAiAccountId };
  }
  return undefined;
}

function syntheticLegacyKey(token: string, extras: Record<string, string> | undefined): ProviderKey {
  return {
    id: LEGACY_KEY_ID,
    label: 'default',
    token,
    createdAt: new Date(0).toISOString(),
    ...(extras ? { extras } : {}),
  };
}

/**
 * Returns the list of keys saved for `provider`. If the multi-key store is
 * empty for that provider but a legacy `<provider>Token` is set, returns a
 * synthetic single-element list with `id='legacy'`. The synthetic entry is
 * not persisted on read — `migrateLegacyKeys` is what bakes it in.
 */
export function listKeys(cfg: Config, provider: string): ProviderKey[] {
  const stored = cfg.keys?.[provider];
  if (stored && stored.length > 0) return stored;
  const token = legacyTokenFor(cfg, provider);
  if (!token) return [];
  return [syntheticLegacyKey(token, legacyExtrasFor(cfg, provider))];
}

/**
 * Returns the chosen key for `provider`. With `id` provided, returns the
 * matching entry (or undefined if it's gone). Without `id`, returns the
 * first entry — which is the synthetic legacy one before migration, or
 * the most-recently-written one after.
 */
export function getKey(cfg: Config, provider: string, id?: string): ProviderKey | undefined {
  const list = listKeys(cfg, provider);
  if (id !== undefined) return list.find(k => k.id === id);
  return list[0];
}

/** Append a new key to the store and persist. Returns the saved entry. */
export async function addKey(
  provider: string,
  token: string,
  opts: { label?: string; extras?: Record<string, string> } = {},
): Promise<ProviderKey> {
  const cfg = await loadGlobalConfig();
  const existing = cfg.keys?.[provider] ?? [];
  const entry: ProviderKey = {
    id: randomUUID(),
    token,
    createdAt: new Date().toISOString(),
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.extras ? { extras: opts.extras } : {}),
  };
  await saveGlobalConfig({
    keys: { ...cfg.keys, [provider]: [...existing, entry] },
  });
  return entry;
}

/** Drop a key by id. Silent no-op if `id` doesn't match. */
export async function deleteKey(provider: string, id: string): Promise<void> {
  const cfg = await loadGlobalConfig();
  const existing = cfg.keys?.[provider];
  if (!existing) return;
  const next = existing.filter(k => k.id !== id);
  if (next.length === existing.length) return;
  await saveGlobalConfig({
    keys: { ...cfg.keys, [provider]: next },
  });
}

/**
 * Synthesises real `ProviderKey` entries for any provider that still has a
 * legacy `<provider>Token` set but no `keys[provider]` entries. Returns
 * `{ changed, next }`; the caller (typically `loadGlobalConfig`) persists
 * `next` only when `changed` is true. Legacy fields are *not* removed —
 * downgrading to an older factory build keeps working.
 */
export function migrateLegacyKeys(cfg: Config): { changed: boolean; next: Config } {
  const nextKeys: Record<string, ProviderKey[]> = { ...(cfg.keys ?? {}) };
  let changed = false;
  for (const provider of Object.keys(LEGACY_TOKEN_KEY)) {
    const haveStored = nextKeys[provider] && nextKeys[provider].length > 0;
    if (haveStored) continue;
    const token = legacyTokenFor(cfg, provider);
    if (!token) continue;
    const extras = legacyExtrasFor(cfg, provider);
    nextKeys[provider] = [{
      id: randomUUID(),
      label: 'default',
      token,
      createdAt: new Date().toISOString(),
      ...(extras ? { extras } : {}),
    }];
    changed = true;
  }
  if (!changed) return { changed: false, next: cfg };
  return { changed: true, next: { ...cfg, keys: nextKeys } };
}
