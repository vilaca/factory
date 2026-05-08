import chalk from 'chalk';
import type { Config, GoogleAiStudioAuthMode } from '../core/config-types.js';
import type { ProviderDescriptor, StartupProviderName } from '../providers/descriptors.js';
import {
  DESCRIPTOR_LIST,
  noModelsMessageFor,
  resolveToken,
  saveSuccessMessageFor,
} from '../providers/descriptors.js';
import { createProvider, type CreateProviderOptions } from '../providers/registry.js';
import { getGlobalConfigDir, loadConfig, saveGlobalConfig } from '../core/config.js';
import { addKey, getKey } from '../core/credentials.js';
import { appendProviderLog } from '../core/session-log.js';
import { getCopilotAuthStorageNote, CopilotAuthManager } from '../providers/copilot-auth.js';
import {
  GoogleAiStudioAuthManager,
  getGoogleAiStudioOAuthErrorMessage,
  getGoogleAiStudioOAuthStorageNote,
} from '../providers/googleaistudio-auth.js';
import { exitStartupSelection, isExitSelection, promptText } from './prompts.js';
import { errorMessage } from '../utils/errors.js';

export interface StartupCredentials {
  token?: string;
  accountId?: string;
  authMode?: GoogleAiStudioAuthMode;
  githubToken?: string;
  /** Id of the multi-key-store entry the token came from. Undefined when
   *  the token came from CLI override / env var / a non-store auth flow
   *  (Copilot, Google AI Studio OAuth). Carried so the agent loop can stamp
   *  per-key usage stats from the very first turn. */
  keyId?: string;
}

export interface AuthResult {
  token?: string;
  accountId?: string;
  authMode?: GoogleAiStudioAuthMode;
  githubToken?: string;
  shouldSave: boolean;
  /** Optional label captured at prompt time. Carried to `addKey` when
   *  `shouldSave` is true. Phase 1 always leaves this unset. */
  keyLabel?: string;
  /** Id of the multi-key-store entry the token came from. Undefined when
   *  no stored key matched (CLI/env/new prompt that hasn't been saved yet). */
  keyId?: string;
}

