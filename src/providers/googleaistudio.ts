import type {
  Provider, ChatMessage, ChatChunk, ToolDefinition,
  ToolCallMessage, ProviderCapabilities, ChatOptions, ModelInfo, ModelPickerInfo, ModelTier,
} from './types.js';
import type { GoogleAiStudioAuthMode } from '../core/config-types.js';
import { appendProviderLog } from '../core/session-log.js';
import { GoogleAiStudioAuthManager } from './googleaistudio-auth.js';

const DEFAULT_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

interface GoogleAiStudioModel {
  name: string;
  baseModelId: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
}

export class GoogleAiStudioProvider implements Provider {
  name = 'googleaistudio';
  private readonly openAiBaseUrl: string;
  private readonly modelsBaseUrl: string;
  private readonly auth: GoogleAiStudioAuthManager;
  private modelsCache: GoogleAiStudioModel[] | null = null;

  constructor(options: { token?: string; host?: string; authMode?: GoogleAiStudioAuthMode } = {}) {
    const key = options.token ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    this.auth = new GoogleAiStudioAuthManager({
      apiKey: key,
      authMode: options.authMode,
    });
    this.openAiBaseUrl = normalizeOpenAiBaseUrl(options.host ?? DEFAULT_OPENAI_BASE_URL);
    this.modelsBaseUrl = deriveModelsBaseUrl(this.openAiBaseUrl);
  }

