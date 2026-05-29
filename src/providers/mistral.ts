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
} from './openai/index.js';
import { filterChatModels, matchedPattern } from './list-models-filter.js';
import {
  bearerAuth,
  formatTokenCount,
  normalizeBaseUrl,
  warnHardcodedEstimateFallback,
} from './shared.js';

const DEFAULT_BASE_URL = 'https://api.mistral.ai/v1';
const CODESTRAL_BASE_URL = 'https://codestral.mistral.ai/v1';

interface MistralProviderOptions {
  token?: string;
  host?: string;
  providerName?: string;
  displayName?: string;
  defaultBaseUrl?: string;
  envVarName?: string;
  fallbackModels?: MistralModel[];
}

interface MistralModel {
  id: string;
  name?: string;
  description?: string;
  max_context_length?: number;
  capabilities?: {
    completion_chat?: boolean;
    function_calling?: boolean;
    vision?: boolean;
  };
}

export class MistralProvider implements Provider {
  name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly displayName: string;
  private readonly envVarName: string;
  private readonly fallbackModels: MistralModel[];
  private modelsCache: MistralModel[] | null = null;

  constructor(options: MistralProviderOptions = {}) {
    this.name = options.providerName ?? 'mistral';
    this.displayName = options.displayName ?? 'Mistral';
    this.envVarName = options.envVarName ?? 'MISTRAL_API_KEY';
    this.fallbackModels = options.fallbackModels ?? [];
    const key = options.token ?? process.env[this.envVarName];
    if (!key) {
      throw new Error(
        `${this.displayName} API key required. Set ${this.envVarName} env var or use --token flag.`,
      );
    }
    this.apiKey = key;
    this.baseUrl = normalizeBaseUrl(options.host ?? options.defaultBaseUrl ?? DEFAULT_BASE_URL);
  }