function resolveGoogleAiStudioAuthMode(
  config: Config,
  cliToken?: string,
): GoogleAiStudioAuthMode | undefined {
  if (cliToken) return 'api-key';
  if (config.googleAiStudioAuthMode === 'oauth') return 'oauth';
  const apiKey =
    config.googleAiStudioToken ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (apiKey) return 'api-key';
  return undefined;
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
  // Simple-prompt providers: prefer the multi-key store (with synthetic
  // legacy fallback), but cliToken still wins, and env still wins for
  // env-precedes-config descriptors (Vercel). When nothing is stored or
  // exposed, fall through to resolveToken so env-only setups keep working.
  if (descriptor.authFlow === 'simple-prompt' && !cliToken) {
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
  const probes = DESCRIPTOR_LIST.filter(d => d.probeAtStartup).map(async descriptor => {
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
  const existing = resolveCredentialsFor(descriptor, config, cliToken, keyId);
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

async function ensureCopilotAuth(config: Config, cliToken?: string): Promise<AuthResult> {
  const copilotToken =
    cliToken ??
    config.copilotToken ??
    process.env.GITHUB_COPILOT_API_KEY ??
    process.env.COPILOT_API_KEY;
  if (copilotToken) {
    appendProviderLog({
      provider: 'copilot',
      category: 'auth',
      action: 'authenticate',
      outcome: 'success',
      detail: cliToken ? 'using token from --token' : 'using existing copilot token',
    });
    return { token: copilotToken, shouldSave: false };
  }

  if (config.githubToken) {
    appendProviderLog({
      provider: 'copilot',
      category: 'auth',
      action: 'authenticate',
      outcome: 'success',
      detail: 'using saved GitHub token',
    });
    return { githubToken: config.githubToken, shouldSave: false };
  }

  appendProviderLog({
    provider: 'copilot',
    category: 'auth',
    action: 'authenticate',
    outcome: 'started',
    detail: 'starting device flow',
  });
  console.log(chalk.cyan('  GitHub Copilot sign-in required.'));
  const auth = new CopilotAuthManager();
  await auth.authenticateWithDeviceFlow(async ({ verificationUri, userCode, expiresIn }) => {
    appendProviderLog({
      provider: 'copilot',
      category: 'auth',
      action: 'device-flow',
      outcome: 'started',
      detail: `verificationUri=${verificationUri} expiresIn=${expiresIn}s userCodeIssued=true`,
    });
    console.log(chalk.dim(`  Open ${verificationUri}`));
    console.log(chalk.dim(`  Enter code: ${chalk.bold(userCode)}`));
    console.log(chalk.dim(`  Code expires in ${Math.ceil(expiresIn / 60)} minute(s).`));
    console.log(chalk.dim(`  ${getCopilotAuthStorageNote()}`));
  });
  appendProviderLog({
    provider: 'copilot',
    category: 'auth',
    action: 'authenticate',
    outcome: 'success',
    detail: 'device flow completed and credentials saved',
  });
  console.log(
    chalk.dim(
      `  Signed in with GitHub and saved credentials to ${getGlobalConfigDir()}/config.json`,
    ),
  );
  const refreshed = await loadConfig(process.cwd(), {
    provider: undefined,
    model: undefined,
    host: undefined,
    token: undefined,
  });
  return { githubToken: refreshed.githubToken, shouldSave: false };
}

async function ensureGoogleAiStudioAuth(
  descriptor: ProviderDescriptor,
  config: Config,
  cliToken?: string,
): Promise<AuthResult> {
  const configuredMode = resolveGoogleAiStudioAuthMode(config, cliToken);
  const existingToken = resolveToken(descriptor, config, cliToken);

  if (configuredMode === 'oauth') {
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'auth',
      action: 'authenticate',
      outcome: 'started',
      detail: 'validating OAuth (ADC)',
    });
    const auth = new GoogleAiStudioAuthManager({ authMode: 'oauth' });
    await auth.validate();
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'auth',
      action: 'authenticate',
      outcome: 'success',
      detail: 'validated OAuth (ADC)',
    });
    return { authMode: 'oauth', shouldSave: false };
  }

  if (existingToken) {
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'auth',
      action: 'authenticate',
      outcome: 'success',
      detail: cliToken ? 'using token from --token' : 'using configured API key',
    });
    return { token: existingToken, authMode: 'api-key', shouldSave: false };
  }

  appendProviderLog({
    provider: 'googleaistudio',
    category: 'auth',
    action: 'authenticate',
    outcome: 'started',
    detail: 'prompting for auth method',
  });
  console.log(chalk.cyan('  Google AI Studio authentication required.'));
  console.log(chalk.cyan('    1.') + ' API key');
  console.log(chalk.cyan('    2.') + ` OAuth ${chalk.dim('(Application Default Credentials)')}`);
  console.log(chalk.cyan('    0.') + ' Exit');
  console.log(chalk.dim(`  ${getGoogleAiStudioOAuthStorageNote()}`));
  const choice = (
    await promptText(chalk.cyan('  Choose auth method (press Enter for API key, 0 to exit): '))
  ).toLowerCase();
  if (isExitSelection(choice)) exitStartupSelection();

  if (choice === '2' || choice === 'oauth') {
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'auth',
      action: 'authenticate',
      outcome: 'started',
      detail: 'selected OAuth (ADC)',
    });
    const auth = new GoogleAiStudioAuthManager({ authMode: 'oauth' });
    try {
      await auth.validate();
    } catch (error: unknown) {
      const detail = errorMessage(error) || getGoogleAiStudioOAuthErrorMessage();
      appendProviderLog({
        provider: 'googleaistudio',
        category: 'auth',
        action: 'authenticate',
        outcome: 'error',
        detail,
      });
      throw new Error(detail);
    }
    await saveGlobalConfig({ googleAiStudioAuthMode: 'oauth' });
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'auth',
      action: 'authenticate',
      outcome: 'success',
      detail: 'validated OAuth (ADC) and saved auth preference',
    });
    console.log(
      chalk.dim(`  Saved Google AI Studio auth preference to ${getGlobalConfigDir()}/config.json`),
    );
    return { authMode: 'oauth', shouldSave: false };
  }

  appendProviderLog({
    provider: 'googleaistudio',
    category: 'auth',
    action: 'authenticate',
    outcome: 'started',
    detail: 'prompting for API key',
  });
  const token = await promptText(descriptor.inputPrompt ?? '  Enter Google AI Studio API key: ', {
    secret: true,
  });
  if (!token) {
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'auth',
      action: 'authenticate',
      outcome: 'error',
      detail: 'API key was empty',
    });
    throw new Error(descriptor.missingError ?? 'Google AI Studio API key required.');
  }
  return { token, authMode: 'api-key', shouldSave: true };
}

export async function saveCredentialsAfterModelDiscovery(
  descriptor: ProviderDescriptor,
  auth: AuthResult,
  modelsAvailable: boolean,
): Promise<string | undefined> {
  if (!auth.shouldSave) return undefined;
  if (!descriptor.configTokenKey) return undefined;

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

  // For simple-prompt providers we now write into the multi-key store so
  // adding a second key later doesn't overwrite the first. Copilot and
  // Google AI Studio keep their existing single-credential persistence —
  // their auth flows aren't multi-key-aware (device flow / OAuth).
  let savedKeyId: string | undefined;
  if (descriptor.authFlow === 'simple-prompt' && auth.token) {
    const extras =
      descriptor.needsAccountId && auth.accountId ? { accountId: auth.accountId } : undefined;
    const saved = await addKey(descriptor.name, auth.token, {
      label: auth.keyLabel,
      extras,
    });
    savedKeyId = saved.id;
  } else {
    const update: Record<string, unknown> = { [descriptor.configTokenKey]: auth.token };
    if (descriptor.needsAccountId && auth.accountId) {
      update.workersAiAccountId = auth.accountId;
    }
    if (descriptor.name === 'googleaistudio' && auth.authMode === 'api-key') {
      update.googleAiStudioAuthMode = 'api-key';
    }
    await saveGlobalConfig(update);
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
