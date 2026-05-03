import type {
  Provider, ChatMessage, ChatChunk, ToolDefinition,
  ToolCallMessage, ProviderCapabilities, ChatOptions, ModelInfo, ModelPickerInfo, ModelTier,
} from './types.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const APP_TITLE = 'factory';
const APP_REFERER = 'https://github.com/vilaca/factory';

interface OpenRouterModel {
  id: string;
  context_length?: number;
  expiration_date?: string | null;
  supported_parameters?: string[];
  per_request_limits?: Record<string, unknown> | null;
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
    image?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
}

export class OpenRouterProvider implements Provider {
  name = 'openrouter';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private modelsCache: OpenRouterModel[] | null = null;

  constructor(options: { token?: string; host?: string } = {}) {
    const key = options.token ?? process.env.OPENROUTER_API_KEY;
    if (!key) {
      throw new Error(
        'OpenRouter API key required. Set OPENROUTER_API_KEY env var or use --token flag.'
      );
    }
    this.apiKey = key;
    this.baseUrl = normalizeBaseUrl(options.host ?? DEFAULT_BASE_URL);
  }

  async listModels(): Promise<string[]> {
    const models = await this.getCatalog();
    return [...new Set(models.map(model => model.id))];
  }

  getDisplayModelName(model: string): string {
    const match = this.modelsCache?.find(item => item.id === model);
    return match && isFreeModel(match) ? `${model.replace(/:free$/i, '')} (free)` : model;
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const match = this.modelsCache?.find(item => item.id === model);
    if (!match) {
      return { label: model };
    }

    return {
      label: this.getDisplayModelName(model),
      detail: buildModelDetail(match),
      warning: buildAvailabilityWarning(match),
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    const cached = this.modelsCache?.find(item => item.id === model);
    const contextWindow =
      cached?.top_provider?.context_length ??
      cached?.context_length ??
      estimateOpenRouterContextWindow(lower);
    const maxOutputTokens =
      cached?.top_provider?.max_completion_tokens ??
      estimateOpenRouterMaxOutput(lower);

    return {
      contextWindow,
      maxOutputTokens,
      toolSupport: 'native',
      parallelToolCalls: true,
      streaming: true,
      tokenCounting: 'exact',
      modelTier: estimateOpenRouterModelTier(lower),
    };
  }

  async getModelInfo(model: string): Promise<ModelInfo> {
    const models = await this.getCatalog();
    const match = models.find(item => item.id === model);
    if (!match) {
      return { supportsTools: true };
    }
    return {
      supportsTools: match.supported_parameters?.includes('tools') ?? false,
      capabilities: match.supported_parameters,
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.requestHeaders(true),
      body: JSON.stringify(this.buildChatBody(model, messages, tools, true, options)),
      signal: options?.signal,
    });

    if (!res.ok) {
      throw new Error(`OpenRouter API error ${res.status}: ${await res.text()}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let toolCalls: ChatChunk['tool_calls'] = undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]' || !trimmed.startsWith('data: ')) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(trimmed.slice(6));
        } catch {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) {
          yield { content: delta.content };
        }

        if (delta?.tool_calls) {
          if (!toolCalls) toolCalls = [];
          mergeStreamedToolCalls(toolCalls, delta.tool_calls);
        }

        const finishReason = parsed.choices?.[0]?.finish_reason;
        if (finishReason === 'stop' || finishReason === 'tool_calls') {
          yield { done: true, usage: extractUsage(parsed) };
        }
      }
    }

    if (toolCalls && toolCalls.length > 0) {
      const parsed = finalizeToolCalls(toolCalls);
      if (parsed.length > 0) {
        yield { tool_calls: parsed, done: true };
      }
    }
  }

  async chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify(this.buildChatBody(model, messages, tools, false, options)),
      signal: options?.signal,
    });

    if (!res.ok) {
      throw new Error(`OpenRouter API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as any;
    const choice = data.choices?.[0];
    const result: ChatChunk = {
      content: choice?.message?.content ?? undefined,
      done: true,
      usage: extractUsage(data),
    };

    if (choice?.message?.tool_calls) {
      result.tool_calls = choice.message.tool_calls.flatMap((tc: any) => {
        if (!tc?.function || typeof tc.function.name !== 'string' || !tc.function.name) {
          return [];
        }

        return [{
          id: tc.id,
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string'
              ? parseToolArgs(tc.function.arguments)
              : tc.function.arguments,
          },
        }];
      });
    }

    return result;
  }

  private requestHeaders(stream = false): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': APP_REFERER,
      'X-OpenRouter-Title': APP_TITLE,
    };
    if (stream) {
      headers.Accept = 'text/event-stream';
    }
    return headers;
  }

  private buildChatBody(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    stream: boolean,
    options?: ChatOptions,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: messages.map(message => this.formatMessage(message)),
      stream,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.parallel_tool_calls = true;
    }
    if (options?.maxTokens) {
      body.max_tokens = options.maxTokens;
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    return body;
  }

  private formatMessage(msg: ChatMessage): Record<string, unknown> {
    const formatted: Record<string, unknown> = {
      role: msg.role,
      content: msg.content,
    };

    if (msg.tool_calls) {
      formatted.tool_calls = msg.tool_calls.map(tc => ({
        id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments),
        },
      }));
    }

    if (msg.role === 'tool' && msg.tool_call_id) {
      formatted.tool_call_id = msg.tool_call_id;
    }

    return formatted;
  }

  private async getCatalog(): Promise<OpenRouterModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const res = await fetch(`${this.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Accept': 'application/json',
        'HTTP-Referer': APP_REFERER,
        'X-OpenRouter-Title': APP_TITLE,
      },
    });

    if (!res.ok) {
      throw new Error(`OpenRouter API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as any;
    const rawItems = Array.isArray(data?.data) ? data.data : [];
    const models = rawItems
      // Note: keep only models whose declared modalities include text I/O,
      // since this CLI currently talks in chat-completions-style text turns.
      .filter((item: any) => isChatCapableModel(item))
      .map((item: any) => ({
        id: item.id,
        context_length: typeof item.context_length === 'number' ? item.context_length : undefined,
        expiration_date: typeof item.expiration_date === 'string' ? item.expiration_date : null,
        supported_parameters: Array.isArray(item.supported_parameters)
          ? item.supported_parameters.filter((value: unknown): value is string => typeof value === 'string')
          : undefined,
        per_request_limits: item.per_request_limits && typeof item.per_request_limits === 'object'
          ? item.per_request_limits as Record<string, unknown>
          : null,
        pricing: item.pricing && typeof item.pricing === 'object'
          ? {
            prompt: typeof item.pricing.prompt === 'string' ? item.pricing.prompt : undefined,
            completion: typeof item.pricing.completion === 'string' ? item.pricing.completion : undefined,
            request: typeof item.pricing.request === 'string' ? item.pricing.request : undefined,
            image: typeof item.pricing.image === 'string' ? item.pricing.image : undefined,
          }
          : undefined,
        top_provider: item.top_provider && typeof item.top_provider === 'object'
          ? {
            context_length: typeof item.top_provider.context_length === 'number'
              ? item.top_provider.context_length
              : undefined,
            max_completion_tokens: typeof item.top_provider.max_completion_tokens === 'number'
              ? item.top_provider.max_completion_tokens
              : undefined,
          }
          : undefined,
        architecture: item.architecture && typeof item.architecture === 'object'
          ? {
            modality: typeof item.architecture.modality === 'string' ? item.architecture.modality : undefined,
            input_modalities: Array.isArray(item.architecture.input_modalities)
              ? item.architecture.input_modalities.filter((value: unknown): value is string => typeof value === 'string')
              : undefined,
            output_modalities: Array.isArray(item.architecture.output_modalities)
              ? item.architecture.output_modalities.filter((value: unknown): value is string => typeof value === 'string')
              : undefined,
          }
          : undefined,
       }));
    this.modelsCache = models;

    return models;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function isChatCapableModel(item: any): item is OpenRouterModel & { id: string } {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) {
    return false;
  }

  const modality = typeof item.architecture?.modality === 'string'
    ? item.architecture.modality.toLowerCase()
    : '';
  if (modality && !modality.includes('text')) {
    return false;
  }

  const inputModalities = Array.isArray(item.architecture?.input_modalities)
    ? item.architecture.input_modalities.map((value: unknown) => String(value).toLowerCase())
    : [];
  const outputModalities = Array.isArray(item.architecture?.output_modalities)
    ? item.architecture.output_modalities.map((value: unknown) => String(value).toLowerCase())
    : [];

  if (inputModalities.length > 0 && !inputModalities.includes('text')) {
    return false;
  }
  if (outputModalities.length > 0 && !outputModalities.includes('text')) {
    return false;
  }

  return true;
}

