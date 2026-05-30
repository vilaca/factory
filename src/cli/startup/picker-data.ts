import { createProvider, DESCRIPTOR_LIST, descriptorByAlias } from '../../providers/registry.js';
import { loadGlobalConfig } from '../../core/config/index.js';
import { addKey, keyFingerprint, listKeys } from '../../core/auth/credentials.js';
import { errorMessage } from '../../utils/errors.js';

const SIMPLE_PROMPT_PROVIDERS = new Set(
  DESCRIPTOR_LIST.filter(d => d.authFlow === 'simple-prompt').map(d => d.name),
);

export interface StartupPickerDataSource {
  multiKeyProviders: ReadonlySet<string>;
  loadModels: (name: string, keyId?: string) => Promise<string[]>;
  loadKeysForProvider: (
    name: string,
  ) => Promise<Array<{ id: string; label?: string; fingerprint: string }>>;
  validateKey: (
    name: string,
    token: string,
  ) => Promise<{ ok: boolean; models?: string[]; error?: string }>;
  saveKey: (name: string, token: string) => Promise<string>;
}

/**
 * Startup picker data layer.
 *
 * Separates provider/key model fetching and persistence from the Ink view
 * wiring in `menu.tsx` so startup rendering remains display-focused.
 */
export function createStartupPickerDataSource(): StartupPickerDataSource {
  return {
    multiKeyProviders: SIMPLE_PROMPT_PROVIDERS,
    loadModels: async (name, keyId) => {
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
      const provider = createProvider(name, opts);
      return await provider.listModels();
    },
    loadKeysForProvider: async name => {
      const cfg = await loadGlobalConfig();
      const descriptor = descriptorByAlias(name);
      if (!descriptor) return [];
      return listKeys(cfg, descriptor.name).map(k => ({
        id: k.id,
        ...(k.label ? { label: k.label } : {}),
        fingerprint: keyFingerprint(k.token),
      }));
    },
    validateKey: async (name, token) => {
      try {
        const descriptor = descriptorByAlias(name);
        const opts: Parameters<typeof createProvider>[1] = { token };
        if (descriptor?.needsAccountId) {
          const cfg = await loadGlobalConfig();
          opts.accountId = cfg.workersAiAccountId;
        }
        const provider = createProvider(name, opts);
        const models = await provider.listModels();
        return { ok: true, models };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    saveKey: async (name, token) => {
      const descriptor = descriptorByAlias(name);
      if (!descriptor) throw new Error(`Unknown provider: ${name}`);
      const cfg = descriptor.needsAccountId ? await loadGlobalConfig() : null;
      const extras =
        descriptor.needsAccountId && cfg?.workersAiAccountId
          ? { accountId: cfg.workersAiAccountId }
          : undefined;
      const entry = await addKey(descriptor.name, token, {
        ...(extras ? { extras } : {}),
      });
      return entry.id;
    },
  };
}
