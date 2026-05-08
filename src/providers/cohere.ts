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

const DEFAULT_BASE_URL = 'https://api.cohere.com';
const MISSING_TOKEN_ERROR =
  'Cohere API key required. Set COHERE_API_KEY env var or use --token flag.';
// TODO: Only Cohere trial keys have been tested so far. Re-check model
// availability, tool calling, and rate-limit behavior with production keys.
// TODO: Implement true Cohere streaming in chat() and flip getCapabilities()
// back to streaming: true. Today chat() delegates to chatNoStream() so we
// advertise streaming: false to keep the capability honest for callers.

interface CohereModel {
  name: string;
  endpoints?: string[];
  context_length?: number;
  is_deprecated?: boolean;
}

export class CohereProvider implements Provider {
  name = 'cohere';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private modelsCache: CohereModel[] | null = null;

  constructor(options: { token?: string; host?: string } = {}) {
    const key = options.token ?? process.env.COHERE_API_KEY;
    if (!key) {
      throw new Error(MISSING_TOKEN_ERROR);
    }
    this.apiKey = key;
    this.baseUrl = normalizeBaseUrl(options.host ?? DEFAULT_BASE_URL);
  }

  async listModels(): Promise<string[]> {
    const models = await this.getCatalog();
    return [...new Set(models.map(model => model.name))];
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const match = this.modelsCache?.find(item => item.name === model);
    return {
      label: model,
      detail: buildModelDetail(model, match),
      warning: buildModelWarning(model, match),
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    const match = this.modelsCache?.find(item => item.name === model);
    const supportsTools = supportsToolsByName(lower);

    return {
      contextWindow: match?.context_length ?? estimateCohereContextWindow(lower),
      maxOutputTokens: estimateCohereMaxOutput(lower),
      toolSupport: supportsTools ? 'native' : 'none',
      parallelToolCalls: supportsTools,
      streaming: false,
      tokenCounting: 'exact',
      modelTier: estimateCohereModelTier(lower),
    };
  }

  async getModelInfo(model: string): Promise<ModelInfo> {
    await this.getCatalog();
    const lower = model.toLowerCase();
    return {
      supportsTools: supportsToolsByName(lower),
      capabilities: buildCapabilities(lower),
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const result = await this.chatNoStream(model, messages, tools, options);

    if (result.content) {
      yield { content: result.content };
    }
    if (result.tool_calls && result.tool_calls.length > 0) {
      yield {
        tool_calls: result.tool_calls,
        usage: result.usage,
        doneReason: result.doneReason,
        done: true,
      };
      return;
    }

    yield { usage: result.usage, doneReason: result.doneReason, done: true };
  }

  async chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    const res = await fetch(`${this.baseUrl}/v2/chat`, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify(this.buildChatBody(model, messages, tools, false, options)),
      signal: options?.signal,
    });

    if (!res.ok) {
      throw new Error(`Cohere API error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    const result: ChatChunk = {
      content: extractTextContent(data?.message?.content),
      done: true,
      doneReason: normalizeFinishReason(data?.finish_reason),
      usage: extractUsage(data),
    };

    if (Array.isArray(data?.message?.tool_calls)) {
      result.tool_calls = data.message.tool_calls.flatMap((tc: any) => {
        if (!tc?.function || typeof tc.function.name !== 'string' || !tc.function.name) {
          return [];
        }

        return [
          {
            id: typeof tc.id === 'string' ? tc.id : undefined,
            function: {
              name: tc.function.name,
              arguments:
                typeof tc.function.arguments === 'string'
                  ? parseToolArgs(tc.function.arguments)
                  : (tc.function.arguments ?? {}),
            },
          },
        ];
      });
    }

    return result;
  }

  private requestHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
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
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      return {
        role: 'assistant',
        ...(msg.content ? { tool_plan: msg.content } : {}),
        tool_calls: msg.tool_calls.map(tc => ({
          id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: JSON.stringify(tc.function.arguments),
          },
        })),
      };
    }

    if (msg.role === 'tool' && msg.tool_call_id) {
      return {
        role: 'tool',
        tool_call_id: msg.tool_call_id,
        content: msg.content,
      };
    }

    return {
      role: msg.role,
      content: msg.content,
    };
  }

  private async getCatalog(): Promise<CohereModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const models: CohereModel[] = [];
    let nextPageToken: string | undefined;

    do {
      const url = new URL(`${this.baseUrl}/v1/models`);
      // Note: ask Cohere only for chat-capable models up front instead of
      // listing unrelated endpoints and filtering them locally afterwards.
      url.searchParams.set('endpoint', 'chat');
      url.searchParams.set('page_size', '1000');
      if (nextPageToken) {
        url.searchParams.set('page_token', nextPageToken);
      }

      const res = await fetch(url, {
        headers: this.requestHeaders(),
      });

      if (!res.ok) {
        throw new Error(`Cohere API error ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as any;
      const pageModels = Array.isArray(data?.models) ? data.models : [];
      models.push(...pageModels.flatMap((item: any) => normalizeModel(item)));
      nextPageToken =
        typeof data?.next_page_token === 'string' && data.next_page_token
          ? data.next_page_token
          : undefined;
    } while (nextPageToken);

    this.modelsCache = models;
    return models;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function normalizeModel(item: any): CohereModel[] {
  const name =
    typeof item?.name === 'string' ? item.name : typeof item?.id === 'string' ? item.id : undefined;
  if (!name) return [];

  return [
    {
      name,
      endpoints: Array.isArray(item?.endpoints)
        ? item.endpoints.filter((entry: unknown): entry is string => typeof entry === 'string')
        : undefined,
      context_length: typeof item?.context_length === 'number' ? item.context_length : undefined,
      is_deprecated: item?.is_deprecated === true,
    },
  ];
}

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((item: any) => (item?.type === 'text' && typeof item.text === 'string' ? item.text : ''))
    .join('');
  return text || undefined;
}

function extractUsage(data: any): ChatChunk['usage'] {
  const input = data?.meta?.tokens?.input_tokens ?? data?.meta?.billed_units?.input_tokens;
  const output = data?.meta?.tokens?.output_tokens ?? data?.meta?.billed_units?.output_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return undefined;

  const promptTokens = typeof input === 'number' ? input : 0;
  const completionTokens = typeof output === 'number' ? output : 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

function normalizeFinishReason(reason: unknown): string | undefined {
  return typeof reason === 'string' ? reason.toLowerCase() : undefined;
}

function parseToolArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function supportsToolsByName(model: string): boolean {
  return model.startsWith('command-') || model.startsWith('c4ai-command');
}

function estimateCohereContextWindow(model: string): number {
  if (model.startsWith('command-') || model.startsWith('c4ai-command')) return 256000;
  return 128000;
}

function estimateCohereMaxOutput(model: string): number {
  if (model.startsWith('command-') || model.startsWith('c4ai-command')) return 8192;
  return 4096;
}

function estimateCohereModelTier(model: string): ModelTier {
  if (model.startsWith('command-a')) return 'strong';
  if (model.includes('command-r-plus') || model.includes('command-r08')) return 'strong';
  if (model.includes('command-r')) return 'medium';
  return 'weak';
}

function buildCapabilities(model: string): string[] {
  const capabilities = ['text'];
  if (supportsToolsByName(model)) {
    capabilities.push('tool-use', 'reasoning');
  }
  return capabilities;
}

function buildModelDetail(model: string, cached?: CohereModel): string {
  const lower = model.toLowerCase();
  const details = ['text-only'];
  if (supportsToolsByName(lower)) {
    details.push('tools', 'reasoning');
  } else {
    details.push('no tools');
  }
  details.push(`max ${formatTokenCount(estimateCohereMaxOutput(lower))} out`);
  details.push(
    `${formatTokenCount(cached?.context_length ?? estimateCohereContextWindow(lower))} ctx`,
  );
  return details.join(' · ');
}

function buildModelWarning(model: string, cached?: CohereModel): string | undefined {
  const lower = model.toLowerCase();
  if (cached?.is_deprecated) return 'deprecated';
  if (lower.includes('preview') || lower.includes('nightly')) return 'preview';
  return undefined;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions.toFixed(millions % 1 === 0 ? 0 : 1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands.toFixed(thousands % 1 === 0 ? 0 : 1).replace(/\.0$/, '')}k`;
  }
  return String(value);
}
