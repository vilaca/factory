import type {
  Provider, ChatMessage, ChatChunk, ToolDefinition,
  ProviderCapabilities, ChatOptions, ModelInfo, ModelPickerInfo, ModelTier,
} from './types.js';
import { buildChatBody, fetchOpenAiCatalog, sendOpenAiChat, streamOpenAiChat } from './_openai/index.js';

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const PROVIDER_NAME = 'Groq';
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
    if (!key) throw new Error(MISSING_TOKEN_ERROR);
    this.apiKey = key;
    this.baseUrl = (options.host ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
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
    // Groq rejects temperature=0 with a 400 — substitute a tiny epsilon.
    const adjusted = options?.temperature === 0
      ? { ...options, temperature: 1e-8 }
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

  private async getCatalog(): Promise<GroqModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const items = await fetchOpenAiCatalog({
      url: `${this.baseUrl}/models`,
      headers: this.authHeaders(),
      providerName: PROVIDER_NAME,
    });

    this.modelsCache = (items as any[])
      .filter(item => item && typeof item === 'object' && typeof item.id === 'string' && item.id)
      // Exclude Groq models that are clearly speech/audio, guardrail, or
      // other non-chat endpoints even if they share the same catalog.
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
    lower.includes('prompt-guard') ||
    lower.includes('orpheus') ||
    lower.includes('transcribe') ||
    lower.includes('tts')
  );
}

// ─── Picker / capability helpers ───────────────────────────────────────

function buildModelDetail(modelId: string): string {
  const lower = modelId.toLowerCase();
  const details: string[] = [];
  details.push(supportsVisionByName(lower) ? 'vision' : 'text-only');
  details.push(supportsToolsByName(lower) ? 'tools' : 'no tools');
  if (supportsReasoningByName(lower)) details.push('reasoning');
  details.push(`max ${formatTokenCount(estimateMaxOutput(lower))} out`);
  details.push(`${formatTokenCount(estimateContextWindow(lower))} ctx`);
  return details.join(' · ');
}

function buildModelWarning(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (
    lower.includes('meta-llama/llama-4-scout') ||
    lower.includes('qwen/qwen3-32b') ||
    lower.includes('openai/gpt-oss-safeguard-20b')
  ) return 'preview';
  return undefined;
}

function buildCapabilities(model: string): string[] {
  const capabilities: string[] = [];
  capabilities.push(supportsVisionByName(model) ? 'vision' : 'text');
  if (supportsToolsByName(model)) capabilities.push('tool-use');
  if (supportsReasoningByName(model)) capabilities.push('reasoning');
  if (supportsParallelToolCalls(model)) capabilities.push('parallel-tools');
  return capabilities;
}

function estimateModelTier(model: string): ModelTier {
  if (
    model.includes('openai/gpt-oss-120b') ||
    model.includes('llama-3.3-70b-versatile') ||
    model.includes('groq/compound')
  ) return 'strong';
  if (
    model.includes('openai/gpt-oss-20b') ||
    model.includes('meta-llama/llama-4-scout') ||
    model.includes('qwen/qwen3-32b')
  ) return 'medium';
  return 'weak';
}

function estimateContextWindow(model: string): number {
  if (
    model.includes('llama-3.1-8b-instant') ||
    model.includes('llama-3.3-70b-versatile') ||
    model.includes('openai/gpt-oss-120b') ||
    model.includes('openai/gpt-oss-20b') ||
    model.includes('groq/compound') ||
    model.includes('meta-llama/llama-4-scout') ||
    model.includes('qwen/qwen3-32b')
  ) return 131072;
  return 8192;
}

function estimateMaxOutput(model: string): number {
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
