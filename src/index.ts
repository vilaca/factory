#!/usr/bin/env node

import readline from 'readline';
import chalk from 'chalk';
import type { Config, GoogleAiStudioAuthMode } from './core/config-types.js';
import type { ModelPickerInfo, Provider } from './providers/types.js';
import type { ProviderDescriptor, StartupProviderName } from './providers/descriptors.js';
import {
  DESCRIPTORS,
  DESCRIPTOR_LIST,
  descriptorByAlias,
  noModelsMessageFor,
  resolveToken,
  saveSuccessMessageFor,
} from './providers/descriptors.js';
import { createProvider, type CreateProviderOptions } from './providers/registry.js';
import { getGlobalConfigDir, loadConfig, saveGlobalConfig } from './core/config.js';
import { McpManager } from './mcp/client.js';
import { defaultRegistry } from './tools/index.js';
import { Repl } from './ui/repl.js';
import { renderApp } from './ui/ink/index.js';
import { buildSystemPrompt } from './core/system-prompt.js';
import { validateModelToolSupport } from './core/model-validation.js';
import { appendProviderLog, getLastSessionSelection, sessionsDir } from './core/session-log.js';
import { renderWelcome, renderModelList, renderError } from './ui/renderer.js';
import { getCopilotAuthStorageNote, CopilotAuthManager } from './providers/copilot-auth.js';
import {
  GoogleAiStudioAuthManager,
  getGoogleAiStudioOAuthErrorMessage,
  getGoogleAiStudioOAuthStorageNote,
} from './providers/googleaistudio-auth.js';
import { getGitBranch, isGitDirty } from './utils/git.js';

interface ModelChoice {
  value: string;
  label: string;
  detail?: string;
  warning?: string;
}

function isExitSelection(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '0' || normalized === 'q' || normalized === 'quit' || normalized === 'exit';
}

function exitStartupSelection(): never {
  console.log(chalk.dim('  Exiting.'));
  process.exit(0);
}

async function selectModel(models: string[], defaultModel?: string | null, provider?: Provider): Promise<string> {
  // TODO: Evaluate whether the picker should prefer a maintained whitelist of
  // models known to work well by default, while still letting users pick any
  // other discovered model "at their own risk". This could improve UX, but it
  // would add ongoing whitelist maintenance cost across providers.
  const choices: ModelChoice[] = models.map(model => {
    const pickerInfo: ModelPickerInfo | undefined = provider?.getModelPickerInfo?.(model);
    return {
      value: model,
      label: pickerInfo?.label ?? provider?.getDisplayModelName?.(model) ?? model,
      detail: pickerInfo?.detail,
      warning: pickerInfo?.warning,
    };
  });

  if (choices.length === 0) {
    console.log(renderError('No models available.'));
    process.exit(1);
  }

  if (choices.length === 1) {
    return choices[0].value;
  }

  console.log(renderModelList(choices));
  console.log(chalk.cyan('    0.') + ' Exit');

  const hasDefault = defaultModel ? choices.some(model => model.value === defaultModel) : false;
  const promptString = hasDefault
    ? chalk.cyan(`  Enter model number or name (press Enter for ${chalk.bold(defaultModel)}, 0 to exit): `)
    : chalk.cyan('  Enter model number or name (0 to exit): ');

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.question(promptString, (answer) => {
      rl.close();
      const trimmed = answer.trim();

      if (isExitSelection(trimmed)) exitStartupSelection();

      if (trimmed === '' && hasDefault) {
        resolve(defaultModel as string);
        return;
      }

      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= choices.length) {
        resolve(choices[num - 1].value);
        return;
      }

      const exact = choices.find(m => m.value === trimmed || m.label === trimmed);
      if (exact) {
        resolve(exact.value);
        return;
      }

      const lower = trimmed.toLowerCase();
      const partial = choices.find(m =>
        m.value.toLowerCase().includes(lower) || m.label.toLowerCase().includes(lower)
      );
      if (partial) {
        resolve(partial.value);
        return;
      }

      if (trimmed.includes('/')) {
        resolve(trimmed);
        return;
      }

      console.log(chalk.dim(`  Model "${trimmed}" not found, using ${choices[0].value}`));
      resolve(choices[0].value);
    });
  });
}

