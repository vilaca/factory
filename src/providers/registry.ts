import type { GoogleAiStudioAuthMode } from './auth-modes.js';
import type { Provider, UnprimedProvider } from './types.js';
import { OllamaProvider } from './ollama.js';
import { HuggingFaceProvider } from './huggingface.js';
import { LlamaCppProvider } from './llamacpp.js';
import { AnthropicProvider } from './anthropic.js';
import { CopilotProvider } from './copilot/index.js';
import { OpenRouterProvider } from './openrouter.js';
import { GoogleAiStudioProvider } from './googleaistudio/index.js';
import { CodestralProvider, MistralProvider } from './mistral.js';
import { VercelProvider } from './vercel.js';
import { OpenCodeZenProvider } from './opencodezen/index.js';
import { CerebrasProvider } from './cerebras.js';
import { GroqProvider } from './groq.js';
import { CohereProvider } from './cohere.js';
import { OpenAIProvider } from './openai/index.js';
import { WorkersAiProvider } from './workersai.js';

// ─── Types ─────────────────────────────────────────────────────────────

export type StartupProviderName =
  | 'ollama'
  | 'llamacpp'
  | 'huggingface'
  | 'anthropic'
  | 'copilot'
  | 'openrouter'
  | 'vercel'
  | 'opencodezen'
  | 'googleaistudio'
  | 'mistral'
  | 'codestral'
  | 'cerebras'
  | 'groq'
  | 'cohere'
  | 'openai'
  | 'workersai';

type AuthFlow = 'none' | 'simple-prompt' | 'device-flow' | 'oauth-or-key';

type ProviderConfigAuthModeKey = 'googleAiStudioAuthMode';

type ProviderConfigView = {
  token?: string;
  copilotToken?: string;
  githubToken?: string;
  googleAiStudioToken?: string;
  googleAiStudioAuthMode?: GoogleAiStudioAuthMode;
  workersAiAccountId?: string;
};

export interface CreateProviderOptions {
  host?: string;
  token?: string;
  githubToken?: string;
  googleAiStudioAuthMode?: GoogleAiStudioAuthMode;
  accountId?: string;
}

/** Single source of truth for a provider: picker metadata + auth shape +
 *  the factory used to instantiate it. The metadata fields drive the
 *  startup picker, auth flow, and config save messages; the factory is
 *  the only place provider constructor shapes vary. */
export interface ProviderDescriptor {
  name: StartupProviderName;
  label: string;
  aliases: string[];

  configAuthModeKey?: ProviderConfigAuthModeKey;
  envVars?: string[];
  envPrecedesConfig?: boolean;

  authFlow: AuthFlow;
  needsAccountId?: boolean;

  probeAtStartup: boolean;
  probeWithoutCredentials?: boolean;
  showInPicker: 'always' | 'when-reachable';

  promptHeader?: string;
  inputPrompt?: string;
  missingError?: string;
  saveSuccessLabel?: string;
  noModelsMessage?: string;
  accountIdInputPrompt?: string;
  accountIdMissingError?: string;

  /** Build the provider instance. Each entry pulls just the options it
   *  needs from `CreateProviderOptions` — that's the only place where
   *  per-provider constructor shape leaks. */
  factory(options: CreateProviderOptions): Provider;
}

// ─── Registry ──────────────────────────────────────────────────────────

