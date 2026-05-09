import React from 'react';
import { useApp, render } from 'ink';
import type { RecentSession } from '../../core/session/session-log.js';
import type { StartupProviderName } from '../../providers/registry.js';
import type { Provider } from '../../providers/types.js';
import type { PickerOption } from '../picker.js';
import { exitStartupSelection } from '../prompts.js';
import {
  ProviderPicker,
  type ProviderEntry,
  type RecentPair,
} from '../../ui/tui/components/provider-picker/index.js';
import { buildPickerInfo } from '../../ui/tui/components/provider-picker/build-info.js';

interface StartupSelection {
  provider: StartupProviderName;
  /** Set when the user picked a recent (provider, model) pair directly. */
  model?: string;
  /** Set when that recent pair was tied to a specific saved key. */
  keyId?: string;
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

  // The unified picker drives provider → loadModels → model. At startup
  // we want to commit after the provider stage (so the main flow can
  // run ensureAuth before model selection). The shim does that by
  // converting the loadModels invocation into an immediate
  // `{ provider, model: undefined }` resolution.
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
  return (
    <ProviderPicker
      providers={providers}
      recents={recents}
      initialProvider={initialProvider}
      initialModel={initialModel}
      loadModels={name => {
        // The picker only invokes loadModels after a provider-stage
        // Enter — that's our cue to commit and hand off to the main
        // flow's ensureAuth + selectModelInk. Use a never-resolving
        // promise so we don't race with Ink's unmount and trigger a
        // setState on the loading stage after exit.
        finish({ provider: name as StartupProviderName });
        return new Promise<string[]>(() => {
          /* unmounted */
        });
      }}
      onCommit={(provider, model, keyId) => {
        // Reachable only when the user picked from the recent list.
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
