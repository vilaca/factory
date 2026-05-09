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
import { buildChatBody, sendOpenAiChat, streamOpenAiChat } from './openai/index.js';

const DEFAULT_API_ROOT = 'https://api.cloudflare.com/client/v4';
const PROVIDER_NAME = 'Cloudflare Workers AI';
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
  private readonly chatBaseUrl: string;
  private readonly modelSearchUrl: string;
  private modelsCache: WorkersAiModel[] | null = null;

  constructor(options: { token?: string; host?: string; accountId?: string } = {}) {
    const key = options.token ?? process.env.CLOUDFLARE_API_TOKEN;
    if (!key) {
      throw new Error(MISSING_TOKEN_ERROR);
    }
    const accountId =
      options.accountId ??
      process.env.CLOUDFLARE_ACCOUNT_ID ??
      inferAccountIdFromHost(options.host);
    if (!accountId) {
      throw new Error(MISSING_ACCOUNT_ID_ERROR);
    }

    this.apiKey = key;
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
    yield* streamOpenAiChat({
      url: `${this.chatBaseUrl}/chat/completions`,
      headers: this.authHeaders(),
      body: this.body(model, messages, tools, true, options),
      signal: options?.signal,
      providerName: PROVIDER_NAME,
    });
  }

  async chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    return sendOpenAiChat({
      url: `${this.chatBaseUrl}/chat/completions`,
      headers: this.authHeaders(),
      body: this.body(model, messages, tools, false, options),
      signal: options?.signal,
      providerName: PROVIDER_NAME,
    });
  }

  private body(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    stream: boolean,
    options?: ChatOptions,
  ): Record<string, unknown> {
    // Workers AI rejects temperature=0 with a 400 — substitute a tiny epsilon.
    const adjusted = options?.temperature === 0 ? { ...options, temperature: 1e-8 } : options;
    return buildChatBody({ model, messages, tools, stream, options: adjusted });
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
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

      const res = await fetch(url, { headers: this.authHeaders() });

      if (!res.ok) {
        throw new Error(`${PROVIDER_NAME} API error ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as { result?: unknown[] };
      const pageItems = Array.isArray(data?.result) ? data.result : [];
      const normalized = pageItems
        .flatMap((item: unknown) => normalizeModel(item))
        // Note: keep only text-generation entries for now; if Cloudflare starts
        // labeling useful chat models differently, this filter may need to widen.
        .filter(
          (model: WorkersAiModel) =>
            model.taskName === undefined || model.taskName === 'text generation',
        );

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

interface CatalogRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): CatalogRecord | undefined {
  return value && typeof value === 'object' ? (value as CatalogRecord) : undefined;
}

function normalizeModel(rawItem: unknown): WorkersAiModel[] {
  const item = asRecord(rawItem);
  if (!item) return [];

  const id =
    typeof item.name === 'string'
      ? item.name
      : typeof item.id === 'string'
        ? item.id
        : typeof item.model === 'string'
          ? item.model
          : undefined;
  if (!id) return [];

  const taskName = normalizeTaskName(item.task);
  const properties = asRecord(item.properties);
  return [
    {
      id,
      description: typeof item.description === 'string' ? item.description : undefined,
      taskName,
      contextWindow: pickFirstNumber(
        item.context_window,
        item.context_length,
        item.max_context_tokens,
        properties?.context_window,
      ),
      supportsTools: pickCapability(item, 'function'),
      supportsReasoning: pickCapability(item, 'reason'),
      supportsVision: pickCapability(item, 'vision'),
      experimental: item.experimental === true || hasTag(item, 'experimental'),
    },
  ];
}

function normalizeTaskName(task: unknown): string | undefined {
  if (typeof task === 'string') return task.toLowerCase();
  const t = asRecord(task);
  if (!t) return undefined;
  const raw =
    typeof t.name === 'string'
      ? t.name
      : typeof t.description === 'string'
        ? t.description
        : undefined;
  return raw?.toLowerCase();
}

function pickFirstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickCapability(item: CatalogRecord, keyword: string): boolean | undefined {
  const flag = item[`supports_${keyword}`];
  if (typeof flag === 'boolean') return flag;
  const caps = asRecord(item.capabilities);
  if (caps && typeof caps[keyword] === 'boolean') return caps[keyword] as boolean;
  if (hasTag(item, keyword)) return true;
  return undefined;
}

function hasTag(item: CatalogRecord, keyword: string): boolean {
  const lower = keyword.toLowerCase();
  const tags = [
    ...(Array.isArray(item.tags) ? item.tags : []),
    ...(Array.isArray(item.capabilities) ? item.capabilities : []),
    ...(Array.isArray(item.features) ? item.features : []),
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
  if (cached?.experimental || lower.includes('experimental') || lower.includes('preview'))
    return 'preview';
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
  return !(model.includes('guard') || model.includes('classification'));
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

function estimateWorkersAiModelTier(
  model: string,
  supportsVision: boolean,
  supportsReasoning: boolean,
): ModelTier {
  if (
    model.includes('gpt-oss-120b') ||
    model.includes('kimi-k2.6') ||
    model.includes('llama-4-scout') ||
    model.includes('nemotron')
  ) {
    return 'strong';
  }
  if (
    supportsReasoning ||
    supportsVision ||
    model.includes('qwen2.5-coder-32b-instruct') ||
    model.includes('mistral-small-3.1')
  ) {
    return 'medium';
  }
  return 'weak';
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