function isFreeModel(model: OpenRouterModel): boolean {
  if (/:free$/i.test(model.id)) {
    return true;
  }

  const values = [
    model.pricing?.prompt,
    model.pricing?.completion,
    model.pricing?.request,
    model.pricing?.image,
  ].filter((value): value is string => value !== undefined);

  return values.length > 0 && values.every(value => Number(value) === 0);
}

function buildModelDetail(model: OpenRouterModel): string {
  const details: string[] = [];

  details.push(hasVisionSupport(model) ? 'vision' : 'text-only');
  details.push(supportsParameter(model, 'tools') ? 'tools' : 'no tools');
  if (supportsParameter(model, 'reasoning')) {
    details.push('reasoning');
  }
  if (supportsParameter(model, 'structured_outputs') || supportsParameter(model, 'response_format')) {
    details.push('structured output');
  }

  const maxOutputTokens = model.top_provider?.max_completion_tokens;
  if (typeof maxOutputTokens === 'number' && maxOutputTokens > 0) {
    details.push(`max ${formatTokenCount(maxOutputTokens)} out`);
  }

  const freeLimits = buildFreeLimitDetail(model);
  if (freeLimits) {
    details.push(freeLimits);
  }

  return details.join(' · ');
}

function buildAvailabilityWarning(model: OpenRouterModel): string | undefined {
  if (model.expiration_date) {
    const expiration = Date.parse(model.expiration_date);
    if (!Number.isNaN(expiration)) {
      const msRemaining = expiration - Date.now();
      if (msRemaining <= 0) {
        return 'expired';
      }
      const daysRemaining = msRemaining / (1000 * 60 * 60 * 24);
      if (daysRemaining <= 30) {
        return `expires ${model.expiration_date}`;
      }
    }
  }

  if (!isFreeModel(model)) {
    return 'credits required';
  }

  return undefined;
}

