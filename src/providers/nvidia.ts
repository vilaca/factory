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

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const PROVIDER_NAME = 'NVIDIA';
const MISSING_TOKEN_ERROR =
  'NVIDIA API key required. Set NVIDIA_API_KEY env var or use --token flag.';

interface NvidiaModel {
  id: string;
  owned_by?: string;
}

export class NvidiaProvider implements Provider {
  name = 'nvidia';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private modelsCache: NvidiaModel[] | null = null;

  constructor(options: { token?: string; host?: string } = {}) {
    const key = options.token ?? process.env.NVIDIA_API_KEY;
    if (!key) throw new Error(MISSING_TOKEN_ERROR);
    this.apiKey = key;
    this.baseUrl = normalizeBaseUrl(options.host ?? DEFAULT_BASE_URL);
  }

  async listModels(): Promise<string[]> {
    const models = await this.getCatalog();
    return [...new Set(models.map(model => model.id))];
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const match = this.modelsCache?.find(item => item.id === model);
    if (!match) return { label: model };
    return {
      label: model,
      detail: buildModelDetail(match.id),
      warning: buildModelWarning(match.id),
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    const supportsTools = supportsToolsByName(lower);
    warnHardcodedEstimateFallback({
      provider: PROVIDER_NAME,
      model,
      fields: ['contextWindow', 'maxOutputTokens', 'modelTier'],
      reason: 'catalog does not publish token limits; using model-name heuristics',
    });
    return {
      contextWindow: estimateContextWindow(lower),
      maxOutputTokens: estimateMaxOutput(lower),
      toolSupport: supportsTools ? 'native' : 'none',
      parallelToolCalls: supportsParallelToolCalls(lower),
      streaming: true,
      tokenCounting: 'exact',
      modelTier: estimateModelTier(lower),
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
    yield* streamOpenAiChat({
      url: `${this.baseUrl}/chat/completions`,
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
      url: `${this.baseUrl}/chat/completions`,
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
    const lower = model.toLowerCase();
    return buildChatBody({
      model,
      messages,
      tools: supportsToolsByName(lower) ? tools : undefined,
      stream,
      options,
      parallelToolCalls: supportsParallelToolCalls(lower),
      providerName: PROVIDER_NAME,
    });
  }

  private authHeaders(): Record<string, string> {
    return bearerAuth(this.apiKey);
  }

  private async getCatalog(): Promise<NvidiaModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const items = await fetchOpenAiCatalog({
      url: `${this.baseUrl}/models`,
      headers: this.authHeaders(),
      providerName: PROVIDER_NAME,
    });

    interface NvidiaCatalogItem {
      id?: string;
      owned_by?: string;
    }
    const valid = items.filter(
      (item: unknown): item is NvidiaCatalogItem & { id: string } =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as NvidiaCatalogItem).id === 'string' &&
        !!(item as NvidiaCatalogItem).id,
    );
    this.modelsCache = filterChatModels('nvidia', valid, item => {
      const matched = matchedPattern(item.id, NON_CHAT_PATTERNS);
      return matched ? `non-chat: matches '${matched}'` : true;
    }).map(item => ({
      id: item.id,
      owned_by: typeof item.owned_by === 'string' ? item.owned_by : undefined,
    }));

    return this.modelsCache;
  }
}

// ─── Catalog filter ────────────────────────────────────────────────────

const NON_CHAT_PATTERNS = ['whisper', 'prompt-guard', 'orpheus', 'transcribe', 'tts'] as const;

// ─── Picker / capability helpers ───────────────────────────────────────

function buildModelDetail(modelId: string): string {
  const lower = modelId.toLowerCase();
  const details: string[] = [];
  details.push(supportsVisionByName() ? 'vision' : 'text-only');
  details.push(supportsToolsByName(lower) ? 'tools' : 'no tools');
  if (supportsReasoningByName(lower)) details.push('reasoning');
  details.push(`max ${formatTokenCount(estimateMaxOutput(lower))} out`);
  details.push(`${formatTokenCount(estimateContextWindow(lower))} ctx`);
  return details.join(' · ');
}

function buildModelWarning(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  // Add warnings for preview or experimental models
  if (
    lower.includes('nemoguard') ||
    lower.includes('content-safety') ||
    lower.includes('jailbreak-detect')
  ) {
    return 'safety/guard';
  }
  return undefined;
}

function buildCapabilities(model: string): string[] {
  const capabilities: string[] = [];
  capabilities.push(supportsVisionByName() ? 'vision' : 'text');
  if (supportsToolsByName(model)) capabilities.push('tool-use');
  if (supportsReasoningByName(model)) capabilities.push('reasoning');
  if (supportsParallelToolCalls(model)) capabilities.push('parallel-tools');
  return capabilities;
}

function estimateModelTier(model: string): ModelTier {
  // NVIDIA's largest models
  if (
    model.includes('nemotron-3-ultra-550b') ||
    model.includes('nemotron-3-ultra-253b') ||
    model.includes('llama-3.1-70b') ||
    model.includes('llama-3.3-70b')
  ) {
    return 'strong';
  }
  // Medium sized models
  if (
    model.includes('nemotron-3-super-120b') ||
    model.includes('llama-3.1-8b') ||
    model.includes('llama-3.3-49b') ||
    model.includes('mixtral-8x22b')
  ) {
    return 'medium';
  }
  return 'weak';
}

function estimateContextWindow(model: string): number {
  // Most NVIDIA models have 8K-32K context windows
  // Special cases: meta/llama-3.x-70b-instruct models have 128K context
  if (model === 'meta/llama-3.3-70b-instruct' || model === 'meta/llama-3.1-70b-instruct') {
    return 131072;
  }
  if (
    model.includes('nemotron-3-ultra-550b') ||
    model.includes('nemotron-3-ultra-253b') ||
    model.includes('llama-3.1-70b') ||
    model.includes('llama-3.3-70b')
  ) {
    return 32768;
  }
  if (model.includes('nemotron-3-super-120b') || model.includes('llama-3.3-49b')) {
    return 16384;
  }
  return 8192;
}

function estimateMaxOutput(model: string): number {
  // Estimate based on context window
  // Special cases: meta/llama-3.x-70b-instruct models with 128K context can have larger output
  if (model === 'meta/llama-3.3-70b-instruct' || model === 'meta/llama-3.1-70b-instruct') {
    return 8192;
  }
  if (model.includes('nemotron-3-ultra-550b') || model.includes('nemotron-3-ultra-253b')) {
    return 8192;
  }
  if (model.includes('nemotron-3-super-120b')) {
    return 4096;
  }
  if (model.includes('llama-3.1-70b') || model.includes('llama-3.3-70b')) {
    return 4096;
  }
  return 2048;
}

function supportsToolsByName(model: string): boolean {
  // Most NVIDIA models support tools, except for specialized models
  return !(
    model.includes('nemoguard') ||
    model.includes('content-safety') ||
    model.includes('jailbreak-detect') ||
    model.includes('gliner-pii')
  );
}

function supportsParallelToolCalls(model: string): boolean {
  return supportsToolsByName(model);
}

function supportsVisionByName(): boolean {
  // NVIDIA models generally don't have vision capabilities
  return false;
}

function supportsReasoningByName(model: string): boolean {
  // Models with reasoning capabilities
  return model.includes('nemotron') || model.includes('reasoning') || model.includes('thinking');
}
