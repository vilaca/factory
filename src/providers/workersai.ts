import type {
  Provider, ChatMessage, ChatChunk, ToolDefinition,
  ToolCallMessage, ProviderCapabilities, ChatOptions, ModelInfo, ModelPickerInfo, ModelTier,
} from './types.js';

const DEFAULT_API_ROOT = 'https://api.cloudflare.com/client/v4';
const MISSING_TOKEN_ERROR =
  'Cloudflare Workers AI API token required. Set CLOUDFLARE_API_TOKEN env var or use --token flag.';
const MISSING_ACCOUNT_ID_ERROR =
  'Cloudflare Workers AI account ID required. Set CLOUDFLARE_ACCOUNT_ID env var or save workersAiAccountId in config.';
// TODO: Harden model-search normalization against more real Cloudflare
// /ai/models/search response variants as they show up in production.

interface WorkersAiModel {
  id: string;
  description?: string;
  taskName?: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  experimental?: boolean;
}

export class WorkersAiProvider implements Provider {
  name = 'workersai';
  private readonly apiKey: string;
  private readonly accountId: string;
  private readonly chatBaseUrl: string;
  private readonly modelSearchUrl: string;
  private modelsCache: WorkersAiModel[] | null = null;

  constructor(options: { token?: string; host?: string; accountId?: string } = {}) {
    const key = options.token ?? process.env.CLOUDFLARE_API_TOKEN;
    if (!key) {
      throw new Error(MISSING_TOKEN_ERROR);
    }
    const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? inferAccountIdFromHost(options.host);
    if (!accountId) {
      throw new Error(MISSING_ACCOUNT_ID_ERROR);
    }

    this.apiKey = key;
    this.accountId = accountId;
    this.chatBaseUrl = normalizeChatBaseUrl(options.host, accountId);
    this.modelSearchUrl = normalizeModelSearchUrl(options.host, accountId);
  }