function buildFreeLimitDetail(model: OpenRouterModel): string | undefined {
  const source = extractLimitSource(model.per_request_limits);
  if (!source) return undefined;

  const parts: string[] = [];
  const tokensPerMinute = readLimitValue(source, ['tokens_per_minute', 'tokensPerMinute', 'tpm']);
  const requestsPerDay = readLimitValue(source, ['requests_per_day', 'requestsPerDay', 'rpd']);
  const requestsPerMinute = readLimitValue(source, ['requests_per_minute', 'requestsPerMinute', 'rpm']);

  if (tokensPerMinute !== undefined) {
    parts.push(`free ${formatTokenCount(tokensPerMinute)} TPM`);
  }
  if (requestsPerDay !== undefined) {
    parts.push(`free ${formatLimitCount(requestsPerDay)} RPD`);
  }
  if (requestsPerMinute !== undefined) {
    parts.push(`free ${formatLimitCount(requestsPerMinute)} RPM`);
  }

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function extractLimitSource(limits: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  if (!limits) return undefined;

  const candidates = [
    limits,
    typeof limits.free === 'object' && limits.free !== null ? limits.free as Record<string, unknown> : undefined,
    typeof limits['free_tier'] === 'object' && limits['free_tier'] !== null
      ? limits['free_tier'] as Record<string, unknown>
      : undefined,
  ];

  return candidates.find(candidate =>
    candidate && (
      readLimitValue(candidate, ['tokens_per_minute', 'tokensPerMinute', 'tpm']) !== undefined ||
      readLimitValue(candidate, ['requests_per_day', 'requestsPerDay', 'rpd']) !== undefined ||
      readLimitValue(candidate, ['requests_per_minute', 'requestsPerMinute', 'rpm']) !== undefined
    )
  );
}

function readLimitValue(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = source[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
      return Number(raw);
    }
  }
  return undefined;
}

