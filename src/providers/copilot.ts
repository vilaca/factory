import type {
  Provider, ChatMessage, ChatChunk, ToolDefinition,
  ProviderCapabilities, ChatOptions, ModelPickerInfo, ModelTier,
} from './types.js';
import { CopilotAuthManager, inferCopilotCredentialKind } from './copilot-auth.js';
import { buildChatBody, sendOpenAiChat, streamOpenAiChat } from './_openai/index.js';

const PROVIDER_NAME = 'GitHub Copilot';
const FALLBACK_MODELS = [
  'gpt-4.1',
  'gpt-4o',
  'claude-sonnet-4',
  'gemini-2.5-pro',
  'o4-mini',
];

interface CopilotModelEntry {
  id: string;
}

export class CopilotProvider implements Provider {
  name = 'copilot';
  private auth: CopilotAuthManager;

  constructor(options: { token?: string; githubToken?: string; host?: string } = {}) {
    const envToken = process.env.GITHUB_COPILOT_API_KEY ?? process.env.COPILOT_API_KEY;
    const provided = options.token ?? envToken;
    const kind = inferCopilotCredentialKind(provided);
    this.auth = new CopilotAuthManager({
      copilotToken: kind === 'copilot' ? provided : undefined,
      githubToken: options.githubToken ?? (kind === 'github' ? provided : undefined),
      host: options.host,
    });
  }

  async listModels(): Promise<string[]> {
    const session = await this.auth.getSession();
    const res = await fetch(`${session.apiBaseUrl}/models`, {
      headers: {
        ...this.auth.authHeaders(session.token),
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${PROVIDER_NAME} API error ${res.status}: ${text}`);
    }

    const data = await res.json() as unknown;
    const models = extractModelEntries(data);
    return models.length > 0 ? models.map(model => model.id) : [...FALLBACK_MODELS];
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const caps = this.getCapabilities(model);
    return {
      label: model,
      detail: `tools · max ${formatTokenCount(caps.maxOutputTokens)} out`,
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    const tier = estimateCopilotModelTier(lower);
    return {
      contextWindow: estimateCopilotContextWindow(lower),
      maxOutputTokens: lower.includes('mini') || lower.includes('haiku') ? 8192 : 16384,
      toolSupport: 'native',
      parallelToolCalls: true,
      streaming: true,
      tokenCounting: 'exact',
      modelTier: tier,
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const session = await this.requireChatSession(options?.signal);
    yield* streamOpenAiChat({
      url: `${session.apiBaseUrl}/chat/completions`,
      headers: this.auth.authHeaders(session.token),
      body: buildChatBody({ model, messages, tools, stream: true, options, maxTokensField: 'max_tokens' }),
      signal: options?.signal,
      providerName: PROVIDER_NAME,
    });
  }

  async chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    const session = await this.requireChatSession(options?.signal);
    return sendOpenAiChat({
      url: `${session.apiBaseUrl}/chat/completions`,
      headers: this.auth.authHeaders(session.token),
      body: buildChatBody({ model, messages, tools, stream: false, options, maxTokensField: 'max_tokens' }),
      signal: options?.signal,
      providerName: PROVIDER_NAME,
    });
  }

  private async requireChatSession(signal?: AbortSignal) {
    const session = await this.auth.getSession(signal);
    if (!session.chatEnabled) {
      throw new Error('GitHub Copilot chat is not enabled for this account.');
    }
    return session;
  }
}

function extractModelEntries(data: unknown): CopilotModelEntry[] {
  const rawItems =
    Array.isArray(data)
      ? data
      : (data && typeof data === 'object' && Array.isArray((data as any).data))
        ? (data as any).data
        : [];

  const models: string[] = rawItems
    .filter((item: any) => {
      if (!item || typeof item !== 'object') return true;
      // Note: respect Copilot's own picker and policy flags so we do not offer
      // models the upstream service marks as hidden, non-chat, or disabled.
      if (item.model_picker_enabled === false) return false;
      if (item.capabilities?.type && item.capabilities.type !== 'chat') return false;
      if (item.policy?.state && item.policy.state !== 'enabled') return false;
      return true;
    })
    .map((item: any) => {
      if (typeof item === 'string') return item;
      if (item && typeof item.id === 'string') return item.id;
      if (item && typeof item.name === 'string') return item.name;
      return null;
    })
    .filter((value: string | null): value is string => value !== null);

  return [...new Set(models)].map(id => ({ id }));
}

function estimateCopilotModelTier(model: string): ModelTier {
  if (model.includes('opus') || model.includes('sonnet') || model.includes('gpt-5') ||
      model.includes('gpt-4.1') || model.includes('o3') || model.includes('o4') ||
      model.includes('gemini-2.5-pro')) {
    return 'strong';
  }
  return 'medium';
}

function estimateCopilotContextWindow(model: string): number {
  if (model.includes('claude')) return 200000;
  if (model.includes('gemini')) return 128000;
  if (model.includes('gpt') || model.includes('o3') || model.includes('o4')) return 128000;
  return 128000;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  }
  return String(value);
}