  async listModels(): Promise<string[]> {
    const models = await this.getCatalog();
    return [...new Set(models.map(model => model.id))];
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const match = this.modelsCache?.find(item => item.id === model);
    return {
      label: model,
      detail: buildModelDetail(model, match),
      warning: buildModelWarning(model, match),
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    const match = this.modelsCache?.find(item => item.id === model);
    const supportsTools = match?.supportsTools ?? supportsToolsByName(lower);
    const supportsVision = match?.supportsVision ?? supportsVisionByName(lower);
    const supportsReasoning = match?.supportsReasoning ?? supportsReasoningByName(lower);

    return {
      contextWindow: match?.contextWindow ?? estimateWorkersAiContextWindow(lower),
      maxOutputTokens: estimateWorkersAiMaxOutput(lower),
      toolSupport: supportsTools ? 'native' : 'none',
      parallelToolCalls: supportsTools,
      streaming: true,
      tokenCounting: 'exact',
      modelTier: estimateWorkersAiModelTier(lower, supportsVision, supportsReasoning),
    };
  }

  async getModelInfo(model: string): Promise<ModelInfo> {
    const lower = model.toLowerCase();
    await this.getCatalog();
    const match = this.modelsCache?.find(item => item.id === model);
    return {
      supportsTools: match?.supportsTools ?? supportsToolsByName(lower),
      capabilities: buildCapabilities(lower, match),
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const res = await fetch(`${this.chatBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.requestHeaders(true),
      body: JSON.stringify(this.buildChatBody(model, messages, tools, true, options)),
      signal: options?.signal,
    });

    if (!res.ok) {
      throw new Error(`Cloudflare Workers AI API error ${res.status}: ${await res.text()}`);
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
    const res = await fetch(`${this.chatBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify(this.buildChatBody(model, messages, tools, false, options)),
      signal: options?.signal,
    });

    if (!res.ok) {
      throw new Error(`Cloudflare Workers AI API error ${res.status}: ${await res.text()}`);
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

  private async getCatalog(): Promise<WorkersAiModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const models: WorkersAiModel[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const url = new URL(this.modelSearchUrl);
      url.searchParams.set('page', String(page));
      url.searchParams.set('per_page', String(perPage));
      url.searchParams.set('hide_experimental', 'false');

      const res = await fetch(url, {
        headers: this.requestHeaders(),
      });

      if (!res.ok) {
        throw new Error(`Cloudflare Workers AI API error ${res.status}: ${await res.text()}`);
      }

      const data = await res.json() as any;
      const pageItems = Array.isArray(data?.result) ? data.result : [];
      const normalized = pageItems.flatMap((item: any) => normalizeModel(item))
        // Note: keep only text-generation entries for now; if Cloudflare starts
        // labeling useful chat models differently, this filter may need to widen.
        .filter((model: WorkersAiModel) => model.taskName === undefined || model.taskName === 'text generation');

      models.push(...normalized);

      if (pageItems.length < perPage) break;
      page++;
    }

    const unique = new Map<string, WorkersAiModel>();
    for (const model of models) {
      if (!unique.has(model.id)) {
        unique.set(model.id, model);
      }
    }

    this.modelsCache = [...unique.values()];
    return this.modelsCache;
  }
}

function inferAccountIdFromHost(host?: string): string | undefined {
  if (!host) return undefined;
  const match = host.match(/\/accounts\/([^/]+)/);
  return match?.[1];
}

function normalizeChatBaseUrl(host: string | undefined, accountId: string): string {
  if (!host) return `${DEFAULT_API_ROOT}/accounts/${accountId}/ai/v1`;
  const normalized = host.replace(/\/+$/, '');
  if (/\/ai\/v1$/.test(normalized)) return normalized;
  if (/\/accounts\/[^/]+\/ai$/.test(normalized)) return `${normalized}/v1`;
  if (/\/accounts\/[^/]+$/.test(normalized)) return `${normalized}/ai/v1`;
  return normalized;
}

function normalizeModelSearchUrl(host: string | undefined, accountId: string): string {
  const base = host ? host.replace(/\/+$/, '') : `${DEFAULT_API_ROOT}/accounts/${accountId}/ai/v1`;
  if (/\/ai\/v1$/.test(base)) return base.replace(/\/ai\/v1$/, '/ai/models/search');
  if (/\/accounts\/[^/]+\/ai$/.test(base)) return `${base}/models/search`;
  if (/\/accounts\/[^/]+$/.test(base)) return `${base}/ai/models/search`;
  return `${DEFAULT_API_ROOT}/accounts/${accountId}/ai/models/search`;
}

function normalizeModel(item: any): WorkersAiModel[] {
  const id = typeof item?.name === 'string'
    ? item.name
    : typeof item?.id === 'string'
      ? item.id
      : typeof item?.model === 'string'
        ? item.model
        : undefined;
  if (!id) return [];

  const taskName = normalizeTaskName(item?.task);
  return [{
    id,
    description: typeof item?.description === 'string' ? item.description : undefined,
    taskName,
    contextWindow: pickFirstNumber(
      item?.context_window,
      item?.context_length,
      item?.max_context_tokens,
      item?.properties?.context_window,
    ),
    supportsTools: pickCapability(item, 'function'),
    supportsReasoning: pickCapability(item, 'reason'),
    supportsVision: pickCapability(item, 'vision'),
    experimental: item?.experimental === true || hasTag(item, 'experimental'),
  }];
}

function normalizeTaskName(task: any): string | undefined {
  const raw = typeof task === 'string'
    ? task
    : typeof task?.name === 'string'
      ? task.name
      : typeof task?.description === 'string'
        ? task.description
        : undefined;
  return raw?.toLowerCase();
}

function pickFirstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickCapability(item: any, keyword: string): boolean | undefined {
  if (typeof item?.[`supports_${keyword}`] === 'boolean') return item[`supports_${keyword}`];
  if (typeof item?.capabilities?.[keyword] === 'boolean') return item.capabilities[keyword];
  if (hasTag(item, keyword)) return true;
  return undefined;
}

function hasTag(item: any, keyword: string): boolean {
  const lower = keyword.toLowerCase();
  const tags = [
    ...(Array.isArray(item?.tags) ? item.tags : []),
    ...(Array.isArray(item?.capabilities) ? item.capabilities : []),
    ...(Array.isArray(item?.features) ? item.features : []),
  ];
  return tags.some(tag => typeof tag === 'string' && tag.toLowerCase().includes(lower));
}

function buildModelDetail(model: string, cached?: WorkersAiModel): string {
  const lower = model.toLowerCase();
  const supportsVision = cached?.supportsVision ?? supportsVisionByName(lower);
  const supportsTools = cached?.supportsTools ?? supportsToolsByName(lower);
  const supportsReasoning = cached?.supportsReasoning ?? supportsReasoningByName(lower);
  const contextWindow = cached?.contextWindow ?? estimateWorkersAiContextWindow(lower);

  const details: string[] = [];
  details.push(supportsVision ? 'vision' : 'text-only');
  details.push(supportsTools ? 'tools' : 'no tools');
  if (supportsReasoning) details.push('reasoning');
  details.push(`max ${formatTokenCount(estimateWorkersAiMaxOutput(lower))} out`);
  details.push(`${formatTokenCount(contextWindow)} ctx`);
  return details.join(' · ');
}

function buildModelWarning(model: string, cached?: WorkersAiModel): string | undefined {
  const lower = model.toLowerCase();
  if (cached?.experimental || lower.includes('experimental') || lower.includes('preview')) return 'preview';
  return undefined;
}

function buildCapabilities(model: string, cached?: WorkersAiModel): string[] {
  const capabilities: string[] = [];
  capabilities.push((cached?.supportsVision ?? supportsVisionByName(model)) ? 'vision' : 'text');
  if (cached?.supportsTools ?? supportsToolsByName(model)) {
    capabilities.push('tool-use');
  }
  if (cached?.supportsReasoning ?? supportsReasoningByName(model)) {
    capabilities.push('reasoning');
  }
  return capabilities;
}

function supportsToolsByName(model: string): boolean {
  return !(
    model.includes('guard') ||
    model.includes('classification')
  );
}

function supportsVisionByName(model: string): boolean {
  return model.includes('vision') || model.includes('llama-4-scout') || model.includes('gemma-4');
}

function supportsReasoningByName(model: string): boolean {
  return (
    model.includes('gpt-oss') ||
    model.includes('kimi-k2') ||
    model.includes('qwq') ||
    model.includes('deepseek') ||
    model.includes('reason') ||
    model.includes('qwen3') ||
    model.includes('glm-4.7') ||
    model.includes('nemotron')
  );
}

function estimateWorkersAiContextWindow(model: string): number {
  if (model.includes('kimi-k2.6')) return 262144;
  if (model.includes('kimi-k2.5')) return 256000;
  if (model.includes('qwen2.5-coder-32b-instruct')) return 32768;
  if (
    model.includes('gpt-oss') ||
    model.includes('llama-3.1') ||
    model.includes('llama-3.3') ||
    model.includes('llama-4-scout') ||
    model.includes('gemma-3') ||
    model.includes('gemma-4') ||
    model.includes('qwen3') ||
    model.includes('qwq') ||
    model.includes('glm-4.7') ||
    model.includes('mistral-small-3.1') ||
    model.includes('nemotron')
  ) {
    return 131072;
  }
  return 8192;
}

function estimateWorkersAiMaxOutput(model: string): number {
  if (model.includes('gpt-oss-120b')) return 65536;
  if (model.includes('gpt-oss-20b')) return 65536;
  if (model.includes('kimi-k2.6') || model.includes('kimi-k2.5')) return 32768;
  if (model.includes('qwen3') || model.includes('deepseek') || model.includes('qwq')) return 16384;
  return 8192;
}

function estimateWorkersAiModelTier(model: string, supportsVision: boolean, supportsReasoning: boolean): ModelTier {
  if (
    model.includes('gpt-oss-120b') ||
    model.includes('kimi-k2.6') ||
    model.includes('llama-4-scout') ||
    model.includes('nemotron')
  ) {
    return 'strong';
  }
  if (supportsReasoning || supportsVision || model.includes('qwen2.5-coder-32b-instruct') || model.includes('mistral-small-3.1')) {
    return 'medium';
  }
  return 'weak';
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