function hasVisionSupport(model: OpenRouterModel): boolean {
  const inputModalities = model.architecture?.input_modalities?.map(value => value.toLowerCase()) ?? [];
  const outputModalities = model.architecture?.output_modalities?.map(value => value.toLowerCase()) ?? [];
  return inputModalities.includes('image') || outputModalities.includes('image');
}

function supportsParameter(model: OpenRouterModel, name: string): boolean {
  return model.supported_parameters?.includes(name) ?? false;
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

function formatLimitCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  }
  return String(value);
}

function mergeStreamedToolCalls(target: NonNullable<ChatChunk['tool_calls']>, incoming: any[]): void {
  for (const tc of incoming) {
    const idx = tc.index ?? 0;
    if (!target[idx]) {
      target[idx] = {
        id: tc.id,
        function: { name: '', arguments: {} },
      };
    }
    if (tc.function?.name) {
      target[idx].function.name += tc.function.name;
    }
    if (tc.function?.arguments) {
      (target[idx].function as any).__rawArgs =
        ((target[idx].function as any).__rawArgs ?? '') + tc.function.arguments;
    }
  }
}

function finalizeToolCalls(toolCalls: NonNullable<ChatChunk['tool_calls']>): ToolCallMessage[] {
  return toolCalls.flatMap(tc => {
    if (!tc?.function || !tc.function.name) {
      return [];
    }
    return [{
      id: tc.id,
      function: {
        name: tc.function.name,
        arguments: parseToolArgs((tc.function as any).__rawArgs),
      },
    }];
  });
}

function parseToolArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function extractUsage(data: any): ChatChunk['usage'] {
  if (!data?.usage) return undefined;
  return {
    promptTokens: data.usage.prompt_tokens ?? 0,
    completionTokens: data.usage.completion_tokens ?? 0,
    totalTokens: data.usage.total_tokens ?? 0,
  };
}

function estimateOpenRouterModelTier(model: string): ModelTier {
  if (
    model.includes('opus') ||
    model.includes('sonnet') ||
    model.includes('gpt-5') ||
    model.includes('gpt-4.1') ||
    model.includes('o3') ||
    model.includes('o4') ||
    model.includes('gemini-2.5-pro') ||
    model.includes('deepseek-r1')
  ) {
    return 'strong';
  }
  if (model.includes('haiku') || model.includes('mini') || model.includes('flash')) {
    return 'medium';
  }
  return 'medium';
}

function estimateOpenRouterContextWindow(model: string): number {
  if (model.includes('claude')) return 200000;
  if (model.includes('gemini')) return 1048576;
  if (model.includes('gpt') || model.includes('o3') || model.includes('o4')) return 128000;
  return 128000;
}

function estimateOpenRouterMaxOutput(model: string): number {
  if (model.includes('mini') || model.includes('haiku') || model.includes('flash')) return 8192;
  return 16384;
}
