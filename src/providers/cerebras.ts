import type {
  Provider, ChatMessage, ChatChunk, ToolDefinition,
  ToolCallMessage, ProviderCapabilities, ChatOptions, ModelInfo, ModelPickerInfo, ModelTier,
} from './types.js';

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
    return {
      contextWindow: estimateCerebrasContextWindow(lower),
      maxOutputTokens: estimateCerebrasMaxOutput(lower),
      toolSupport: supportsToolsByName(lower) ? 'native' : 'none',
      parallelToolCalls: supportsToolsByName(lower),
      streaming: true,
      tokenCounting: 'exact',
      modelTier: estimateCerebrasModelTier(lower),
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
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.requestHeaders(true),
      body: JSON.stringify(this.buildChatBody(model, messages, tools, true, options)),
      signal: options?.signal,
    });

    if (!res.ok) {
      // TODO: Cerebras can list models that are not actually inferable for the
      // current API key/project (for example gpt-oss-120b and zai-glm-4.7
      // returned model_not_found from /chat/completions while /models and
      // /models/{id} both succeeded). If Cerebras exposes per-project inference
      // availability metadata, surface that in the picker and error hints.
      throw new Error(`Cerebras API error ${res.status}: ${await res.text()}`);
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
      throw new Error(`Cerebras API error ${res.status}: ${await res.text()}`);
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
      body.parallel_tool_calls = true;
    }
    if (options?.maxTokens) {
      body.max_completion_tokens = options.maxTokens;
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

  private async getCatalog(): Promise<CerebrasModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.requestHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Cerebras API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as any;
    const rawItems = Array.isArray(data?.data) ? data.data : [];
    this.modelsCache = rawItems
      // Note: we currently keep every named Cerebras model the catalog returns
      // and do not try to infer chat eligibility beyond "has an id".
      .filter((item: any) => isCerebrasModel(item))
      .map((item: any) => ({
        id: item.id,
        owned_by: typeof item.owned_by === 'string' ? item.owned_by : undefined,
      }));

    return this.modelsCache ?? [];
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function isCerebrasModel(item: any): item is { id: string; owned_by?: string } {
  return Boolean(item && typeof item === 'object' && typeof item.id === 'string' && item.id);
}

function buildModelDetail(modelId: string): string {
  const lower = modelId.toLowerCase();
  const details: string[] = [];
  details.push(supportsVisionByName(lower) ? 'vision' : 'text-only');
  details.push(supportsToolsByName(lower) ? 'tools' : 'no tools');
  if (supportsReasoningByName(lower)) {
    details.push('reasoning');
  }
  details.push(`max ${formatTokenCount(estimateCerebrasMaxOutput(lower))} out`);
  details.push(`${formatTokenCount(estimateCerebrasContextWindow(lower))} ctx`);
  return details.join(' · ');
}

function buildModelWarning(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (isPreviewModel(lower)) return 'preview';
  if (isDeprecatedModel(lower)) return 'deprecated';
  return undefined;
}

function buildCapabilities(model: string): string[] {
  const capabilities: string[] = [];
  capabilities.push(supportsVisionByName(model) ? 'vision' : 'text');
  if (supportsToolsByName(model)) {
    capabilities.push('tool-use');
  }
  if (supportsReasoningByName(model)) {
    capabilities.push('reasoning');
  }
  return capabilities;
}

function estimateCerebrasModelTier(model: string): ModelTier {
  if (model.includes('gpt-oss-120b') || model.includes('zai-glm-4.7')) {
    return 'strong';
  }
  if (model.includes('qwen-3-235b')) {
    return 'medium';
  }
  return 'weak';
}

function estimateCerebrasContextWindow(model: string): number {
  if (model.includes('gpt-oss-120b')) return 131072;
  if (model.includes('zai-glm-4.7')) return 128000;
  if (model.includes('qwen-3-235b')) return 262144;
  if (model.includes('llama3.1-8b')) return 131072;
  return 128000;
}

function estimateCerebrasMaxOutput(model: string): number {
  if (model.includes('gpt-oss-120b') || model.includes('zai-glm-4.7')) return 65536;
  if (model.includes('qwen-3-235b')) return 32768;
  if (model.includes('llama3.1-8b')) return 8192;
  return 8192;
}

function supportsToolsByName(_model: string): boolean {
  return true;
}

function supportsVisionByName(_model: string): boolean {
  return false;
}

function supportsReasoningByName(model: string): boolean {
  return (
    model.includes('gpt-oss') ||
    model.includes('zai-glm') ||
    model.includes('qwen')
  );
}

function isPreviewModel(model: string): boolean {
  return model.includes('qwen-3-235b') || model.includes('zai-glm-4.7');
}

function isDeprecatedModel(model: string): boolean {
  return model.includes('llama3.1-8b');
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
