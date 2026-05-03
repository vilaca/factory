import type {
  Provider, ChatMessage, ChatChunk, ToolDefinition,
  ToolCallMessage, ProviderCapabilities, ChatOptions, ModelInfo, ModelPickerInfo, ModelTier,
} from './types.js';

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
      throw new Error(`${this.displayName} API key required. Set ${this.envVarName} env var or use --token flag.`);
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

    return {
      contextWindow: cached?.max_context_length ?? estimateMistralContextWindow(lower),
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
        ...(match?.capabilities?.function_calling ?? supportsToolsByName(lower) ? ['function_calling'] : []),
      ],
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
      throw new Error(`Mistral API error ${res.status}: ${await res.text()}`);
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
        const content = extractContent(delta?.content);
        if (content) {
          yield { content };
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
      throw new Error(`Mistral API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as any;
    const choice = data.choices?.[0];
    const result: ChatChunk = {
      content: extractContent(choice?.message?.content),
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
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
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
      body.tool_choice = 'auto';
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

  private async getCatalog(): Promise<MistralModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const res = await fetch(`${this.baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      if (res.status === 404 && this.fallbackModels.length > 0) {
        this.modelsCache = dedupeModels(this.fallbackModels);
        return this.modelsCache;
      }
      throw new Error(`Mistral API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as any;
    const models = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.models)
        ? data.models
        : [];

    this.modelsCache = dedupeModels(models
      // Note: exclude obvious non-chat families (embedding/moderation/OCR/
      // transcription/TTS) so the picker stays focused on usable chat models.
      .filter((item: any) => isSupportedMistralModel(item))
      .map((item: any) => ({
        id: typeof item.id === 'string' ? item.id : item.name,
        name: typeof item.name === 'string' ? item.name : undefined,
        description: typeof item.description === 'string' ? item.description : undefined,
        max_context_length: typeof item.max_context_length === 'number'
          ? item.max_context_length
          : typeof item.maxContextLength === 'number'
            ? item.maxContextLength
            : undefined,
        capabilities: typeof item.capabilities === 'object' && item.capabilities
          ? {
            completion_chat: item.capabilities.completion_chat === true || item.capabilities.chat_completion === true,
            function_calling: item.capabilities.function_calling === true || item.capabilities.tools === true,
            vision: item.capabilities.vision === true,
          }
          : undefined,
      })));

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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function isSupportedMistralModel(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : null;
  if (!id) return false;
  const lower = id.toLowerCase();
  if (/(embed|moderation|ocr|transcri|tts)/i.test(lower)) return false;
  return true;
}

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
  details.push(model?.capabilities?.vision ?? supportsVisionByName(lower) ? 'vision' : 'text-only');
  details.push(model?.capabilities?.function_calling ?? supportsToolsByName(lower) ? 'tools' : 'no tools');
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
  if (model.includes('large') || model.includes('medium') || model.includes('magistral-medium')) return 'strong';
  if (model.includes('small') || model.includes('codestral') || model.includes('devstral') || vision) return 'medium';
  return 'weak';
}

function estimateMistralContextWindow(model: string): number {
  if (model.includes('codestral')) return 256000;
  if (model.includes('large') || model.includes('medium') || model.includes('small') || model.includes('magistral')) return 128000;
  return 32000;
}

function estimateMistralMaxOutput(model: string): number {
  if (model.includes('large') || model.includes('medium')) return 32768;
  if (model.includes('small') || model.includes('codestral') || model.includes('devstral')) return 32768;
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

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  }
  return String(value);
}

function extractContent(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .flatMap((item: any) => item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [])
      .join('');
    return text || undefined;
  }
  return undefined;
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
