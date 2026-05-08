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
} from './_openai/index.js';

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
    this.baseUrl = (options.host ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
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
      contextWindow: estimateContextWindow(lower),
      maxOutputTokens: estimateMaxOutput(lower),
      toolSupport: 'native',
      parallelToolCalls: true,
      streaming: true,
      tokenCounting: 'exact',
      modelTier: estimateModelTier(lower),
    };
  }

  async getModelInfo(model: string): Promise<ModelInfo> {
    await this.getCatalog();
    const lower = model.toLowerCase();
    return {
      supportsTools: true,
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
      body: buildChatBody({ model, messages, tools, stream: true, options }),
      signal: options?.signal,
      providerName: 'Cerebras',
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
      body: buildChatBody({ model, messages, tools, stream: false, options }),
      signal: options?.signal,
      providerName: 'Cerebras',
    });
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async getCatalog(): Promise<CerebrasModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const items = await fetchOpenAiCatalog({
      url: `${this.baseUrl}/models`,
      headers: this.authHeaders(),
      providerName: 'Cerebras',
    });

    this.modelsCache = items
      .filter(
        (item: any) => item && typeof item === 'object' && typeof item.id === 'string' && item.id,
      )
      .map((item: any) => ({
        id: item.id,
        owned_by: typeof item.owned_by === 'string' ? item.owned_by : undefined,
      }));

    return this.modelsCache;
  }
}

// ─── Picker / capability helpers ───────────────────────────────────────

function buildModelDetail(modelId: string): string {
  const lower = modelId.toLowerCase();
  const details: string[] = [];
  details.push('text-only');
  details.push('tools');
  if (supportsReasoning(lower)) details.push('reasoning');
  details.push(`max ${formatTokenCount(estimateMaxOutput(lower))} out`);
  details.push(`${formatTokenCount(estimateContextWindow(lower))} ctx`);
  return details.join(' · ');
}

function buildModelWarning(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.includes('qwen-3-235b') || lower.includes('zai-glm-4.7')) return 'preview';
  if (lower.includes('llama3.1-8b')) return 'deprecated';
  return undefined;
}

function buildCapabilities(model: string): string[] {
  const capabilities = ['text', 'tool-use'];
  if (supportsReasoning(model)) capabilities.push('reasoning');
  return capabilities;
}

function estimateModelTier(model: string): ModelTier {
  if (model.includes('gpt-oss-120b') || model.includes('zai-glm-4.7')) return 'strong';
  if (model.includes('qwen-3-235b')) return 'medium';
  return 'weak';
}

function estimateContextWindow(model: string): number {
  if (model.includes('gpt-oss-120b')) return 131072;
  if (model.includes('zai-glm-4.7')) return 128000;
  if (model.includes('qwen-3-235b')) return 262144;
  if (model.includes('llama3.1-8b')) return 131072;
  return 128000;
}

function estimateMaxOutput(model: string): number {
  if (model.includes('gpt-oss-120b') || model.includes('zai-glm-4.7')) return 65536;
  if (model.includes('qwen-3-235b')) return 32768;
  if (model.includes('llama3.1-8b')) return 8192;
  return 8192;
}

function supportsReasoning(model: string): boolean {
  return model.includes('gpt-oss') || model.includes('zai-glm') || model.includes('qwen');
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