export const DESCRIPTORS: Record<StartupProviderName, ProviderDescriptor> = {
  ollama: {
    name: 'ollama',
    label: 'Ollama',
    aliases: ['ollama'],
    authFlow: 'none',
    probeAtStartup: true,
    probeWithoutCredentials: true,
    showInPicker: 'when-reachable',
    factory: opts => new OllamaProvider(opts.host),
  },
  llamacpp: {
    name: 'llamacpp',
    label: 'llama.cpp',
    aliases: ['llamacpp', 'llama.cpp', 'llama'],
    authFlow: 'none',
    probeAtStartup: true,
    probeWithoutCredentials: true,
    showInPicker: 'when-reachable',
    factory: opts => new LlamaCppProvider(opts.host),
  },
  huggingface: {
    name: 'huggingface',
    label: 'HuggingFace',
    aliases: ['huggingface', 'hugging face', 'hf'],
    envVars: ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'],
    authFlow: 'simple-prompt',
    probeAtStartup: true,
    showInPicker: 'always',
    promptHeader: 'HuggingFace API token required.',
    inputPrompt: '  Enter HuggingFace API token: ',
    missingError: 'HuggingFace API token required.',
    noModelsMessage: 'No HuggingFace models available; API token was not saved.',
    factory: opts => new HuggingFaceProvider(opts.token),
  },
  anthropic: {
    name: 'anthropic',
    label: 'Anthropic',
    aliases: ['anthropic', 'claude'],
    envVars: ['ANTHROPIC_API_KEY'],
    authFlow: 'simple-prompt',
    probeAtStartup: true,
    showInPicker: 'always',
    promptHeader: 'Anthropic API key required.',
    inputPrompt: '  Enter Anthropic API key: ',
    missingError: 'Anthropic API key required.',
    factory: opts => new AnthropicProvider(opts.token),
  },
  copilot: {
    name: 'copilot',
    label: 'GitHub Copilot',
    aliases: ['copilot', 'github copilot', 'github-copilot', 'githubcopilot'],
    envVars: ['GITHUB_COPILOT_API_KEY', 'COPILOT_API_KEY'],
    authFlow: 'device-flow',
    probeAtStartup: false,
    showInPicker: 'always',
    factory: opts =>
      new CopilotProvider({
        token: opts.token,
        githubToken: opts.githubToken,
        host: opts.host,
      }),
  },
  openrouter: {
    name: 'openrouter',
    label: 'OpenRouter',
    aliases: ['openrouter', 'open-router', 'open router', 'or'],
    envVars: ['OPENROUTER_API_KEY'],
    authFlow: 'simple-prompt',
    probeAtStartup: true,
    showInPicker: 'always',
    promptHeader: 'OpenRouter API key required.',
    inputPrompt: '  Enter OpenRouter API key: ',
    missingError: 'OpenRouter API key required.',
    factory: opts => new OpenRouterProvider({ token: opts.token, host: opts.host }),
  },
  vercel: {
    name: 'vercel',
    label: 'Vercel AI Gateway',
    aliases: ['vercel', 'ai-gateway', 'ai gateway', 'aigateway', 'vercel-ai-gateway'],
    envVars: ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN'],
    envPrecedesConfig: true,
    authFlow: 'simple-prompt',
    probeAtStartup: true,
    probeWithoutCredentials: true,
    showInPicker: 'always',
    promptHeader: 'Vercel AI Gateway token required.',
    inputPrompt: '  Enter Vercel AI Gateway API key: ',
    missingError: 'Vercel AI Gateway token required.',
    factory: opts => new VercelProvider({ token: opts.token, host: opts.host }),
  },
  opencodezen: {
    name: 'opencodezen',
    label: 'OpenCode Zen',
    aliases: ['opencodezen', 'opencode-zen', 'zen'],
    envVars: ['OPENCODE_ZEN_API_KEY', 'OPENCODE_API_KEY'],
    authFlow: 'simple-prompt',
    probeAtStartup: true,
    probeWithoutCredentials: true,
    showInPicker: 'always',
    promptHeader: 'OpenCode Zen API key required.',
    inputPrompt: '  Enter OpenCode Zen API key: ',
    missingError: 'OpenCode Zen API key required.',
    factory: opts => new OpenCodeZenProvider({ token: opts.token, host: opts.host }),
  },
  googleaistudio: {
    name: 'googleaistudio',
    label: 'Google AI Studio',
    aliases: [
      'googleaistudio',
      'google-ai-studio',
      'google ai studio',
      'google-ai',
      'aistudio',
      'ai-studio',
      'gemini',
    ],
    configAuthModeKey: 'googleAiStudioAuthMode',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    authFlow: 'oauth-or-key',
    probeAtStartup: true,
    showInPicker: 'always',
    inputPrompt: '  Enter Google AI Studio API key: ',
    missingError: 'Google AI Studio API key required.',
    factory: opts =>
      new GoogleAiStudioProvider({
        token: opts.token,
        host: opts.host,
        authMode: opts.googleAiStudioAuthMode,
      }),
  },
  mistral: {
    name: 'mistral',
    label: 'Mistral',
    aliases: ['mistral', 'mistral.ai'],
    envVars: ['MISTRAL_API_KEY'],
    authFlow: 'simple-prompt',
    probeAtStartup: true,
    showInPicker: 'always',
    promptHeader: 'Mistral API key required.',
    inputPrompt: '  Enter Mistral API key: ',
    missingError: 'Mistral API key required.',
    factory: opts => new MistralProvider({ token: opts.token, host: opts.host }),
  },
  codestral: {
    name: 'codestral',
    label: 'Codestral',
    aliases: ['codestral', 'codestral.mistral.ai'],
    envVars: ['CODESTRAL_API_KEY'],
    authFlow: 'simple-prompt',
    probeAtStartup: true,
    showInPicker: 'always',
    promptHeader: 'Codestral API key required.',
    inputPrompt: '  Enter Codestral API key: ',
    missingError: 'Codestral API key required.',
    factory: opts => new CodestralProvider({ token: opts.token, host: opts.host }),
  },
  cerebras: {
    name: 'cerebras',
    label: 'Cerebras',
    aliases: ['cerebras'],
    envVars: ['CEREBRAS_API_KEY'],
    authFlow: 'simple-prompt',
    probeAtStartup: true,
    showInPicker: 'always',
    promptHeader: 'Cerebras API key required.',
    inputPrompt: '  Enter Cerebras API key: ',
    missingError: 'Cerebras API key required.',
    factory: opts => new CerebrasProvider({ token: opts.token, host: opts.host }),
  },
  groq: {
    name: 'groq',
    label: 'Groq',
    aliases: ['groq'],
    envVars: ['GROQ_API_KEY'],
    authFlow: 'simple-prompt',
    probeAtStartup: true,
    showInPicker: 'always',
    promptHeader: 'Groq API key required.',
    inputPrompt: '  Enter Groq API key: ',
    missingError: 'Groq API key required.',
    factory: opts => new GroqProvider({ token: opts.token, host: opts.host }),
  },
  cohere: {
    name: 'cohere',
    label: 'Cohere',
    aliases: ['cohere'],
    envVars: ['COHERE_API_KEY'],
    authFlow: 'simple-prompt',
    probeAtStartup: true,
    showInPicker: 'always',
    promptHeader: 'Cohere API key required.',
    inputPrompt: '  Enter Cohere API key: ',
    missingError: 'Cohere API key required.',
    factory: opts => new CohereProvider({ token: opts.token, host: opts.host }),
  },
  openai: {
    name: 'openai',
    label: 'OpenAI',
    aliases: ['openai', 'open-ai', 'oai'],
    envVars: ['OPENAI_API_KEY'],
    authFlow: 'simple-prompt',
    probeAtStartup: true,
    showInPicker: 'always',
    promptHeader: 'OpenAI API key required.',
    inputPrompt: '  Enter OpenAI API key: ',
    missingError: 'OpenAI API key required.',
    factory: opts => new OpenAIProvider({ token: opts.token, host: opts.host }),
  },
  workersai: {
    name: 'workersai',
    label: 'Cloudflare Workers AI',
    aliases: ['workersai', 'workers-ai', 'cloudflare', 'cloudflare-workers-ai'],
    envVars: ['CLOUDFLARE_API_TOKEN'],
    authFlow: 'simple-prompt',
    needsAccountId: true,
    probeAtStartup: true,
    showInPicker: 'always',
    promptHeader: 'Cloudflare Workers AI credentials required.',
    inputPrompt: '  Enter Cloudflare API token: ',
    missingError: 'Cloudflare Workers AI API token required.',
    saveSuccessLabel: 'Workers AI',
    noModelsMessage: 'No Workers AI models available; credentials were not saved.',
    accountIdInputPrompt: '  Enter Cloudflare account ID: ',
    accountIdMissingError: 'Cloudflare Workers AI account ID required.',
    factory: opts =>
      new WorkersAiProvider({
        token: opts.token,
        host: opts.host,
        accountId: opts.accountId,
      }),
  },
};

