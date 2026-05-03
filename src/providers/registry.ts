import type { Provider } from './types.js';
import type { GoogleAiStudioAuthMode } from '../core/config-types.js';
import { OllamaProvider } from './ollama.js';
import { HuggingFaceProvider } from './huggingface.js';
import { LlamaCppProvider } from './llamacpp.js';
import { AnthropicProvider } from './anthropic.js';
import { CopilotProvider } from './copilot.js';
import { OpenRouterProvider } from './openrouter.js';
import { GoogleAiStudioProvider } from './googleaistudio.js';
import { CodestralProvider, MistralProvider } from './mistral.js';
import { VercelProvider } from './vercel.js';
import { OpenCodeZenProvider } from './opencodezen.js';
import { CerebrasProvider } from './cerebras.js';
import { GroqProvider } from './groq.js';
import { CohereProvider } from './cohere.js';
import { WorkersAiProvider } from './workersai.js';

export interface CreateProviderOptions {
  host?: string;
  token?: string;
  githubToken?: string;
  googleAiStudioAuthMode?: GoogleAiStudioAuthMode;
  accountId?: string;
}

const PROVIDER_ALIASES: Record<string, string> = {
  ollama: 'ollama',
  huggingface: 'huggingface',
  hf: 'huggingface',
  llamacpp: 'llamacpp',
  'llama.cpp': 'llamacpp',
  llama: 'llamacpp',
  anthropic: 'anthropic',
  claude: 'anthropic',
  copilot: 'copilot',
  githubcopilot: 'copilot',
  'github-copilot': 'copilot',
  openrouter: 'openrouter',
  'open-router': 'openrouter',
  or: 'openrouter',
  vercel: 'vercel',
  'ai-gateway': 'vercel',
  aigateway: 'vercel',
  'vercel-ai-gateway': 'vercel',
  opencodezen: 'opencodezen',
  'opencode-zen': 'opencodezen',
  zen: 'opencodezen',
  googleaistudio: 'googleaistudio',
  'google-ai-studio': 'googleaistudio',
  'google-ai': 'googleaistudio',
  aistudio: 'googleaistudio',
  'ai-studio': 'googleaistudio',
  gemini: 'googleaistudio',
  mistral: 'mistral',
  'mistral.ai': 'mistral',
  codestral: 'codestral',
  'codestral.mistral.ai': 'codestral',
  cerebras: 'cerebras',
  groq: 'groq',
  cohere: 'cohere',
  workersai: 'workersai',
  'workers-ai': 'workersai',
  cloudflare: 'workersai',
  'cloudflare-workers-ai': 'workersai',
};

export function createProvider(name: string, options: CreateProviderOptions = {}): Provider {
  const normalized = PROVIDER_ALIASES[name.toLowerCase()];

  switch (normalized) {
    case 'ollama':
      return new OllamaProvider(options.host);
    case 'huggingface':
      return new HuggingFaceProvider(options.token);
    case 'llamacpp':
      return new LlamaCppProvider(options.host);
    case 'anthropic':
      return new AnthropicProvider(options.token);
    case 'copilot':
      return new CopilotProvider({ token: options.token, githubToken: options.githubToken, host: options.host });
    case 'openrouter':
      return new OpenRouterProvider({ token: options.token, host: options.host });
    case 'vercel':
      return new VercelProvider({ token: options.token, host: options.host });
    case 'opencodezen':
      return new OpenCodeZenProvider({ token: options.token, host: options.host });
    case 'googleaistudio':
      return new GoogleAiStudioProvider({
        token: options.token,
        host: options.host,
        authMode: options.googleAiStudioAuthMode,
      });
    case 'mistral':
      return new MistralProvider({ token: options.token, host: options.host });
    case 'codestral':
      return new CodestralProvider({ token: options.token, host: options.host });
    case 'cerebras':
      return new CerebrasProvider({ token: options.token, host: options.host });
    case 'groq':
      return new GroqProvider({ token: options.token, host: options.host });
    case 'cohere':
      return new CohereProvider({ token: options.token, host: options.host });
    case 'workersai':
      return new WorkersAiProvider({ token: options.token, host: options.host, accountId: options.accountId });
    default:
      throw new Error(
        `Unknown provider: ${name}. Use "ollama", "huggingface", "llamacpp", "anthropic", "copilot", "openrouter", "vercel", "opencodezen", "googleaistudio", "mistral", "codestral", "cerebras", "groq", "cohere", or "workersai".`
      );
  }
}

export function getProviderNames(): string[] {
  return ['ollama', 'huggingface', 'llamacpp', 'anthropic', 'copilot', 'openrouter', 'vercel', 'opencodezen', 'googleaistudio', 'mistral', 'codestral', 'cerebras', 'groq', 'cohere', 'workersai'];
}