  async listModels(): Promise<string[]> {
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'diagnostic',
      action: 'list-models',
      detail: `listing models via ${this.modelsBaseUrl}/models`,
    });
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'diagnostic',
      action: 'auth-diagnostics',
      detail: formatDiagnostics(this.auth.getDiagnostics()),
    });
    const models = await this.getCatalog();
    const ids = [...new Set(models.map(model => model.baseModelId))];
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'diagnostic',
      action: 'usable-models',
      detail: `usable models after filtering: ${ids.length}`,
    });
    return ids;
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const match = this.modelsCache?.find(item => item.baseModelId === model);
    if (!match) {
      return { label: model };
    }

    return {
      label: isLegacyGoogleAiStudioModel(match.baseModelId) ? `${model} (legacy)` : model,
      detail: buildModelDetail(match),
      warning: buildModelWarning(match),
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    const cached = this.modelsCache?.find(item => item.baseModelId === model);

    return {
      contextWindow: cached?.inputTokenLimit ?? estimateGoogleAiStudioContextWindow(lower),
      maxOutputTokens: cached?.outputTokenLimit ?? estimateGoogleAiStudioMaxOutput(lower),
      toolSupport: 'native',
      parallelToolCalls: true,
      streaming: true,
      tokenCounting: 'exact',
      modelTier: estimateGoogleAiStudioModelTier(lower),
    };
  }

  async getModelInfo(model: string): Promise<ModelInfo> {
    const models = await this.getCatalog();
    const match = models.find(item => item.baseModelId === model);
    if (!match) {
      return { supportsTools: true };
    }

    const capabilities = [
      ...(match.supportedGenerationMethods ?? []),
      ...(match.thinking ? ['thinking'] : []),
    ];

    return {
      supportsTools: true,
      capabilities,
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const headers = await this.auth.getChatHeaders();
    const res = await fetch(`${this.openAiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(this.buildChatBody(model, messages, tools, true, options)),
      signal: options?.signal,
    });

    if (!res.ok) {
      throw new Error(`Google AI Studio API error ${res.status}: ${await res.text()}`);
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
    const headers = await this.auth.getChatHeaders();
    const res = await fetch(`${this.openAiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.buildChatBody(model, messages, tools, false, options)),
      signal: options?.signal,
    });

    if (!res.ok) {
      throw new Error(`Google AI Studio API error ${res.status}: ${await res.text()}`);
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

  private async getCatalog(): Promise<GoogleAiStudioModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const models: GoogleAiStudioModel[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${this.modelsBaseUrl}/models`);
      url.searchParams.set('pageSize', '1000');
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken);
      }

      const res = await fetch(url, {
        headers: {
          ...(await this.auth.getModelsHeaders()),
          'Accept': 'application/json',
        },
      });

      appendProviderLog({
        provider: 'googleaistudio',
        category: 'diagnostic',
        action: 'models-status',
        detail: `${res.status} ${res.statusText}`,
      });

      if (!res.ok) {
        // TODO: Detect Gemini SERVICE_DISABLED / PERMISSION_DENIED responses here
        // and surface a clearer message with the activationUrl plus propagation delay hint.
        throw new Error(`Google AI Studio API error ${res.status}: ${await res.text()}`);
      }

      const data = await res.json() as any;
      const pageModels = Array.isArray(data?.models) ? data.models : [];
      // Note: we intentionally keep only generateContent-capable text/chat
      // models and drop embeddings, image/video, speech/music, and live APIs.
      const supportedModels = pageModels.filter((item: any) => isSupportedGoogleAiStudioModel(item));
      appendProviderLog({
        provider: 'googleaistudio',
        category: 'diagnostic',
        action: 'models-filtering',
        detail: `models.list returned ${pageModels.length} models; ${supportedModels.length} survived filtering`,
      });
      if (pageModels.length > 0 && supportedModels.length === 0) {
        appendProviderLog({
          provider: 'googleaistudio',
          category: 'diagnostic',
          action: 'sample-model-ids',
          detail: pageModels.slice(0, 10).map((item: any) => item?.baseModelId ?? item?.name ?? '<unknown>').join(', '),
        });
      }
      models.push(...pageModels
        .filter((item: any) => isSupportedGoogleAiStudioModel(item))
        .map((item: any) => ({
          name: item.name,
          baseModelId: getGoogleAiStudioModelId(item),
          displayName: typeof item.displayName === 'string' ? item.displayName : undefined,
          description: typeof item.description === 'string' ? item.description : undefined,
          inputTokenLimit: typeof item.inputTokenLimit === 'number' ? item.inputTokenLimit : undefined,
          outputTokenLimit: typeof item.outputTokenLimit === 'number' ? item.outputTokenLimit : undefined,
          supportedGenerationMethods: Array.isArray(item.supportedGenerationMethods)
            ? item.supportedGenerationMethods.filter((value: unknown): value is string => typeof value === 'string')
            : undefined,
          thinking: item.thinking === true,
        })));

      pageToken = typeof data?.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
    } while (pageToken);

    this.modelsCache = dedupeModels(models);
    return this.modelsCache;
  }
}

function normalizeOpenAiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function deriveModelsBaseUrl(openAiBaseUrl: string): string {
  return openAiBaseUrl.replace(/\/openai\/?$/, '');
}

function isSupportedGoogleAiStudioModel(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  const modelId = getGoogleAiStudioModelId(item);
  if (typeof item.name !== 'string' || !modelId) return false;

  const methods = Array.isArray(item.supportedGenerationMethods)
    ? item.supportedGenerationMethods.filter((value: unknown): value is string => typeof value === 'string')
    : [];
  if (!methods.includes('generateContent')) return false;

  const searchableId = `${item.name} ${modelId} ${item.displayName ?? ''}`.toLowerCase();
  if (/(embedding|imagen|veo|lyria|robotics)/i.test(searchableId)) {
    return false;
  }
  if (/(?:^|[\s/_:-])(tts|speech|music|image|video|live)(?:$|[\s/_:-])/i.test(searchableId)) {
    return false;
  }

  return true;
}

function getGoogleAiStudioModelId(item: any): string | null {
  if (typeof item?.baseModelId === 'string' && item.baseModelId) {
    return item.baseModelId;
  }
  if (typeof item?.name === 'string' && item.name.startsWith('models/')) {
    return item.name.slice('models/'.length);
  }
  return null;
}

function isLegacyGoogleAiStudioModel(modelId: string): boolean {
  return (
    modelId === 'gemini-2.0-flash' ||
    modelId === 'gemini-2.0-flash-001' ||
    modelId === 'gemini-2.0-flash-lite' ||
    modelId === 'gemini-2.0-flash-lite-001'
  );
}

function dedupeModels(models: GoogleAiStudioModel[]): GoogleAiStudioModel[] {
  const byId = new Map<string, GoogleAiStudioModel>();
  for (const model of models) {
    if (!byId.has(model.baseModelId)) {
      byId.set(model.baseModelId, model);
    }
  }
  return [...byId.values()];
}

function buildModelDetail(model: GoogleAiStudioModel): string {
  const lower = model.baseModelId.toLowerCase();
  const details = ['tools'];
  if (model.thinking) {
    details.push('reasoning');
  }
  const maxOutputTokens = model.outputTokenLimit ?? estimateGoogleAiStudioMaxOutput(lower);
  if (maxOutputTokens > 0) {
    details.push(`max ${formatTokenCount(maxOutputTokens)} out`);
  }
  const contextWindow = model.inputTokenLimit ?? estimateGoogleAiStudioContextWindow(lower);
  if (contextWindow > 0) {
    details.push(`${formatTokenCount(contextWindow)} ctx`);
  }
  return details.join(' · ');
}

function buildModelWarning(model: GoogleAiStudioModel): string | undefined {
  if (isLegacyGoogleAiStudioModel(model.baseModelId)) {
    return 'legacy - no longer available to new users';
  }
  const searchable = `${model.baseModelId} ${model.displayName ?? ''}`.toLowerCase();
  if (searchable.includes('experimental') || searchable.includes('-exp')) {
    return 'experimental';
  }
  if (searchable.includes('preview')) {
    return 'preview';
  }
  if (searchable.includes('deprecated')) {
    return 'deprecated';
  }
  return undefined;
}

function estimateGoogleAiStudioModelTier(model: string): ModelTier {
  if (model.includes('pro')) return 'strong';
  if (model.includes('flash-lite')) return 'weak';
  return 'medium';
}

function estimateGoogleAiStudioContextWindow(model: string): number {
  if (model.includes('flash') || model.includes('pro')) return 1_000_000;
  return 128000;
}

function estimateGoogleAiStudioMaxOutput(model: string): number {
  if (model.includes('pro')) return 65536;
  if (model.includes('flash-lite')) return 8192;
  return 65536;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    if (millions < 1.05) {
      return '1M';
    }
    return `${millions.toFixed(millions % 1 === 0 ? 0 : 1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands.toFixed(thousands % 1 === 0 ? 0 : 1).replace(/\.0$/, '')}k`;
  }
  return String(value);
}

function formatDiagnostics(values: Record<string, string | boolean>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
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
