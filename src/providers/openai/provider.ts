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
} from '../types.js';
import { buildChatBody, fetchOpenAiCatalog, sendOpenAiChat, streamOpenAiChat } from './index.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const PROVIDER_NAME = 'OpenAI';
const MISSING_TOKEN_ERROR =
  'OpenAI API key required. Set OPENAI_API_KEY env var or use --token flag.';

interface OpenAiModel {
  id: string;
  owned_by?: string;
}

export class OpenAIProvider implements Provider {
  name = 'openai';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private modelsCache: OpenAiModel[] | null = null;

  constructor(options: { token?: string; host?: string } = {}) {
    const key = options.token ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error(MISSING_TOKEN_ERROR);
    this.apiKey = key;
    this.baseUrl = (options.host ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async listModels(): Promise<string[]> {
    const models = await this.getCatalog();
    return [...new Set(models.map(model => model.id))];
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    return {
      label: model,
      detail: buildModelDetail(model.toLowerCase()),
      warning: buildModelWarning(model.toLowerCase()),
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    return {
      contextWindow: estimateContextWindow(lower),
      maxOutputTokens: estimateMaxOutput(lower),
      toolSupport: supportsToolsByName(lower) ? 'native' : 'none',
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
    // Reasoning models (o1/o3/o4, gpt-5) reject `temperature` other than the
    // default — strip the field so callers' default of 0 doesn't 400 the call.
    const adjusted = isReasoningModel(lower)
      ? options
        ? { ...options, temperature: undefined }
        : undefined
      : options;
    return buildChatBody({
      model,
      messages,
      tools: supportsToolsByName(lower) ? tools : undefined,
      stream,
      options: adjusted,
      parallelToolCalls: supportsParallelToolCalls(lower),
    });
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async getCatalog(): Promise<OpenAiModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const items = await fetchOpenAiCatalog({
      url: `${this.baseUrl}/models`,
      headers: this.authHeaders(),
      providerName: PROVIDER_NAME,
    });

    interface CatalogItem {
      id?: string;
      owned_by?: string;
    }
    this.modelsCache = items
      .filter(
        (item: unknown): item is CatalogItem & { id: string } =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as CatalogItem).id === 'string' &&
          !!(item as CatalogItem).id,
      )
      // The /models catalog mixes chat models with embeddings, image, audio,
      // moderation, and realtime endpoints. Keep only ids that look like a
      // chat model so the picker doesn't surface ones we can't talk to.
      .filter(item => supportsChatCompletions(item.id))
      .map(item => ({
        id: item.id,
        owned_by: typeof item.owned_by === 'string' ? item.owned_by : undefined,
      }));

    return this.modelsCache;
  }
}

// ─── Catalog filter ────────────────────────────────────────────────────

function supportsChatCompletions(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return !(
    lower.includes('whisper') ||
    lower.includes('tts') ||
    lower.includes('embedding') ||
    lower.includes('dall-e') ||
    lower.includes('moderation') ||
    lower.includes('davinci') ||
    lower.includes('babbage') ||
    lower.includes('realtime') ||
    lower.includes('audio') ||
    lower.includes('image') ||
    lower.includes('transcribe') ||
    lower.includes('search') ||
    lower.includes('computer-use')
  );
}

// ─── Picker / capability helpers ───────────────────────────────────────

function buildModelDetail(modelId: string): string {
  const details: string[] = [];
  details.push(supportsVisionByName(modelId) ? 'vision' : 'text-only');
  details.push(supportsToolsByName(modelId) ? 'tools' : 'no tools');
  if (isReasoningModel(modelId)) details.push('reasoning');
  details.push(`max ${formatTokenCount(estimateMaxOutput(modelId))} out`);
  details.push(`${formatTokenCount(estimateContextWindow(modelId))} ctx`);
  return details.join(' · ');
}

function buildModelWarning(modelId: string): string | undefined {
  if (modelId.includes('preview')) return 'preview';
  if (modelId.startsWith('gpt-3.5') || modelId.startsWith('gpt-4-')) return 'deprecated';
  return undefined;
}

function buildCapabilities(model: string): string[] {
  const capabilities: string[] = [];
  capabilities.push(supportsVisionByName(model) ? 'vision' : 'text');
  if (supportsToolsByName(model)) capabilities.push('tool-use');
  if (isReasoningModel(model)) capabilities.push('reasoning');
  if (supportsParallelToolCalls(model)) capabilities.push('parallel-tools');
  return capabilities;
}

function estimateModelTier(model: string): ModelTier {
  if (
    model.startsWith('gpt-5') ||
    model.startsWith('gpt-4.1') ||
    model.startsWith('o3') ||
    model.startsWith('o1')
  )
    return 'strong';
  if (
    model.startsWith('gpt-4o') ||
    model.startsWith('o4-mini') ||
    model.startsWith('o3-mini') ||
    model.startsWith('o1-mini')
  )
    return 'medium';
  return 'weak';
}

function estimateContextWindow(model: string): number {
  if (model.startsWith('gpt-5') || model.startsWith('gpt-4.1')) return 1_047_576;
  if (model.startsWith('o4') || model.startsWith('o3') || model.startsWith('o1-pro'))
    return 200_000;
  if (model.startsWith('o1')) return 128_000;
  if (model.startsWith('gpt-4o')) return 128_000;
  if (model.startsWith('gpt-4-turbo') || model.startsWith('gpt-4-1106')) return 128_000;
  if (model.startsWith('gpt-3.5-turbo')) return 16_385;
  return 128_000;
}

function estimateMaxOutput(model: string): number {
  if (model.startsWith('gpt-5')) return 128_000;
  if (model.startsWith('gpt-4.1')) return 32_768;
  if (model.startsWith('o4') || model.startsWith('o3') || model.startsWith('o1')) return 100_000;
  if (model.startsWith('gpt-4o')) return 16_384;
  if (model.startsWith('gpt-4-turbo')) return 4_096;
  if (model.startsWith('gpt-3.5-turbo')) return 4_096;
  return 16_384;
}

function isReasoningModel(model: string): boolean {
  return (
    model.startsWith('o1') ||
    model.startsWith('o3') ||
    model.startsWith('o4') ||
    model.startsWith('gpt-5')
  );
}

function supportsToolsByName(model: string): boolean {
  // The chat endpoints we surface all support tools today. The catalog filter
  // already drops embeddings/whisper/etc, so anything reaching this check is
  // a chat model.
  if (model.startsWith('o1-mini') || model.startsWith('o1-preview')) return false;
  if (model === 'gpt-3.5-turbo-instruct') return false;
  return true;
}

function supportsParallelToolCalls(model: string): boolean {
  if (!supportsToolsByName(model)) return false;
  // o-series reasoning models don't support parallel tool calls.
  if (isReasoningModel(model)) return false;
  return true;
}

function supportsVisionByName(model: string): boolean {
  return (
    model.startsWith('gpt-5') ||
    model.startsWith('gpt-4.1') ||
    model.startsWith('gpt-4o') ||
    model.startsWith('o4') ||
    model.startsWith('o3') ||
    model.startsWith('o1')
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