  async listModels(): Promise<string[]> {
    const models = await this.getCatalog();
    return [...new Set(models.map(model => model.id))];
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const match = this.modelsCache?.find(item => item.id === model);
    if (!match) {
      return {
        label: model,
        detail: buildFallbackModelDetail(model),
      };
    }

    return {
      label: model,
      detail: buildModelDetail(match),
      warning: buildModelWarning(match),
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    const cached = this.modelsCache?.find(item => item.id === model);
    const toolSupport = cached?.capabilities?.function_calling ?? supportsToolsByName(lower);
    const vision = cached?.capabilities?.vision ?? supportsVisionByName(lower);

    const contextWindow = cached?.max_context_length ?? estimateMistralContextWindow(lower);
    if (typeof cached?.max_context_length !== 'number') {
      warnHardcodedEstimateFallback({
        provider: this.displayName,
        model,
        fields: ['contextWindow', 'maxOutputTokens', 'modelTier'],
        reason: cached
          ? 'catalog metadata did not include context length; remaining capabilities use model-name heuristics'
          : 'model not found in cached catalog; capabilities use model-name heuristics',
      });
    }

    return {
      contextWindow,
      maxOutputTokens: estimateMistralMaxOutput(lower),
      toolSupport: toolSupport ? 'native' : 'none',
      parallelToolCalls: toolSupport,
      streaming: true,
      tokenCounting: 'exact',
      modelTier: estimateMistralModelTier(lower, vision),
    };
  }

  async getModelInfo(model: string): Promise<ModelInfo> {
    const models = await this.getCatalog();
    const match = models.find(item => item.id === model);
    const lower = model.toLowerCase();
    return {
      supportsTools: match?.capabilities?.function_calling ?? supportsToolsByName(lower),
      capabilities: [
        ...(match?.capabilities?.vision || supportsVisionByName(lower) ? ['vision'] : ['text']),
        ...((match?.capabilities?.function_calling ?? supportsToolsByName(lower))
          ? ['function_calling']
          : []),
      ],
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    yield* streamOpenAiChat({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.authHeaders(),
      body: this.body(model, messages, tools, true, options),
      signal: options?.signal,
      providerName: this.displayName,
    });
  }

  async chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    return sendOpenAiChat({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.authHeaders(),
      body: this.body(model, messages, tools, false, options),
      signal: options?.signal,
      providerName: this.displayName,
    });
  }

  private body(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    stream: boolean,
    options?: ChatOptions,
  ): Record<string, unknown> {
    return buildChatBody({
      model,
      messages,
      tools,
      stream,
      options,
      maxTokensField: 'max_tokens',
      extra: tools && tools.length > 0 ? { tool_choice: 'auto' } : undefined,
      providerName: this.displayName,
    });
  }

  private authHeaders(): Record<string, string> {
    return bearerAuth(this.apiKey);
  }

  private async getCatalog(): Promise<MistralModel[]> {
    if (this.modelsCache) return this.modelsCache;

    let items: unknown[];
    try {
      items = await fetchOpenAiCatalog({
        url: `${this.baseUrl}/models`,
        headers: { ...this.authHeaders(), Accept: 'application/json' },
        providerName: this.displayName,
      });
    } catch (err) {
      if (
        this.fallbackModels.length > 0 &&
        err instanceof Error &&
        /API error 404\b/.test(err.message)
      ) {
        this.modelsCache = dedupeModels(this.fallbackModels);
        return this.modelsCache;
      }
      throw err;
    }

    const idable: (MistralModelItem & { id: string })[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const i = item as MistralModelItem;
      const id = typeof i.id === 'string' ? i.id : typeof i.name === 'string' ? i.name : null;
      if (!id) continue;
      idable.push({ ...i, id });
    }
    this.modelsCache = dedupeModels(
      filterChatModels(this.name, idable, item => {
        const matched = matchedPattern(item.id, MISTRAL_NON_CHAT_PATTERNS);
        return matched ? `non-chat: matches '${matched}'` : true;
      }).map(item => ({
        id: item.id,
        name: typeof item.name === 'string' ? item.name : undefined,
        description: typeof item.description === 'string' ? item.description : undefined,
        max_context_length:
          typeof item.max_context_length === 'number'
            ? item.max_context_length
            : typeof item.maxContextLength === 'number'
              ? item.maxContextLength
              : undefined,
        capabilities:
          typeof item.capabilities === 'object' && item.capabilities
            ? {
                completion_chat:
                  item.capabilities.completion_chat === true ||
                  item.capabilities.chat_completion === true,
                function_calling:
                  item.capabilities.function_calling === true || item.capabilities.tools === true,
                vision: item.capabilities.vision === true,
              }
            : undefined,
      })),
    );

    return this.modelsCache;
  }
}

export class CodestralProvider extends MistralProvider {
  constructor(options: { token?: string; host?: string } = {}) {
    super({
      ...options,
      providerName: 'codestral',
      displayName: 'Codestral',
      defaultBaseUrl: CODESTRAL_BASE_URL,
      envVarName: 'CODESTRAL_API_KEY',
      fallbackModels: [
        {
          id: 'codestral-latest',
          description: 'Latest Codestral chat model',
          max_context_length: 128000,
          capabilities: {
            completion_chat: true,
            function_calling: true,
            vision: false,
          },
        },
      ],
    });
  }
}

interface MistralModelItem {
  id?: string;
  name?: string;
  description?: string;
  max_context_length?: number;
  maxContextLength?: number;
  capabilities?: {
    completion_chat?: boolean;
    chat_completion?: boolean;
    function_calling?: boolean;
    tools?: boolean;
    vision?: boolean;
  };
}

const MISTRAL_NON_CHAT_PATTERNS = ['embed', 'moderation', 'ocr', 'transcri', 'tts'] as const;

function dedupeModels(models: MistralModel[]): MistralModel[] {
  const byId = new Map<string, MistralModel>();
  for (const model of models) {
    if (!byId.has(model.id)) {
      byId.set(model.id, model);
    }
  }
  return [...byId.values()];
}

function buildModelDetail(model: MistralModel): string {
  return buildFallbackModelDetail(model.id, model);
}

function buildFallbackModelDetail(modelId: string, model?: MistralModel): string {
  const lower = modelId.toLowerCase();
  const details: string[] = [];
  details.push(
    (model?.capabilities?.vision ?? supportsVisionByName(lower)) ? 'vision' : 'text-only',
  );
  details.push(
    (model?.capabilities?.function_calling ?? supportsToolsByName(lower)) ? 'tools' : 'no tools',
  );
  if (supportsReasoningByName(lower)) {
    details.push('reasoning');
  }
  const maxOutput = estimateMistralMaxOutput(lower);
  if (maxOutput > 0) {
    details.push(`max ${formatTokenCount(maxOutput)} out`);
  }
  return details.join(' · ');
}

function buildModelWarning(model: MistralModel): string | undefined {
  const lower = model.id.toLowerCase();
  if (lower.includes('open-')) return 'open weights';
  if (lower.includes('labs-')) return 'labs';
  return undefined;
}

function estimateMistralModelTier(model: string, vision: boolean): ModelTier {
  if (model.includes('large') || model.includes('medium') || model.includes('magistral-medium'))
    return 'strong';
  if (
    model.includes('small') ||
    model.includes('codestral') ||
    model.includes('devstral') ||
    vision
  )
    return 'medium';
  return 'weak';
}

function estimateMistralContextWindow(model: string): number {
  if (model.includes('codestral')) return 256000;
  if (
    model.includes('large') ||
    model.includes('medium') ||
    model.includes('small') ||
    model.includes('magistral')
  )
    return 128000;
  return 32000;
}

function estimateMistralMaxOutput(model: string): number {
  if (model.includes('large') || model.includes('medium')) return 32768;
  if (model.includes('small') || model.includes('codestral') || model.includes('devstral'))
    return 32768;
  return 8192;
}

function supportsToolsByName(model: string): boolean {
  return !model.startsWith('open-') && !model.includes('pixtral-12b');
}

function supportsVisionByName(model: string): boolean {
  return model.includes('pixtral');
}

function supportsReasoningByName(model: string): boolean {
  return model.includes('magistral');
}
