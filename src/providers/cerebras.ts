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
  buildResponsesBody,
  fetchOpenAiCatalog,
  isResponsesApiOnly,
  sendOpenAiChat,
  sendOpenAiResponses,
  streamOpenAiChat,
  streamOpenAiResponses,
} from './openai/index.js';
import {
  bearerAuth,
  formatTokenCount,
  normalizeBaseUrl,
  warnHardcodedEstimateFallback,
} from './shared.js';

const DEFAULT_BASE_URL = 'https://api.cerebras.ai/v1';
const MISSING_TOKEN_ERROR =
  'Cerebras API key required. Set CEREBRAS_API_KEY env var or use --token flag.';

interface CerebrasModel {
  id: string;
  owned_by?: string;
}

export class CerebrasProvider implements Provider {
  name = 'cerebras';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private modelsCache: CerebrasModel[] | null = null;

  constructor(options: { token?: string; host?: string } = {}) {
    const key = options.token ?? process.env.CEREBRAS_API_KEY;
    if (!key) {
      throw new Error(MISSING_TOKEN_ERROR);
    }
    this.apiKey = key;
    this.baseUrl = normalizeBaseUrl(options.host ?? DEFAULT_BASE_URL);
  }

  async listModels(): Promise<string[]> {
    const models = await this.getCatalog();
    return [...new Set(models.map(model => model.id))];
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const match = this.modelsCache?.find(item => item.id === model);
    if (!match) {
      return { label: model };
    }

    return {
      label: model,
      detail: buildModelDetail(match.id),
      warning: buildModelWarning(match.id),
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    warnHardcodedEstimateFallback({
      provider: 'Cerebras',
      model,
      fields: ['contextWindow', 'maxOutputTokens', 'modelTier'],
      reason: 'catalog does not publish full capability limits; using model-name heuristics',
    });
    return {
      contextWindow: estimateContextWindow(lower),
      maxOutputTokens: estimateMaxOutput(lower),
      toolSupport: 'native',
      parallelToolCalls: true,
      streaming: true,
      tokenCounting: 'exact',
      modelTier: estimateModelTier(lower),
    };
  }

  async getModelInfo(model: string): Promise<ModelInfo> {
    await this.getCatalog();
    const lower = model.toLowerCase();
    return {
      supportsTools: true,
      capabilities: buildCapabilities(lower),
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    if (isResponsesApiOnly(model)) {
      yield* streamOpenAiResponses({
        url: `${this.baseUrl}/responses`,
        headers: this.authHeaders(),
        body: buildResponsesBody({
          model,
          messages,
          tools,
          stream: true,
          options: options ? { ...options, temperature: undefined } : undefined,
        }),
        signal: options?.signal,
        providerName: 'Cerebras',
      });
      return;
    }
    yield* streamOpenAiChat({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.authHeaders(),
      body: buildChatBody({
        model,
        messages,
        tools,
        stream: true,
        options,
        providerName: 'Cerebras',
      }),
      signal: options?.signal,
      providerName: 'Cerebras',
    });
  }

  async chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    if (isResponsesApiOnly(model)) {
      return sendOpenAiResponses({
        url: `${this.baseUrl}/responses`,
        headers: this.authHeaders(),
        body: buildResponsesBody({
          model,
          messages,
          tools,
          stream: false,
          options: options ? { ...options, temperature: undefined } : undefined,
        }),
        signal: options?.signal,
        providerName: 'Cerebras',
      });
    }
    return sendOpenAiChat({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.authHeaders(),
      body: buildChatBody({
        model,
        messages,
        tools,
        stream: false,
        options,
        providerName: 'Cerebras',
      }),
      signal: options?.signal,
      providerName: 'Cerebras',
    });
  }

  private authHeaders(): Record<string, string> {
    return bearerAuth(this.apiKey);
  }

  private async getCatalog(): Promise<CerebrasModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const items = await fetchOpenAiCatalog({
      url: `${this.baseUrl}/models`,
      headers: this.authHeaders(),
      providerName: 'Cerebras',
    });

    interface CatalogItem {
      id?: string;
      owned_by?: string;
    }
    this.modelsCache = items
      .filter(
        (item: unknown): item is CatalogItem & { id: string } =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as CatalogItem).id === 'string' &&
          !!(item as CatalogItem).id,
      )
      .map(item => ({
        id: item.id,
        owned_by: typeof item.owned_by === 'string' ? item.owned_by : undefined,
      }));

    return this.modelsCache;
  }
}

// ─── Picker / capability helpers ───────────────────────────────────────

function buildModelDetail(modelId: string): string {
  const lower = modelId.toLowerCase();
  const details: string[] = [];
  details.push('text-only');
  details.push('tools');
  if (supportsReasoning(lower)) details.push('reasoning');
  details.push(`max ${formatTokenCount(estimateMaxOutput(lower))} out`);
  details.push(`${formatTokenCount(estimateContextWindow(lower))} ctx`);
  return details.join(' · ');
}

function buildModelWarning(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.includes('qwen-3-235b') || lower.includes('zai-glm-4.7')) return 'preview';
  if (lower.includes('llama3.1-8b')) return 'deprecated';
  return undefined;
}

function buildCapabilities(model: string): string[] {
  const capabilities = ['text', 'tool-use'];
  if (supportsReasoning(model)) capabilities.push('reasoning');
  return capabilities;
}

function estimateModelTier(model: string): ModelTier {
  if (model.includes('gpt-oss-120b') || model.includes('zai-glm-4.7')) return 'strong';
  if (model.includes('qwen-3-235b')) return 'medium';
  return 'weak';
}

function estimateContextWindow(model: string): number {
  if (model.includes('gpt-oss-120b')) return 131072;
  if (model.includes('zai-glm-4.7')) return 128000;
  if (model.includes('qwen-3-235b')) return 262144;
  if (model.includes('llama3.1-8b')) return 131072;
  return 128000;
}

function estimateMaxOutput(model: string): number {
  if (model.includes('gpt-oss-120b') || model.includes('zai-glm-4.7')) return 65536;
  if (model.includes('qwen-3-235b')) return 32768;
  if (model.includes('llama3.1-8b')) return 8192;
  return 8192;
}

function supportsReasoning(model: string): boolean {
  return model.includes('gpt-oss') || model.includes('zai-glm') || model.includes('qwen');
}
