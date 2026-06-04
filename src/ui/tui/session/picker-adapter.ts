import type React from 'react';
import type { Provider } from '../../../providers/types.js';
import { buildPickerInfo } from '../components/provider-picker/build-info.js';
import { loadGlobalConfig } from '../../../core/config/index.js';
import { descriptorByAlias, createProvider } from '../../../providers/registry.js';
import {
  addKey as addCredentialKey,
  deleteKey as deleteCredentialKey,
  keyFingerprint,
  listKeys,
} from '../../../core/auth/credentials.js';
import { prime } from '../../../providers/prime.js';
import { errorMessage } from '../../../utils/errors.js';

function findCachedProvider(cache: Map<string, Provider>, name: string): Provider | undefined {
  const prefix = `${name}\0`;
  for (const [key, value] of cache) {
    if (key.startsWith(prefix)) return value;
  }
  return undefined;
}

interface BuildPickerAdapterArgs {
  pickerProviderCache: React.MutableRefObject<Map<string, Provider>>;
  providerName: string;
  propsProvider: Provider;
  refsProvider?: Provider;
}

export function buildPickerAdapter(args: BuildPickerAdapterArgs) {
  const { pickerProviderCache, providerName, propsProvider, refsProvider } = args;

  return {
    getModelInfo: (prov: string, m: string) => {
      const cached = findCachedProvider(pickerProviderCache.current, prov);
      const source =
        cached ?? (prov === providerName ? (refsProvider ?? propsProvider) : undefined);
      return source ? buildPickerInfo(source, m) : undefined;
    },
    loadModels: async (name: string, keyId?: string) => {
      const cfg = keyId ? await loadGlobalConfig() : null;
      const descriptor = descriptorByAlias(name);
      const opts: Parameters<typeof createProvider>[1] = {};
      if (cfg && descriptor && keyId) {
        const list = listKeys(cfg, descriptor.name);
        const key = list.find(k => k.id === keyId);
        if (key) {
          opts.token = key.token;
          if (descriptor.needsAccountId && key.extras?.accountId) {
            opts.accountId = key.extras.accountId;
          }
        }
      }
      const unprimed = createProvider(name, opts);
      const { provider: p, models } = await prime(unprimed);
      pickerProviderCache.current.set(`${name}\0${keyId ?? ''}`, p);
      return models;
    },
    loadKeysForProvider: async (name: string) => {
      const cfg = await loadGlobalConfig();
      const descriptor = descriptorByAlias(name);
      if (!descriptor) return [];
      const { listStatsForProvider } = await import('../../../core/session/key-stats.js');
      const stats = await listStatsForProvider(descriptor.name);
      return listKeys(cfg, descriptor.name).map(k => {
        const s = stats[k.id];
        const ok = s?.successCount ?? 0;
        const warn = (s?.rateLimitCount ?? 0) + (s?.authErrorCount ?? 0);
        return {
          id: k.id,
          ...(k.label ? { label: k.label } : {}),
          fingerprint: keyFingerprint(k.token),
          ...(ok > 0 || warn > 0 ? { stats: { ok, warn } } : {}),
        };
      });
    },
    validateKey: async (name: string, token: string) => {
      try {
        const descriptor = descriptorByAlias(name);
        const opts: Parameters<typeof createProvider>[1] = { token };
        if (descriptor?.needsAccountId) {
          const cfg = await loadGlobalConfig();
          opts.accountId = cfg.workersAiAccountId;
        }
        const p = createProvider(name, opts);
        const models = await p.listModels();
        return { ok: true, models };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    saveKey: async (name: string, token: string) => {
      const descriptor = descriptorByAlias(name);
      if (!descriptor) throw new Error(`Unknown provider: ${name}`);
      const cfg = descriptor.needsAccountId ? await loadGlobalConfig() : null;
      const extras =
        descriptor.needsAccountId && cfg?.workersAiAccountId
          ? { accountId: cfg.workersAiAccountId }
          : undefined;
      const entry = await addCredentialKey(descriptor.name, token, {
        ...(extras ? { extras } : {}),
      });
      return entry.id;
    },
    deleteKey: async (name: string, keyId: string) => {
      const descriptor = descriptorByAlias(name);
      if (!descriptor) return;
      await deleteCredentialKey(descriptor.name, keyId);
    },
  };
}
