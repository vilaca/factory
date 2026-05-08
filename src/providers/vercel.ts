import type {
  Provider,
  ChatMessage,
  ChatChunk,
  ToolDefinition,
  ProviderCapabilities,
  ChatOptions,
  ModelInfo,
  ModelPickerInfo,
  ModelTier,
} from './types.js';
import {
  buildChatBody,
  fetchOpenAiCatalog,
  sendOpenAiChat,
  streamOpenAiChat,
} from './_openai/index.js';

const DEFAULT_BASE_URL = 'https://ai-gateway.vercel.sh/v1';
const PROVIDER_NAME = 'Vercel AI Gateway';
const MISSING_TOKEN_ERROR =
  'Vercel AI Gateway token required. Set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN env var or use --token flag.';

interface VercelModel {
  id: string;
  name?: string;
  description?: string;
  owned_by?: string;
  context_window?: number;
  max_tokens?: number;
  type?: string;
  tags?: string[];
}

export class VercelProvider implements Provider {
  name = 'vercel';
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private modelsCache: VercelModel[] | null = null;

  constructor(options: { token?: string; host?: string } = {}) {
    this.apiKey = options.token ?? process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN;
    this.baseUrl = (options.host ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async listModels(): Promise<string[]> {
    const models = await this.getCatalog();
    return [...new Set(models.map(model => model.id))];
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const match = this.modelsCache?.find(item => item.id === model);
    if (!match) return { label: model };
    return {
      label: model,
      detail: buildModelDetail(match),
      warning: buildModelWarning(match),
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    const cached = this.modelsCache?.find(item => item.id === model);
    const supportsTools = cached?.tags?.includes('tool-use') ?? true;
    return {
      contextWindow: cached?.context_window ?? estimateContextWindow(lower),
      maxOutputTokens: cached?.max_tokens ?? estimateMaxOutput(lower),
      toolSupport: supportsTools ? 'native' : 'none',
      parallelToolCalls: supportsTools,
      streaming: true,
      tokenCounting: 'exact',
      modelTier: estimateModelTier(lower),
    };
  }

  async getModelInfo(model: string): Promise<ModelInfo> {
    const models = await this.getCatalog();
    const match = models.find(item => item.id === model);
    if (!match) return { supportsTools: true };
    return {
      supportsTools: match.tags?.includes('tool-use') ?? false,
      capabilities: match.tags,
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    this.requireAuth();
    try {
      yield* streamOpenAiChat({
        url: `${this.baseUrl}/chat/completions`,
        headers: this.authHeaders(),
        body: buildChatBody({
          model,
          messages,
          tools,
          stream: true,
          options,
          maxTokensField: 'max_tokens',
        }),
        signal: options?.signal,
        providerName: PROVIDER_NAME,
      });
    } catch (err) {
      throw augmentAuthError(err);
    }
  }

  async chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    this.requireAuth();
    try {
      return await sendOpenAiChat({
        url: `${this.baseUrl}/chat/completions`,
        headers: this.authHeaders(),
        body: buildChatBody({
          model,
          messages,
          tools,
          stream: false,
          options,
          maxTokensField: 'max_tokens',
        }),
        signal: options?.signal,
        providerName: PROVIDER_NAME,
      });
    } catch (err) {
      throw augmentAuthError(err);
    }
  }

  private requireAuth(): void {
    if (!this.apiKey) throw new Error(MISSING_TOKEN_ERROR);
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  private async getCatalog(): Promise<VercelModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const items = await fetchOpenAiCatalog({
      url: `${this.baseUrl}/models`,
      headers: this.authHeaders(),
      providerName: PROVIDER_NAME,
    });

    interface VercelCatalogItem {
      id?: string;
      name?: string;
      description?: string;
      owned_by?: string;
      context_window?: number;
      max_tokens?: number;
      type?: string;
      tags?: unknown[];
    }
    const byId = new Map<string, VercelModel>();
    for (const raw of items) {
      // Vercel's catalog includes multiple resource types; keep only language
      // models because this provider only targets chat text models.
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as VercelCatalogItem;
      if (typeof item.id !== 'string' || !item.id) continue;
      if (item.type !== 'language') continue;
      if (byId.has(item.id)) continue;

      byId.set(item.id, {
        id: item.id,
        name: typeof item.name === 'string' ? item.name : undefined,
        description: typeof item.description === 'string' ? item.description : undefined,
        owned_by: typeof item.owned_by === 'string' ? item.owned_by : undefined,
        context_window: typeof item.context_window === 'number' ? item.context_window : undefined,
        max_tokens: typeof item.max_tokens === 'number' ? item.max_tokens : undefined,
        type: typeof item.type === 'string' ? item.type : undefined,
        tags: Array.isArray(item.tags)
          ? item.tags.filter((value: unknown): value is string => typeof value === 'string')
          : undefined,
      });
    }
    this.modelsCache = [...byId.values()];
    return this.modelsCache;
  }
}

function augmentAuthError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  if (err.message.includes(`${PROVIDER_NAME} API error 401`)) {
    // TODO: Detect 401s returned during model requests and replace this generic
    // hint with a response-specific explanation of the required AI Gateway key.
    return new Error(
      `${err.message}\nCheck --token, AI_GATEWAY_API_KEY, VERCEL_OIDC_TOKEN, and any saved vercelToken/token in your factory config.`,
    );
  }
  return err;
}

// ─── Picker / capability helpers ───────────────────────────────────────

function buildModelDetail(model: VercelModel): string {
  const lower = model.id.toLowerCase();
  const tags = new Set(model.tags ?? []);
  const details: string[] = [];

  details.push(tags.has('vision') ? 'vision' : 'text-only');
  details.push(tags.has('tool-use') ? 'tools' : 'no tools');
  if (tags.has('reasoning')) details.push('reasoning');
  if (tags.has('file-input')) details.push('file input');

  const maxOutput = model.max_tokens ?? estimateMaxOutput(lower);
  if (maxOutput > 0) details.push(`max ${formatTokenCount(maxOutput)} out`);

  const contextWindow = model.context_window ?? estimateContextWindow(lower);
  if (contextWindow > 0) details.push(`${formatTokenCount(contextWindow)} ctx`);

  return details.join(' · ');
}

function buildModelWarning(model: VercelModel): string | undefined {
  const searchable = `${model.id} ${model.name ?? ''}`.toLowerCase();
  if (searchable.includes('experimental') || searchable.includes('-exp')) return 'experimental';
  if (searchable.includes('preview')) return 'preview';
  if (searchable.includes('beta')) return 'beta';
  if (searchable.includes('deprecated')) return 'deprecated';
  return undefined;
}

function estimateModelTier(model: string): ModelTier {
  if (
    model.includes('opus') ||
    model.includes('sonnet') ||
    model.includes('gpt-5') ||
    model.includes('gpt-4.1') ||
    model.includes('o3') ||
    model.includes('o4') ||
    model.includes('gemini-2.5-pro') ||
    model.includes('deepseek-r1')
  )
    return 'strong';
  return 'medium';
}

function estimateContextWindow(model: string): number {
  if (model.includes('claude')) return 200000;
  if (model.includes('gemini')) return 1048576;
  if (model.includes('gpt') || model.includes('o3') || model.includes('o4')) return 128000;
  return 128000;
}

function estimateMaxOutput(model: string): number {
  if (model.includes('mini') || model.includes('haiku') || model.includes('flash')) return 8192;
  return 16384;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  return String(value);
}
