import chalk from 'chalk';
import type { Config } from '../../core/config/types.js';
import type { ProviderDescriptor, StartupProviderName } from '../../providers/registry.js';
import {
  DESCRIPTOR_LIST,
  noModelsMessageFor,
  resolveToken,
  saveSuccessMessageFor,
} from '../../providers/registry.js';
import { createProvider, type CreateProviderOptions } from '../../providers/registry.js';
import { getGlobalConfigDir, loadConfig, saveGlobalConfig } from '../../core/config/index.js';
import { addKey, getKey } from '../../core/auth/credentials.js';
import { appendProviderLog } from '../../utils/provider-log.js';
import { promptText } from '../prompts.js';
import {
  ensureCopilotAuth,
  ensureGoogleAiStudioAuth,
  resolveGoogleAiStudioAuthMode,
} from './flows.js';

import type { StartupCredentials, AuthResult } from './types.js';
export type { StartupCredentials, AuthResult };

function resolveSimplePromptCredentials(
  descriptor: ProviderDescriptor,
  config: Config,
  cliToken: string | undefined,
  keyId: string | undefined,
): StartupCredentials {
  if (!cliToken) {
    const key = getKey(config, descriptor.name, keyId);
    if (key) {
      if (descriptor.envPrecedesConfig) {
        for (const envVar of descriptor.envVars ?? []) {
          const fromEnv = process.env[envVar];
          if (fromEnv) {
            // Env wins over the stored token, so usage stats can't be
            // attributed to the stored key — leave keyId unset.
            return {
              token: fromEnv,
              accountId: descriptor.needsAccountId
                ? (key.extras?.accountId ?? config.workersAiAccountId)
                : undefined,
            };
          }
        }
      }
      return {
        token: key.token,
        keyId: key.id,
        accountId: descriptor.needsAccountId
          ? (key.extras?.accountId ?? config.workersAiAccountId)
          : undefined,
      };
    }
  }
  const fromEnv = (descriptor.envVars ?? []).map(name => process.env[name]).find(Boolean);
  return {
    token: cliToken ?? fromEnv,
    accountId: descriptor.needsAccountId ? config.workersAiAccountId : undefined,
  };
}

export function resolveCredentialsFor(
  descriptor: ProviderDescriptor,
  config: Config,
  cliToken?: string,
  keyId?: string,
): StartupCredentials {
  if (descriptor.name === 'googleaistudio') {
    const authMode = resolveGoogleAiStudioAuthMode(config, cliToken);
    return {
      authMode,
      token: authMode === 'api-key' ? resolveToken(descriptor, config, cliToken) : undefined,
    };
  }
  if (descriptor.name === 'copilot') {
    return {
      token:
        cliToken ??
        config.copilotToken ??
        process.env.GITHUB_COPILOT_API_KEY ??
        process.env.COPILOT_API_KEY,
      githubToken: config.githubToken,
    };
  }
  // Simple-prompt providers: prefer the multi-key store. cliToken still
  // wins, and env still wins for env-precedes-config descriptors (Vercel).
  // When no key is stored, fall back to env vars only.
  if (descriptor.authFlow === 'simple-prompt') {
    return resolveSimplePromptCredentials(descriptor, config, cliToken, keyId);
  }
  return {
    token: resolveToken(descriptor, config, cliToken),
    accountId: descriptor.needsAccountId ? config.workersAiAccountId : undefined,
  };
}

function canProbe(descriptor: ProviderDescriptor, creds: StartupCredentials): boolean {
  if (descriptor.probeWithoutCredentials) return true;
  if (descriptor.name === 'googleaistudio' && !creds.authMode) return false;
  if (descriptor.name === 'copilot' && !creds.token && !creds.githubToken) return false;
  if (descriptor.name !== 'googleaistudio' && descriptor.name !== 'copilot' && !creds.token)
    return false;
  if (descriptor.needsAccountId && !creds.accountId) return false;
  return true;
}

export async function probeModels(
  providerName: string,
  options: CreateProviderOptions,
): Promise<string[] | null> {
  try {
    const provider = createProvider(providerName, options);
    return await provider.listModels();
  } catch {
    return null;
  }
}

export async function probeAllProviders(
  config: Config,
  credentials: Map<StartupProviderName, StartupCredentials>,
): Promise<Map<StartupProviderName, string[] | null>> {
  // Include device-flow providers (e.g. copilot) when credentials are already
  // saved — this lets canResumeLastSession fast-path startup without showing
  // the picker. Providers without credentials are still skipped via canProbe.
  const probes = DESCRIPTOR_LIST.filter(
    d => d.probeAtStartup || canProbe(d, credentials.get(d.name as StartupProviderName) ?? {}),
  ).map(async descriptor => {
    const creds = credentials.get(descriptor.name) ?? {};
    if (!canProbe(descriptor, creds)) {
      return [descriptor.name, null] as const;
    }
    const models = await probeModels(descriptor.name, {
      host: config.host,
      token: creds.token,
      githubToken: creds.githubToken,
      accountId: creds.accountId,
      googleAiStudioAuthMode: creds.authMode,
    });
    return [descriptor.name, models] as const;
  });
  return new Map(await Promise.all(probes));
}

