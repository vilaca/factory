import type {
  Provider, ChatMessage, ChatChunk, ToolDefinition,
  ToolCallMessage, ProviderCapabilities, ChatOptions, ModelInfo, ModelPickerInfo, ModelTier,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const MISSING_TOKEN_ERROR =
  'Groq API key required. Set GROQ_API_KEY env var or use --token flag.';

interface GroqModel {
  id: string;
  owned_by?: string;
}

export class GroqProvider implements Provider {
  name = 'groq';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private modelsCache: GroqModel[] | null = null;

  constructor(options: { token?: string; host?: string } = {}) {
    const key = options.token ?? process.env.GROQ_API_KEY;
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
    const supportsTools = supportsToolsByName(lower);

    return {
      contextWindow: estimateGroqContextWindow(lower),
      maxOutputTokens: estimateGroqMaxOutput(lower),
      toolSupport: supportsTools ? 'native' : 'none',
      parallelToolCalls: supportsParallelToolCalls(lower),
      streaming: true,
      tokenCounting: 'exact',
      modelTier: estimateGroqModelTier(lower),
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
      throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
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
      throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
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
    const lower = model.toLowerCase();
    const body: Record<string, unknown> = {
      model,
      messages: messages.map(message => this.formatMessage(message)),
      stream,
    };

    if (tools && tools.length > 0 && supportsToolsByName(lower)) {
      body.tools = tools;
      body.parallel_tool_calls = supportsParallelToolCalls(lower);
    }
    if (options?.maxTokens) {
      body.max_completion_tokens = options.maxTokens;
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature === 0 ? 1e-8 : options.temperature;
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

  private async getCatalog(): Promise<GroqModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.requestHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as any;
    const rawItems = Array.isArray(data?.data) ? data.data : [];
    this.modelsCache = rawItems
      .filter((item: any) => isGroqModel(item))
      // Note: exclude Groq models that are clearly speech/audio, guardrail, or
      // other non-chat endpoints even if they share the same catalog.
      .filter((item: any) => supportsChatCompletions(item.id))
      .map((item: any) => ({
        id: item.id,
        owned_by: typeof item.owned_by === 'string' ? item.owned_by : undefined,
      }));

    return this.modelsCache ?? [];
  }
}

function supportsChatCompletions(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return !(
    lower.includes('whisper') ||
    lower.includes('prompt-guard') ||
    lower.includes('orpheus') ||
    lower.includes('transcribe') ||
    lower.includes('tts')
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function isGroqModel(item: any): item is { id: string; owned_by?: string } {
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
  details.push(`max ${formatTokenCount(estimateGroqMaxOutput(lower))} out`);
  details.push(`${formatTokenCount(estimateGroqContextWindow(lower))} ctx`);
  return details.join(' · ');
}

function buildModelWarning(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (isPreviewModel(lower)) return 'preview';
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
  if (supportsParallelToolCalls(model)) {
    capabilities.push('parallel-tools');
  }
  return capabilities;
}

function estimateGroqModelTier(model: string): ModelTier {
  if (
    model.includes('openai/gpt-oss-120b') ||
    model.includes('llama-3.3-70b-versatile') ||
    model.includes('groq/compound')
  ) {
    return 'strong';
  }
  if (
    model.includes('openai/gpt-oss-20b') ||
    model.includes('meta-llama/llama-4-scout') ||
    model.includes('qwen/qwen3-32b')
  ) {
    return 'medium';
  }
  return 'weak';
}

function estimateGroqContextWindow(model: string): number {
  if (
    model.includes('llama-3.1-8b-instant') ||
    model.includes('llama-3.3-70b-versatile') ||
    model.includes('openai/gpt-oss-120b') ||
    model.includes('openai/gpt-oss-20b') ||
    model.includes('groq/compound') ||
    model.includes('meta-llama/llama-4-scout') ||
    model.includes('qwen/qwen3-32b')
  ) {
    return 131072;
  }
  return 8192;
}

function estimateGroqMaxOutput(model: string): number {
  if (model.includes('openai/gpt-oss-120b') || model.includes('openai/gpt-oss-20b')) return 65536;
  if (model.includes('qwen/qwen3-32b')) return 40960;
  if (model.includes('llama-3.3-70b-versatile')) return 32768;
  if (model.includes('groq/compound')) return 8192;
  if (model.includes('meta-llama/llama-4-scout')) return 8192;
  if (model.includes('llama-3.1-8b-instant')) return 131072;
  return 8192;
}

function supportsToolsByName(model: string): boolean {
  // TODO: Add support for Groq's server-side built-in tools / remote MCP flow
  // once the provider layer can represent provider-managed tool execution.
  // For now, groq/compound* models are treated as chat-only because this CLI
  // only supports local tool calling loops.
  return !model.startsWith('groq/compound');
}

function supportsParallelToolCalls(model: string): boolean {
  return (
    supportsToolsByName(model) &&
    !model.includes('openai/gpt-oss-20b') &&
    !model.includes('openai/gpt-oss-120b') &&
    !model.includes('openai/gpt-oss-safeguard-20b')
  );
}

function supportsVisionByName(model: string): boolean {
  return model.includes('llama-4-scout');
}

function supportsReasoningByName(model: string): boolean {
  return (
    model.includes('openai/gpt-oss') ||
    model.includes('qwen/qwen3-32b') ||
    model.includes('groq/compound')
  );
}

function isPreviewModel(model: string): boolean {
  return (
    model.includes('meta-llama/llama-4-scout') ||
    model.includes('qwen/qwen3-32b') ||
    model.includes('openai/gpt-oss-safeguard-20b')
  );
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