export const DESCRIPTOR_LIST: ProviderDescriptor[] = (
  Object.keys(DESCRIPTORS) as StartupProviderName[]
).map(name => DESCRIPTORS[name]);

// ─── Lookup ────────────────────────────────────────────────────────────

export function descriptorByAlias(input: string): ProviderDescriptor | undefined {
  const lower = input.trim().toLowerCase();
  return DESCRIPTOR_LIST.find(d => d.aliases.includes(lower));
}

export function listProviderNames(): string[] {
  return [...(Object.keys(DESCRIPTORS) as StartupProviderName[])].sort();
}

/** Construct a provider instance.
 *
 *  Returns `UnprimedProvider`, not `Provider` — see the type docstring
 *  in ./types.ts. Callers must route the result through `prime()` from
 *  ./prime.ts before using the full surface (`getCapabilities`, `chat`,
 *  `chatNoStream`). This is the type-level enforcement of the cf880ed
 *  contract: mint → prime → use. */
export function createProvider(
  name: string,
  options: CreateProviderOptions = {},
): UnprimedProvider {
  const descriptor = descriptorByAlias(name) ?? DESCRIPTORS[name as StartupProviderName];
  if (!descriptor) {
    const known = listProviderNames()
      .map(n => `"${n}"`)
      .join(', ');
    throw new Error(`Unknown provider: ${name}. Use one of: ${known}.`);
  }
  // The factory returns the concrete class which structurally satisfies
  // both Provider and UnprimedProvider; narrowing here is the gate that
  // forces callers through prime().
  return descriptor.factory(options);
}

// ─── Auth helpers ──────────────────────────────────────────────────────

export function resolveToken(
  descriptor: ProviderDescriptor,
  config: ProviderConfigView,
  cliToken?: string,
): string | undefined {
  if (cliToken) return cliToken;

  const fromConfig = (): string | undefined => {
    // Google AI Studio keeps its token in a named config field.
    if (descriptor.name === 'googleaistudio' && config.googleAiStudioToken)
      return config.googleAiStudioToken;
    return undefined;
  };

  const fromEnv = (): string | undefined => {
    for (const envVar of descriptor.envVars ?? []) {
      const value = process.env[envVar];
      if (value) return value;
    }
    return undefined;
  };

  return descriptor.envPrecedesConfig ? (fromEnv() ?? fromConfig()) : (fromConfig() ?? fromEnv());
}

export function noModelsMessageFor(descriptor: ProviderDescriptor): string {
  return (
    descriptor.noModelsMessage ?? `No ${descriptor.label} models available; API key was not saved.`
  );
}

export function saveSuccessMessageFor(descriptor: ProviderDescriptor, configDir: string): string {
  const label = descriptor.saveSuccessLabel ?? descriptor.label;
  return `Saved ${label} credentials to ${configDir}/config.json`;
}
