import type { Provider } from '../../providers/types.js';
import type { ProviderDescriptor, StartupProviderName } from '../../providers/registry.js';
import { DESCRIPTORS, descriptorByAlias, createProvider } from '../../providers/registry.js';
import { prime } from '../../providers/prime.js';
import type { Config } from '../../core/config/types.js';
import { appendProviderLog } from '../../utils/provider-log.js';
import { renderError } from '../../ui/renderer.js';
import { errorMessage } from '../../utils/errors.js';
import { dbg } from '../../utils/debug.js';
import type { CliArgs } from '../args.js';
import {
  ensureAuth,
  saveCredentialsAfterModelDiscovery,
  type AuthResult,
} from '../auth/index.js';

export interface ConnectedProvider {
  provider: Provider;
  descriptor?: ProviderDescriptor;
  availableModels: string[] | null;
  activeKeyId?: string;
}

/**
 * Run the auth flow for the selected provider, build the Provider, list
 * models, and persist credentials when the auth flow asked us to. Calls
 * `process.exit(1)` on failure with a provider-specific error message.
 */
export async function authenticateAndConnect(
  providerName: string,
  config: Config,
  cliArgs: CliArgs,
  resumeKeyId: string | undefined,
  probedModels: Map<StartupProviderName, string[] | null>,
): Promise<ConnectedProvider> {
  const descriptor =
    descriptorByAlias(providerName) ??
    (DESCRIPTORS as Record<string, ProviderDescriptor | undefined>)[providerName];
  let availableModels: string[] | null = descriptor
    ? (probedModels.get(descriptor.name) ?? null)
    : null;
  let activeKeyId: string | undefined;
  let provider: Provider;
  try {
    dbg(
      `ensureAuth flow=${descriptor?.authFlow ?? 'no-descriptor'}${resumeKeyId ? ` keyId=${resumeKeyId}` : ''}`,
    );
    const auth: AuthResult = descriptor
      ? await ensureAuth(descriptor, config, cliArgs.token, resumeKeyId)
      : { shouldSave: false };
    dbg(`ensureAuth ok shouldSave=${auth.shouldSave}`);

    const unprimed = createProvider(providerName, {
      host: config.host,
      token: auth.token,
      githubToken: auth.githubToken,
      googleAiStudioAuthMode: auth.authMode,
      accountId: auth.accountId,
    });
    dbg(`createProvider ok`);

    // Prime the provider before any getCapabilities/chat consumer
    // touches it. `prime()` always calls listModels (authoritative cache
    // populator) and returns the resulting model list — the earlier
    // probe's `probedModels` may be stale or missing, so we trust the
    // priming call. This costs one extra HTTP call relative to the
    // pre-prime() code path that skipped re-listing when probedModels
    // was populated, but it eliminates the cf880ed bug class at this
    // call site by construction.
    dbg(`prime (listModels + optional primeModelCache)`);
    const primed = await prime(unprimed);
    provider = primed.provider;
    availableModels = primed.models;
    dbg(`availableModels.length=${availableModels?.length ?? 0}`);

    activeKeyId = auth.keyId;
    if (descriptor) {
      const savedKeyId = await saveCredentialsAfterModelDiscovery(
        descriptor,
        auth,
        availableModels.length > 0,
      );
      // First-time-save path: addKey just minted a fresh id. Adopt it so
      // the first turn's stats land under the right key.
      if (savedKeyId) activeKeyId = savedKeyId;
    }
  } catch (err: unknown) {
    const msg = errorMessage(err);
    dbg(`startup error: ${msg}`);
    appendProviderLog({
      provider: providerName,
      category: 'startup',
      action: 'startup-error',
      outcome: 'error',
      detail: msg,
    });
    if (providerName === 'ollama') {
      console.log(renderError('Cannot connect to Ollama. Is it running? (ollama serve)'));
    } else if (providerName === 'llamacpp') {
      console.log(
        renderError(
          'Cannot connect to llama.cpp. Is the server running? (llama-server -m <model>)',
        ),
      );
    } else {
      console.log(renderError(msg));
    }
    process.exit(1);
  }
  return {
    provider,
    ...(descriptor ? { descriptor } : {}),
    availableModels,
    ...(activeKeyId ? { activeKeyId } : {}),
  };
}
