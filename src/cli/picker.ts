import type { Config } from '../core/config-types.js';
import type { ProviderDescriptor, StartupProviderName } from '../providers/descriptors.js';
import { DESCRIPTORS, DESCRIPTOR_LIST } from '../providers/descriptors.js';
import { probeModels, type StartupCredentials } from './auth.js';

export interface PickerOption {
  descriptor: ProviderDescriptor;
  models?: string[];
  /** True when a `when-reachable` provider failed its probe — surfaced in
   * the picker as a dimmed "(offline)" entry instead of being hidden. */
  offline?: boolean;
}

export function buildPickerOptions(
  probedModels: Map<StartupProviderName, string[] | null>,
): PickerOption[] {
  return DESCRIPTOR_LIST.map(descriptor => {
    const models = probedModels.get(descriptor.name) ?? null;
    const offline = descriptor.showInPicker === 'when-reachable' && !models;
    return { descriptor, models: models ?? undefined, offline };
  }).sort((a, b) => a.descriptor.label.localeCompare(b.descriptor.label));
}

export async function findDefaultSelection(
  lastSession: { provider: string; model: string } | null,
  probedModels: Map<StartupProviderName, string[] | null>,
  config: Config,
  credentials: Map<StartupProviderName, StartupCredentials>,
): Promise<{ provider: StartupProviderName; model?: string } | undefined> {
  if (!lastSession) return undefined;
  const descriptor = (DESCRIPTORS as Record<string, ProviderDescriptor | undefined>)[
    lastSession.provider
  ];
  if (!descriptor) return undefined;

  let models = probedModels.get(descriptor.name) ?? null;
  if (!models && !descriptor.probeAtStartup) {
    const creds = credentials.get(descriptor.name) ?? {};
    if (creds.token || creds.githubToken) {
      models = await probeModels(descriptor.name, {
        host: config.host,
        token: creds.token,
        githubToken: creds.githubToken,
        accountId: creds.accountId,
        googleAiStudioAuthMode: creds.authMode,
      });
    }
  }

  if (models?.includes(lastSession.model)) {
    return { provider: descriptor.name, model: lastSession.model };
  }
  return undefined;
}
