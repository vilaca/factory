import type {
  Provider, ChatMessage, ChatChunk, ToolDefinition,
  ToolCallMessage, ProviderCapabilities, ChatOptions, ModelInfo, ModelPickerInfo, ModelTier,
} from './types.js';

const DEFAULT_BASE_URL = 'https://ai-gateway.vercel.sh/v1';
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
      detail: buildModelDetail(match),
      warning: buildModelWarning(match),
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    const cached = this.modelsCache?.find(item => item.id === model);
    const supportsTools = cached?.tags?.includes('tool-use') ?? true;

    return {
      contextWindow: cached?.context_window ?? estimateVercelContextWindow(lower),
      maxOutputTokens: cached?.max_tokens ?? estimateVercelMaxOutput(lower),
      toolSupport: supportsTools ? 'native' : 'none',
      parallelToolCalls: supportsTools,
      streaming: true,
      tokenCounting: 'exact',
      modelTier: estimateVercelModelTier(lower),
    };
  }

  async getModelInfo(model: string): Promise<ModelInfo> {
    const models = await this.getCatalog();
    const match = models.find(item => item.id === model);
    if (!match) {
      return { supportsTools: true };
    }
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
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.requestHeaders(true, true),
      body: JSON.stringify(this.buildChatBody(model, messages, tools, true, options)),
      signal: options?.signal,
    });

    if (!res.ok) {
      throw new Error(formatApiError(res.status, await res.text()));
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
      headers: this.requestHeaders(false, true),
      body: JSON.stringify(this.buildChatBody(model, messages, tools, false, options)),
      signal: options?.signal,
    });

    if (!res.ok) {
      throw new Error(formatApiError(res.status, await res.text()));
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

  private requestHeaders(stream: boolean, requireAuth: boolean): Record<string, string> {
    if (requireAuth && !this.apiKey) {
      throw new Error(MISSING_TOKEN_ERROR);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': stream ? 'text/event-stream' : 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
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

  private async getCatalog(): Promise<VercelModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.requestHeaders(false, false),
    });

    if (!res.ok) {
      throw new Error(formatApiError(res.status, await res.text()));
    }

    const data = await res.json() as any;
    const rawItems = Array.isArray(data?.data) ? data.data : [];
    this.modelsCache = dedupeModels(rawItems
      // Note: Vercel's catalog includes multiple resource types; keep only
      // language models because this provider only targets chat text models.
      .filter((item: any) => isChatCapableVercelModel(item))
      .map((item: any) => ({
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
      })));

    return this.modelsCache;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function formatApiError(status: number, body: string): string {
  const base = `Vercel AI Gateway API error ${status}: ${body}`;
  if (status === 401) {
    // TODO: Detect 401s returned during model requests and replace this generic
    // hint with a response-specific explanation of the required AI Gateway key.
    return `${base}\nCheck --token, AI_GATEWAY_API_KEY, VERCEL_OIDC_TOKEN, and any saved vercelToken/token in your factory config.`;
  }
  if (status === 403) {
    // TODO: Detect 403s returned during model requests and replace this generic
    // error with a response-specific hint about the rejected model interaction.
    return base;
  }
  return base;
}

function isChatCapableVercelModel(item: any): item is VercelModel & { id: string } {
  return Boolean(
    item &&
    typeof item === 'object' &&
    typeof item.id === 'string' &&
    item.id &&
    item.type === 'language',
  );
}

function dedupeModels(models: VercelModel[]): VercelModel[] {
  const byId = new Map<string, VercelModel>();
  for (const model of models) {
    if (!byId.has(model.id)) {
      byId.set(model.id, model);
    }
  }
  return [...byId.values()];
}

function buildModelDetail(model: VercelModel): string {
  const lower = model.id.toLowerCase();
  const tags = new Set(model.tags ?? []);
  const details: string[] = [];

  details.push(tags.has('vision') ? 'vision' : 'text-only');
  details.push(tags.has('tool-use') ? 'tools' : 'no tools');
  if (tags.has('reasoning')) {
    details.push('reasoning');
  }
  if (tags.has('file-input')) {
    details.push('file input');
  }

  const maxOutput = model.max_tokens ?? estimateVercelMaxOutput(lower);
  if (maxOutput > 0) {
    details.push(`max ${formatTokenCount(maxOutput)} out`);
  }

  const contextWindow = model.context_window ?? estimateVercelContextWindow(lower);
  if (contextWindow > 0) {
    details.push(`${formatTokenCount(contextWindow)} ctx`);
  }

  return details.join(' · ');
}

function buildModelWarning(model: VercelModel): string | undefined {
  const searchable = `${model.id} ${model.name ?? ''}`.toLowerCase();
  if (searchable.includes('experimental') || searchable.includes('-exp')) {
    return 'experimental';
  }
  if (searchable.includes('preview')) {
    return 'preview';
  }
  if (searchable.includes('beta')) {
    return 'beta';
  }
  if (searchable.includes('deprecated')) {
    return 'deprecated';
  }
  return undefined;
}

function estimateVercelModelTier(model: string): ModelTier {
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
  if (
    model.includes('mini') ||
    model.includes('haiku') ||
    model.includes('flash') ||
    model.includes('small') ||
    model.includes('nano')
  ) {
    return 'medium';
  }
  return 'medium';
}

function estimateVercelContextWindow(model: string): number {
  if (model.includes('claude')) return 200000;
  if (model.includes('gemini')) return 1048576;
  if (model.includes('gpt') || model.includes('o3') || model.includes('o4')) return 128000;
  return 128000;
}

function estimateVercelMaxOutput(model: string): number {
  if (model.includes('mini') || model.includes('haiku') || model.includes('flash')) return 8192;
  return 16384;
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