async function promptText(message: string, opts?: { secret?: boolean }): Promise<string> {
  return new Promise((resolve) => {
    const output = process.stdout;
    const rl = readline.createInterface({ input: process.stdin, output });
    const masked = rl as readline.Interface & { _writeToOutput?: (value: string) => void };
    const originalWrite = masked._writeToOutput?.bind(masked);
    if (opts?.secret) {
      masked._writeToOutput = function (value: string): void {
        if (value.startsWith(message)) {
          output.write(value);
          return;
        }
        if (value === '\r\n' || value === '\n') {
          output.write(value);
          return;
        }
        output.write('*');
      };
    }

    rl.question(message, (answer) => {
      masked._writeToOutput = originalWrite;
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Credential resolution ─────────────────────────────────────────────

interface StartupCredentials {
  token?: string;
  accountId?: string;
  authMode?: GoogleAiStudioAuthMode;
  githubToken?: string;
}

function resolveGoogleAiStudioAuthMode(config: Config, cliToken?: string): GoogleAiStudioAuthMode | undefined {
  if (cliToken) return 'api-key';
  if (config.googleAiStudioAuthMode === 'oauth') return 'oauth';
  const apiKey = config.googleAiStudioToken
    ?? process.env.GEMINI_API_KEY
    ?? process.env.GOOGLE_API_KEY;
  if (apiKey) return 'api-key';
  return undefined;
}

function resolveCredentialsFor(
  descriptor: ProviderDescriptor,
  config: Config,
  cliToken?: string,
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
      token: cliToken
        ?? config.copilotToken
        ?? process.env.GITHUB_COPILOT_API_KEY
        ?? process.env.COPILOT_API_KEY,
      githubToken: config.githubToken,
    };
  }
  const creds: StartupCredentials = { token: resolveToken(descriptor, config, cliToken) };
  if (descriptor.needsAccountId) {
    creds.accountId = config.workersAiAccountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  }
  return creds;
}

function canProbe(descriptor: ProviderDescriptor, creds: StartupCredentials): boolean {
  if (descriptor.probeWithoutCredentials) return true;
  if (descriptor.name === 'googleaistudio' && !creds.authMode) return false;
  if (descriptor.name === 'copilot' && !creds.token && !creds.githubToken) return false;
  if (descriptor.name !== 'googleaistudio' && descriptor.name !== 'copilot' && !creds.token) return false;
  if (descriptor.needsAccountId && !creds.accountId) return false;
  return true;
}

// ─── Probing ───────────────────────────────────────────────────────────

async function probeModels(providerName: string, options: CreateProviderOptions): Promise<string[] | null> {
  try {
    const provider = createProvider(providerName, options);
    return await provider.listModels();
  } catch {
    return null;
  }
}

async function probeAllProviders(
  config: Config,
  credentials: Map<StartupProviderName, StartupCredentials>,
): Promise<Map<StartupProviderName, string[] | null>> {
  const probes = DESCRIPTOR_LIST
    .filter(d => d.probeAtStartup)
    .map(async descriptor => {
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

// ─── Auth flow dispatcher ──────────────────────────────────────────────

interface AuthResult {
  token?: string;
  accountId?: string;
  authMode?: GoogleAiStudioAuthMode;
  githubToken?: string;
  shouldSave: boolean;
}

async function ensureAuth(
  descriptor: ProviderDescriptor,
  config: Config,
  cliToken?: string,
): Promise<AuthResult> {
  switch (descriptor.authFlow) {
    case 'none':
      return { shouldSave: false };
    case 'simple-prompt':
      return ensureSimplePromptAuth(descriptor, config, cliToken);
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
): Promise<AuthResult> {
  const existing = resolveCredentialsFor(descriptor, config, cliToken);
  const haveToken = Boolean(existing.token);
  const needAccountId = Boolean(descriptor.needsAccountId);
  const haveAccountId = Boolean(existing.accountId);

  if (haveToken && (!needAccountId || haveAccountId)) {
    appendProviderLog({
      provider: descriptor.name, category: 'auth', action: 'authenticate', outcome: 'success',
      detail: cliToken ? 'using token from --token' : 'using configured API key',
    });
    return { ...existing, shouldSave: false };
  }

  appendProviderLog({
    provider: descriptor.name, category: 'auth', action: 'authenticate', outcome: 'started',
    detail: needAccountId && !haveToken ? 'prompting for API token and account id' : 'prompting for API key',
  });

  if (descriptor.promptHeader) {
    console.log(chalk.cyan(`  ${descriptor.promptHeader}`));
  }

  const token = existing.token ?? await promptText(
    descriptor.inputPrompt ?? '  Enter API key: ',
    { secret: true },
  );
  if (!token) {
    appendProviderLog({
      provider: descriptor.name, category: 'auth', action: 'authenticate', outcome: 'error',
      detail: needAccountId ? 'API token was empty' : 'API key was empty',
    });
    throw new Error(descriptor.missingError ?? 'API key required.');
  }

  let accountId = existing.accountId;
  if (needAccountId && !accountId) {
    accountId = await promptText(descriptor.accountIdInputPrompt ?? '  Enter account ID: ');
    if (!accountId) {
      appendProviderLog({
        provider: descriptor.name, category: 'auth', action: 'authenticate', outcome: 'error',
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

async function ensureCopilotAuth(
  config: Config,
  cliToken?: string,
): Promise<AuthResult> {
  const copilotToken = cliToken
    ?? config.copilotToken
    ?? process.env.GITHUB_COPILOT_API_KEY
    ?? process.env.COPILOT_API_KEY;
  if (copilotToken) {
    appendProviderLog({
      provider: 'copilot', category: 'auth', action: 'authenticate', outcome: 'success',
      detail: cliToken ? 'using token from --token' : 'using existing copilot token',
    });
    return { token: copilotToken, shouldSave: false };
  }

  if (config.githubToken) {
    appendProviderLog({
      provider: 'copilot', category: 'auth', action: 'authenticate', outcome: 'success',
      detail: 'using saved GitHub token',
    });
    return { githubToken: config.githubToken, shouldSave: false };
  }

  appendProviderLog({
    provider: 'copilot', category: 'auth', action: 'authenticate', outcome: 'started',
    detail: 'starting device flow',
  });
  console.log(chalk.cyan('  GitHub Copilot sign-in required.'));
  const auth = new CopilotAuthManager();
  await auth.authenticateWithDeviceFlow(async ({ verificationUri, userCode, expiresIn }) => {
    appendProviderLog({
      provider: 'copilot', category: 'auth', action: 'device-flow', outcome: 'started',
      detail: `verificationUri=${verificationUri} expiresIn=${expiresIn}s userCodeIssued=true`,
    });
    console.log(chalk.dim(`  Open ${verificationUri}`));
    console.log(chalk.dim(`  Enter code: ${chalk.bold(userCode)}`));
    console.log(chalk.dim(`  Code expires in ${Math.ceil(expiresIn / 60)} minute(s).`));
    console.log(chalk.dim(`  ${getCopilotAuthStorageNote()}`));
  });
  appendProviderLog({
    provider: 'copilot', category: 'auth', action: 'authenticate', outcome: 'success',
    detail: 'device flow completed and credentials saved',
  });
  console.log(chalk.dim(`  Signed in with GitHub and saved credentials to ${getGlobalConfigDir()}/config.json`));
  const refreshed = await loadConfig(process.cwd(), {
    provider: undefined, model: undefined, host: undefined, token: undefined,
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
      provider: 'googleaistudio', category: 'auth', action: 'authenticate',
      outcome: 'started', detail: 'validating OAuth (ADC)',
    });
    const auth = new GoogleAiStudioAuthManager({ authMode: 'oauth' });
    await auth.validate();
    appendProviderLog({
      provider: 'googleaistudio', category: 'auth', action: 'authenticate',
      outcome: 'success', detail: 'validated OAuth (ADC)',
    });
    return { authMode: 'oauth', shouldSave: false };
  }

  if (existingToken) {
    appendProviderLog({
      provider: 'googleaistudio', category: 'auth', action: 'authenticate',
      outcome: 'success', detail: cliToken ? 'using token from --token' : 'using configured API key',
    });
    return { token: existingToken, authMode: 'api-key', shouldSave: false };
  }

  appendProviderLog({
    provider: 'googleaistudio', category: 'auth', action: 'authenticate',
    outcome: 'started', detail: 'prompting for auth method',
  });
  console.log(chalk.cyan('  Google AI Studio authentication required.'));
  console.log(chalk.cyan('    1.') + ' API key');
  console.log(chalk.cyan('    2.') + ` OAuth ${chalk.dim('(Application Default Credentials)')}`);
  console.log(chalk.cyan('    0.') + ' Exit');
  console.log(chalk.dim(`  ${getGoogleAiStudioOAuthStorageNote()}`));
  const choice = (await promptText(chalk.cyan('  Choose auth method (press Enter for API key, 0 to exit): '))).toLowerCase();
  if (isExitSelection(choice)) exitStartupSelection();

  if (choice === '2' || choice === 'oauth') {
    appendProviderLog({
      provider: 'googleaistudio', category: 'auth', action: 'authenticate',
      outcome: 'started', detail: 'selected OAuth (ADC)',
    });
    const auth = new GoogleAiStudioAuthManager({ authMode: 'oauth' });
    try {
      await auth.validate();
    } catch (error: any) {
      appendProviderLog({
        provider: 'googleaistudio', category: 'auth', action: 'authenticate',
        outcome: 'error', detail: error?.message ?? getGoogleAiStudioOAuthErrorMessage(),
      });
      throw new Error(error?.message ?? getGoogleAiStudioOAuthErrorMessage());
    }
    await saveGlobalConfig({ googleAiStudioAuthMode: 'oauth' });
    appendProviderLog({
      provider: 'googleaistudio', category: 'auth', action: 'authenticate',
      outcome: 'success', detail: 'validated OAuth (ADC) and saved auth preference',
    });
    console.log(chalk.dim(`  Saved Google AI Studio auth preference to ${getGlobalConfigDir()}/config.json`));
    return { authMode: 'oauth', shouldSave: false };
  }

  appendProviderLog({
    provider: 'googleaistudio', category: 'auth', action: 'authenticate',
    outcome: 'started', detail: 'prompting for API key',
  });
  const token = await promptText(descriptor.inputPrompt ?? '  Enter Google AI Studio API key: ', { secret: true });
  if (!token) {
    appendProviderLog({
      provider: 'googleaistudio', category: 'auth', action: 'authenticate',
      outcome: 'error', detail: 'API key was empty',
    });
    throw new Error(descriptor.missingError ?? 'Google AI Studio API key required.');
  }
  return { token, authMode: 'api-key', shouldSave: true };
}

// ─── Save credentials ──────────────────────────────────────────────────

async function saveCredentialsAfterModelDiscovery(
  descriptor: ProviderDescriptor,
  auth: AuthResult,
  modelsAvailable: boolean,
): Promise<void> {
  if (!auth.shouldSave) return;
  if (!descriptor.configTokenKey) return;

  const credentialsLabel = descriptor.needsAccountId ? 'credentials' : 'API key';
  const successDetail = descriptor.needsAccountId
    ? 'saved API token and account id after successful model discovery'
    : 'saved API key after successful model discovery';
  const skipDetail = descriptor.needsAccountId
    ? 'no models available; credentials not saved'
    : `no models available; ${credentialsLabel} not saved`;

  if (!modelsAvailable) {
    appendProviderLog({
      provider: descriptor.name, category: 'auth', action: 'save-credentials',
      outcome: 'skipped', detail: skipDetail,
    });
    console.log(chalk.dim(`  ${noModelsMessageFor(descriptor)}`));
    return;
  }

  const update: Record<string, unknown> = { [descriptor.configTokenKey]: auth.token };
  if (descriptor.needsAccountId && auth.accountId) {
    update.workersAiAccountId = auth.accountId;
  }
  if (descriptor.name === 'googleaistudio' && auth.authMode === 'api-key') {
    update.googleAiStudioAuthMode = 'api-key';
  }
  await saveGlobalConfig(update);
  appendProviderLog({
    provider: descriptor.name, category: 'auth', action: 'save-credentials',
    outcome: 'success', detail: successDetail,
  });
  console.log(chalk.dim(`  ${saveSuccessMessageFor(descriptor, getGlobalConfigDir())}`));
}

// ─── Provider picker ───────────────────────────────────────────────────

interface PickerOption {
  descriptor: ProviderDescriptor;
  models?: string[];
}

interface ProviderSelectionResult {
  provider: StartupProviderName;
  resumeLastModel: boolean;
}

function buildPickerOptions(
  probedModels: Map<StartupProviderName, string[] | null>,
): PickerOption[] {
  // TODO: Give Anthropic the same startup-picker/auth-prompt/save-config
  // flow parity as the other hosted providers.
  return DESCRIPTOR_LIST.flatMap(descriptor => {
    const models = probedModels.get(descriptor.name) ?? null;
    if (descriptor.showInPicker === 'when-reachable' && !models) return [];
    return [{ descriptor, models: models ?? undefined }];
  });
}

async function selectProvider(
  options: PickerOption[],
  defaultSelection?: { provider: StartupProviderName; model?: string },
): Promise<ProviderSelectionResult> {
  const defaultProvider = defaultSelection?.provider ?? options[0]?.descriptor.name ?? 'copilot';
  console.log(chalk.bold('\n  Select a provider:'));
  options.forEach((option, index) => {
    console.log(chalk.cyan(`    ${index + 1}.`) + ` ${option.descriptor.label}`);
  });
  console.log(chalk.cyan('    0.') + ' Exit');

  const defaultLabel = options.find(o => o.descriptor.name === defaultProvider)?.descriptor.label ?? defaultProvider;
  const providerPrompt = defaultSelection?.model
    ? chalk.cyan(`  Enter provider number or name (press Enter for ${chalk.bold(`${defaultLabel} / ${defaultSelection.model}`)}, 0 to exit): `)
    : chalk.cyan(`  Enter provider number or name (press Enter for ${chalk.bold(defaultLabel)}, 0 to exit): `);

  const answer = (await promptText(providerPrompt)).toLowerCase();
  if (isExitSelection(answer)) exitStartupSelection();
  if (answer === '') {
    return { provider: defaultProvider, resumeLastModel: Boolean(defaultSelection?.model) };
  }

  const byNumber = Number.parseInt(answer, 10);
  if (!Number.isNaN(byNumber) && byNumber >= 1 && byNumber <= options.length) {
    return { provider: options[byNumber - 1].descriptor.name, resumeLastModel: false };
  }

  const matched = options.find(o => o.descriptor.aliases.includes(answer));
  if (matched) {
    return { provider: matched.descriptor.name, resumeLastModel: false };
  }

  console.log(chalk.dim(`  Provider "${answer}" not recognized, using ${defaultLabel}.`));
  return { provider: defaultProvider, resumeLastModel: Boolean(defaultSelection?.model) };
}

async function findDefaultSelection(
  lastSession: { provider: string; model: string } | null,
  probedModels: Map<StartupProviderName, string[] | null>,
  config: Config,
  credentials: Map<StartupProviderName, StartupCredentials>,
): Promise<{ provider: StartupProviderName; model?: string } | undefined> {
  if (!lastSession) return undefined;
  const descriptor = (DESCRIPTORS as Record<string, ProviderDescriptor | undefined>)[lastSession.provider];
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

// ─── CLI args ──────────────────────────────────────────────────────────

interface CliArgs {
  model?: string;
  host?: string;
  provider?: string;
  token?: string;
  help?: boolean;
  noLog?: boolean;
  plan?: boolean;
  noAutoCorrect?: boolean;
  bashDedup?: boolean;
  readCache?: boolean;
  lineCountHint?: boolean;
  noBashDedup?: boolean;
  noReadCache?: boolean;
  noLineCountHint?: boolean;
  turnTimeoutSec?: number;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' || arg === '-m') {
      result.model = args[++i];
    } else if (arg === '--host') {
      result.host = args[++i];
    } else if (arg === '--provider' || arg === '-p') {
      result.provider = args[++i];
    } else if (arg === '--token' || arg === '-t') {
      result.token = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--no-log') {
      result.noLog = true;
    } else if (arg === '--plan') {
      result.plan = true;
    } else if (arg === '--no-auto-correct') {
      result.noAutoCorrect = true;
    } else if (arg === '--bash-dedup') {
      result.bashDedup = true;
    } else if (arg === '--no-bash-dedup') {
      result.noBashDedup = true;
    } else if (arg === '--read-cache') {
      result.readCache = true;
    } else if (arg === '--no-read-cache') {
      result.noReadCache = true;
    } else if (arg === '--line-count-hint') {
      result.lineCountHint = true;
    } else if (arg === '--no-line-count-hint') {
      result.noLineCountHint = true;
    } else if (arg === '--turn-timeout') {
      const n = Number(args[++i]);
      if (!isFinite(n) || n <= 0) {
        console.error(`Invalid value for --turn-timeout: must be a positive number of seconds`);
        process.exit(1);
      }
      result.turnTimeoutSec = n;
    } else if (!arg.startsWith('-')) {
      result.model = arg;
    }
  }

  return result;
}

function printUsage(): void {
  const lines = [
    '',
    chalk.bold('  factory') + chalk.dim(' — Claude Code-like CLI for Ollama, HuggingFace, llama.cpp, Anthropic, Copilot, OpenRouter, Vercel AI Gateway, OpenCode Zen, Google AI Studio, Mistral, Codestral, Cerebras, Groq, Cohere & Workers AI'),
    '',
    chalk.bold('  Usage:'),
    '    factory [options] [model]',
    '',
    chalk.bold('  Options:'),
    '    --model, -m <name>       Model to use',
    '    --provider, -p <name>    Provider: ollama (default), huggingface / hf, llamacpp, anthropic, copilot, openrouter, vercel, opencodezen, googleaistudio, mistral, codestral, cerebras, groq, cohere, or workersai',
    '    --host <url>             Server host (default varies by provider)',
    '    --token, -t <token>      API token (HF_TOKEN, HUGGING_FACE_HUB_TOKEN, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, AI_GATEWAY_API_KEY, VERCEL_OIDC_TOKEN, OPENCODE_ZEN_API_KEY, OPENCODE_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY, MISTRAL_API_KEY, CODESTRAL_API_KEY, CEREBRAS_API_KEY, GROQ_API_KEY, COHERE_API_KEY, CLOUDFLARE_API_TOKEN, GITHUB_COPILOT_API_KEY, or COPILOT_API_KEY env vars also work; Google AI Studio also supports OAuth via ADC)',
    '    --no-log                 Disable session logging to ~/.factory/sessions/',
    '    --plan                   Start in plan mode (writes are queued for approval)',
    '    --no-auto-correct        Disable LLM tool-call corrector (on by default)',
    '    --bash-dedup             Enable Bash near-duplicate detector (off by default)',
    '    --no-read-cache          Disable Read mtime/hash cache (on by default)',
    '    --no-line-count-hint     Drop the cloc/scc system-prompt hint (on by default)',
    '    --turn-timeout <sec>     Auto-abort the agent after N seconds per user prompt (default: off)',
    '    --help, -h               Show this help',
    '',
    chalk.bold('  Examples:'),
    '    factory qwen2.5-coder',
    '    factory --provider huggingface --model Qwen/Qwen2.5-Coder-32B-Instruct',
    '    factory -p anthropic -m claude-sonnet-4-6',
    '    factory -p copilot -m gpt-4.1',
    '    factory -p openrouter -m openai/gpt-4.1',
    '    factory -p vercel -m openai/gpt-5.4',
    '    factory -p opencodezen -m qwen3.6-plus',
    '    factory -p googleaistudio -m gemini-2.5-pro',
    '    factory -p mistral -m mistral-small-latest',
    '    factory -p codestral -m codestral-latest',
    '    factory -p cerebras -m gpt-oss-120b',
    '    factory -p groq -m llama-3.3-70b-versatile',
    '    factory -p cohere -m command-a-03-2025',
    '    factory -p workersai -m @cf/qwen/qwen2.5-coder-32b-instruct',
    '    factory -p llamacpp --host http://localhost:8080',
    '    factory --host http://remote:11434',
    '',
  ];
  console.log(lines.join('\n'));
}

// ─── main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv.slice(2));

  if (cliArgs.help) {
    printUsage();
    process.exit(0);
  }

  const cwd = process.cwd();

  const config = await loadConfig(cwd, {
    provider: cliArgs.provider,
    model: cliArgs.model,
    host: cliArgs.host,
    token: cliArgs.token,
  });

  const lastSession = await getLastSessionSelection().catch(() => null);

  const credentials = new Map<StartupProviderName, StartupCredentials>(
    DESCRIPTOR_LIST.map(d => [d.name, resolveCredentialsFor(d, config, cliArgs.token)]),
  );
  const probedModels = await probeAllProviders(config, credentials);

  let providerName: string;
  let resumeModel: string | null = null;

  if (config.provider) {
    providerName = config.provider;
  } else {
    const startupOptions = buildPickerOptions(probedModels);
    const defaultFromLast = await findDefaultSelection(lastSession, probedModels, config, credentials);
    const fallbackDefault = startupOptions[0]
      ? { provider: startupOptions[0].descriptor.name }
      : { provider: 'copilot' as StartupProviderName };
    const selection = await selectProvider(startupOptions, defaultFromLast ?? fallbackDefault);
    providerName = selection.provider;
    resumeModel = selection.resumeLastModel ? defaultFromLast?.model ?? null : null;
  }

  const descriptor = descriptorByAlias(providerName) ?? (DESCRIPTORS as Record<string, ProviderDescriptor | undefined>)[providerName];
  let provider: Provider;
  let availableModels: string[] | null = descriptor ? probedModels.get(descriptor.name) ?? null : null;

  try {
    const auth: AuthResult = descriptor
      ? await ensureAuth(descriptor, config, cliArgs.token)
      : { shouldSave: false };

    provider = createProvider(providerName, {
      host: config.host,
      token: auth.token,
      githubToken: auth.githubToken,
      googleAiStudioAuthMode: auth.authMode,
      accountId: auth.accountId,
    });

    if (!availableModels || provider.getDisplayModelName || provider.getModelPickerInfo) {
      availableModels = await provider.listModels();
    }

    if (descriptor) {
      await saveCredentialsAfterModelDiscovery(descriptor, auth, availableModels.length > 0);
    }
  } catch (err: any) {
    appendProviderLog({ provider: providerName, category: 'startup', action: 'startup-error', outcome: 'error', detail: err.message });
    if (providerName === 'ollama') {
      console.log(renderError('Cannot connect to Ollama. Is it running? (ollama serve)'));
    } else {
      console.log(renderError(err.message));
    }
    process.exit(1);
  }

  let model: string;
  if (config.model) {
    model = config.model;
  } else if (resumeModel && availableModels?.includes(resumeModel)) {
    model = resumeModel;
  } else {
    const lastModelForProvider = lastSession?.provider === providerName ? lastSession.model : null;
    model = await selectModel(availableModels ?? [], lastModelForProvider, provider);
  }

  const validation = await validateModelToolSupport(provider, model);
  if (validation.mode === 'unreachable') {
    console.log(renderError(validation.reason));
    process.exit(1);
  }

  const useTextToolFallback = validation.mode === 'fallback';
  if (useTextToolFallback) {
    console.log(chalk.yellow(`  ⚠ ${validation.warning}`));
  }

  const modelTier = provider.getCapabilities(model).modelTier;
  const systemPrompt = await buildSystemPrompt(cwd, modelTier);

  let mcpManager: McpManager | undefined;
  let mcpInfo: { servers: string[]; toolCount: number } | undefined;
  if (config.mcp?.servers?.length) {
    mcpManager = new McpManager();
    const mcpTools = await mcpManager.connectAll(config.mcp.servers);
    for (const tool of mcpTools) {
      defaultRegistry.register(tool);
    }
    mcpInfo = {
      servers: config.mcp.servers.map(s => (s as { name?: string }).name ?? '<unnamed>'),
      toolCount: mcpTools.length,
    };
  }

  const cleanup = async () => {
    if (mcpManager) await mcpManager.disconnect().catch(() => {});
  };
  process.on('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });
  process.on('SIGTERM', () => { void cleanup().finally(() => process.exit(0)); });

  let gitBranch: string | undefined;
  let gitDirty: boolean | null = null;
  try {
    [gitBranch, gitDirty] = await Promise.all([getGitBranch(cwd), isGitDirty(cwd)]);
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ Could not read git state: ${err.message}`));
  }

  // Experimental flags default to on except for bashDedup, which is opt-in
  // for now. Config can override; CLI flags take final precedence.
  const experimentalFromConfig = config.agent?.experimental ?? {};
  const mergedAgentConfig = {
    ...config.agent,
    experimental: {
      bashDedup: false,
      readCache: true,
      lineCountHint: true,
      ...experimentalFromConfig,
      ...(cliArgs.bashDedup ? { bashDedup: true } : {}),
      ...(cliArgs.noBashDedup ? { bashDedup: false } : {}),
      ...(cliArgs.readCache ? { readCache: true } : {}),
      ...(cliArgs.noReadCache ? { readCache: false } : {}),
      ...(cliArgs.lineCountHint ? { lineCountHint: true } : {}),
      ...(cliArgs.noLineCountHint ? { lineCountHint: false } : {}),
    },
    ...(cliArgs.turnTimeoutSec !== undefined ? { turnTimeoutSec: cliArgs.turnTimeoutSec } : {}),
  };

  console.log(renderWelcome(
    model,
    cwd,
    mergedAgentConfig.experimental,
    cliArgs.noLog ? 'disabled' : sessionsDir(),
    gitBranch,
  ));

  const appOptions = {
    model,
    systemPrompt,
    provider,
    agentConfig: mergedAgentConfig,
    autoAllowTools: config.permissions?.allowAll,
    useTextToolFallback,
    nativeToolSupport: validation.mode === 'native',
    enableSessionLog: !cliArgs.noLog,
    planMode: cliArgs.plan,
    enableCorrector: !cliArgs.noAutoCorrect,
    mcpInfo,
    gitBranch,
    gitDirty,
  };

  const isInteractiveTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  if (isInteractiveTty) {
    const app = renderApp(appOptions);
    await app.waitUntilExit();
  } else {
    const repl = new Repl(appOptions);
    await repl.start();
  }
}

main().catch((err) => {
  console.error(renderError(err.message));
  process.exit(1);
});