export async function ensureAuth(
  descriptor: ProviderDescriptor,
  config: Config,
  cliToken?: string,
  keyId?: string,
): Promise<AuthResult> {
  switch (descriptor.authFlow) {
    case 'none':
      return { shouldSave: false };
    case 'simple-prompt':
      return ensureSimplePromptAuth(descriptor, config, cliToken, keyId);
    case 'device-flow':
      return ensureCopilotAuth(config, cliToken);
    case 'oauth-or-key':
      return ensureGoogleAiStudioAuth(descriptor, config, cliToken);
  }
}

async function ensureSimplePromptAuth(
  descriptor: ProviderDescriptor,
  config: Config,
  cliToken?: string,
  keyId?: string,
): Promise<AuthResult> {
  let existing = resolveCredentialsFor(descriptor, config, cliToken, keyId);

  // Startup picker can persist a brand-new key moments before this phase runs.
  // The caller may still hold a pre-picker config snapshot, so a targeted
  // key lookup by id can miss even though the key is now on disk. When a
  // specific keyId was requested and the current snapshot can't resolve it,
  // re-read global config once and retry before falling back to prompting.
  if (keyId && !cliToken && !existing.token) {
    const fresh = await loadConfig(process.cwd());
    existing = resolveCredentialsFor(descriptor, { ...config, ...fresh }, cliToken, keyId);
  }

  const haveToken = Boolean(existing.token);
  const needAccountId = Boolean(descriptor.needsAccountId);
  const haveAccountId = Boolean(existing.accountId);

  if (haveToken && (!needAccountId || haveAccountId)) {
    appendProviderLog({
      provider: descriptor.name,
      category: 'auth',
      action: 'authenticate',
      outcome: 'success',
      detail: cliToken ? 'using token from --token' : 'using configured API key',
    });
    // existing.keyId is set when the token came from the multi-key store —
    // spreading it through to AuthResult lets the agent loop attribute the
    // first turn's success/failure back to the right entry.
    return { ...existing, shouldSave: false };
  }

  appendProviderLog({
    provider: descriptor.name,
    category: 'auth',
    action: 'authenticate',
    outcome: 'started',
    detail:
      needAccountId && !haveToken
        ? 'prompting for API token and account id'
        : 'prompting for API key',
  });

  if (descriptor.promptHeader) {
    console.log(chalk.cyan(`  ${descriptor.promptHeader}`));
  }

  const token =
    existing.token ??
    (await promptText(descriptor.inputPrompt ?? '  Enter API key: ', { secret: true }));
  if (!token) {
    appendProviderLog({
      provider: descriptor.name,
      category: 'auth',
      action: 'authenticate',
      outcome: 'error',
      detail: needAccountId ? 'API token was empty' : 'API key was empty',
    });
    throw new Error(descriptor.missingError ?? 'API key required.');
  }

  let accountId = existing.accountId;
  if (needAccountId && !accountId) {
    accountId = await promptText(descriptor.accountIdInputPrompt ?? '  Enter account ID: ');
    if (!accountId) {
      appendProviderLog({
        provider: descriptor.name,
        category: 'auth',
        action: 'authenticate',
        outcome: 'error',
        detail: 'account ID was empty',
      });
      throw new Error(descriptor.accountIdMissingError ?? 'Account ID required.');
    }
  }

  return {
    token,
    accountId,
    shouldSave: !haveToken || (needAccountId && !haveAccountId),
  };
}

export async function saveCredentialsAfterModelDiscovery(
  descriptor: ProviderDescriptor,
  auth: AuthResult,
  modelsAvailable: boolean,
): Promise<string | undefined> {
  if (!auth.shouldSave) return undefined;

  const credentialsLabel = descriptor.needsAccountId ? 'credentials' : 'API key';
  const successDetail = descriptor.needsAccountId
    ? 'saved API token and account id after successful model discovery'
    : 'saved API key after successful model discovery';
  const skipDetail = descriptor.needsAccountId
    ? 'no models available; credentials not saved'
    : `no models available; ${credentialsLabel} not saved`;

  if (!modelsAvailable) {
    appendProviderLog({
      provider: descriptor.name,
      category: 'auth',
      action: 'save-credentials',
      outcome: 'skipped',
      detail: skipDetail,
    });
    console.log(chalk.dim(`  ${noModelsMessageFor(descriptor)}`));
    return undefined;
  }

  // Simple-prompt providers write into the multi-key store so adding a
  // second key later doesn't overwrite the first.
  // Google AI Studio api-key flow persists the token to its named config
  // field (googleAiStudioToken) so resolveGoogleAiStudioAuthMode can read it.
  // Copilot (device-flow) handles its own persistence in flows.ts.
  let savedKeyId: string | undefined;
  if (descriptor.authFlow === 'simple-prompt' && auth.token) {
    const extras =
      descriptor.needsAccountId && auth.accountId ? { accountId: auth.accountId } : undefined;
    const saved = await addKey(descriptor.name, auth.token, {
      label: auth.keyLabel,
      extras,
    });
    savedKeyId = saved.id;
  } else if (descriptor.name === 'googleaistudio' && auth.token) {
    await saveGlobalConfig({
      googleAiStudioToken: auth.token,
      ...(auth.authMode === 'api-key' ? { googleAiStudioAuthMode: 'api-key' } : {}),
    });
  }
  appendProviderLog({
    provider: descriptor.name,
    category: 'auth',
    action: 'save-credentials',
    outcome: 'success',
    detail: successDetail,
  });
  console.log(chalk.dim(`  ${saveSuccessMessageFor(descriptor, getGlobalConfigDir())}`));
  return savedKeyId;
}
