import React from 'react';
import { useApp, render } from 'ink';
import type { RecentSession } from '../../core/session/session-log.js';
import { createProvider, DESCRIPTOR_LIST, descriptorByAlias } from '../../providers/registry.js';
import type { StartupProviderName } from '../../providers/registry.js';
import type { Provider } from '../../providers/types.js';
import type { PickerOption } from '../picker.js';
import { loadGlobalConfig } from '../../core/config/index.js';
import { addKey, keyFingerprint, listKeys } from '../../core/auth/credentials.js';
import { errorMessage } from '../../utils/errors.js';
import { exitStartupSelection } from '../prompts.js';
import {
  ProviderPicker,
  type ProviderEntry,
  type RecentPair,
} from '../../ui/tui/components/provider-picker/index.js';
import { buildPickerInfo } from '../../ui/tui/components/provider-picker/build-info.js';
import type { ModelSelection } from '../../core/selection/types.js';

/** Startup-time variant of ModelSelection: provider is narrowed to the
 *  set of providers eligible for startup, and model is optional (a
 *  no-model selection means "land on this provider but don't pick a
 *  model yet — fall back to default"). Inherits keyId and any future
 *  cross-cutting fields from ModelSelection so 550f093-style hop drops
 *  become impossible. */
interface StartupSelection extends Omit<ModelSelection, 'provider' | 'model'> {
  provider: StartupProviderName;
  model?: string;
}

const SIMPLE_PROMPT_PROVIDERS = new Set(
  DESCRIPTOR_LIST.filter(d => d.authFlow === 'simple-prompt').map(d => d.name),
);

export function createStartupPickerKeyProps(): {
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
} {
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
      const p = createProvider(name, opts);
      return await p.listModels();
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
        const p = createProvider(name, opts);
        const models = await p.listModels();
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

export async function selectStartupSession(
  recentSessions: RecentSession[],
  providerOptions: PickerOption[],
  defaultSelection?: { provider: StartupProviderName; model?: string },
): Promise<StartupSelection> {
  const debug = process.env.FACTORY_DEBUG === '1';
  const dbg = (msg: string): void => {
    if (debug) process.stderr.write(`[factory:debug] startup-menu: ${msg}\n`);
  };

  const recents: RecentPair[] = recentSessions.map(s => ({
    provider: s.provider,
    model: s.model,
    ...(s.status ? { status: s.status } : {}),
    ...(s.keyId ? { keyId: s.keyId } : {}),
  }));
  const providers: ProviderEntry[] = providerOptions.map(o => ({
    name: o.descriptor.name,
    label: o.descriptor.label,
    offline: o.offline,
  }));

  // The startup shim uses the same picker as the in-session flow, including
  // key management for simple-prompt providers. The result can therefore be
  // either a provider-only choice (user backed out before model selection)
  // or a full provider/key/model tuple.
  let result: StartupSelection | null = null;
  const inkApp = render(
    <StartupShim
      recents={recents}
      providers={providers}
      initialProvider={defaultSelection?.provider}
      initialModel={defaultSelection?.model}
      onResolve={sel => {
        dbg(`onResolve sel=${JSON.stringify(sel)}`);
        result = sel;
      }}
    />,
  );
  dbg('rendered, waiting for exit');
  await inkApp.waitUntilExit();
  dbg(`waitUntilExit resolved, result=${JSON.stringify(result)}`);
  inkApp.unmount();
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(false);
  }
  process.stdin.resume();
  dbg('stdin restored, returning');
  if (result === null) exitStartupSelection();
  return result;
}

interface StartupShimProps {
  recents: RecentPair[];
  providers: ProviderEntry[];
  initialProvider?: string;
  initialModel?: string;
  onResolve: (sel: StartupSelection | null) => void;
}

function StartupShim({
  recents,
  providers,
  initialProvider,
  initialModel,
  onResolve,
}: StartupShimProps): React.ReactElement {
  const { exit } = useApp();
  const finish = (sel: StartupSelection | null): void => {
    onResolve(sel);
    exit();
  };
  const keyProps = createStartupPickerKeyProps();
  return (
    <ProviderPicker
      providers={providers}
      recents={recents}
      initialProvider={initialProvider}
      initialModel={initialModel}
      {...keyProps}
      onCommit={(provider, model, keyId) => {
        // Reached from recent picks and from the full provider→key→model flow.
        finish({
          provider: provider as StartupProviderName,
          model,
          ...(keyId ? { keyId } : {}),
        });
      }}
      onCancel={() => finish(null)}
      bordered={false}
    />
  );
}

interface ModelMenuAppProps {
  models: string[];
  defaultModel: string | null;
  provider?: Provider;
  providerName: string;
  onResolve: (model: string | null) => void;
}

function ModelMenuApp(props: ModelMenuAppProps): React.ReactElement {
  const { models, defaultModel, provider, providerName, onResolve } = props;
  const { exit } = useApp();
  const finish = (m: string | null): void => {
    onResolve(m);
    exit();
  };
  return (
    <ProviderPicker
      providers={[]}
      recents={[]}
      models={models}
      initialProvider={providerName}
      initialModel={defaultModel ?? undefined}
      startStage="model"
      loadModels={async () => models}
      getModelInfo={(_, m) => (provider ? buildPickerInfo(provider, m) : undefined)}
      onCommit={(_, model) => finish(model)}
      onCancel={() => finish(null)}
      bordered={false}
    />
  );
}

export async function selectModelInk(
  models: string[],
  defaultModel: string | null,
  provider?: Provider,
  providerName: string = '',
): Promise<string> {
  if (models.length === 0) {
    throw new Error('No models available.');
  }
  if (models.length === 1) return models[0]!;

  const debug = process.env.FACTORY_DEBUG === '1';
  const dbg = (msg: string): void => {
    if (debug) process.stderr.write(`[factory:debug] model-menu: ${msg}\n`);
  };

  let result: string | null = null;
  const inkApp = render(
    <ModelMenuApp
      models={models}
      defaultModel={defaultModel}
      provider={provider}
      providerName={providerName}
      onResolve={m => {
        dbg(`onResolve model=${m ?? '<exit>'}`);
        result = m;
      }}
    />,
  );
  dbg(`rendered ${models.length} models`);
  await inkApp.waitUntilExit();
  dbg(`waitUntilExit resolved, result=${result ?? '<null>'}`);
  inkApp.unmount();
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(false);
  }
  process.stdin.resume();
  if (result === null) exitStartupSelection();
  return result;
}
