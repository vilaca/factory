import type {
  Provider,
  ChatMessage,
  ChatChunk,
  ToolDefinition,
  ProviderCapabilities,
  ChatOptions,
  ModelInfo,
  ModelPickerInfo,
} from '../types.js';
import {
  buildChatBody,
  buildResponsesBody,
  fetchOpenAiCatalog,
  sendOpenAiChat,
  sendOpenAiResponses,
  streamOpenAiChat,
  streamOpenAiResponses,
} from './index.js';
import { bearerAuth, normalizeBaseUrl } from '../shared.js';
import { filterOpenAiCatalog, type OpenAiModel } from './catalog-filter.js';
import { buildCapabilities, buildModelDetail, buildModelWarning } from './model-metadata.js';
import {
  defaultReasoningEffort,
  estimateContextWindow,
  estimateMaxOutput,
  estimateModelTier,
  isReasoningModel,
  isResponsesApiOnly,
  supportsParallelToolCalls,
  supportsToolsByName,
} from './model-families.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const PROVIDER_NAME = 'OpenAI';
const MISSING_TOKEN_ERROR =
  'OpenAI API key required. Set OPENAI_API_KEY env var or use --token flag.';

export class OpenAIProvider implements Provider {
  name = 'openai';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private modelsCache: OpenAiModel[] | null = null;

  constructor(options: { token?: string; host?: string } = {}) {
    const key = options.token ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error(MISSING_TOKEN_ERROR);
    this.apiKey = key;
    this.baseUrl = normalizeBaseUrl(options.host ?? DEFAULT_BASE_URL);
  }

  async listModels(): Promise<string[]> {
    const models = await this.getCatalog();
    return [...new Set(models.map(model => model.id))];
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const lower = model.toLowerCase();
    return {
      label: model,
      detail: buildModelDetail(lower),
      warning: buildModelWarning(lower),
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
    const lower = model.toLowerCase();
    if (isResponsesApiOnly(lower)) {
      yield* streamOpenAiResponses({
        url: `${this.baseUrl}/responses`,
        headers: this.authHeaders(),
        body: this.responsesBody(model, messages, tools, true, options),
        signal: options?.signal,
        providerName: PROVIDER_NAME,
      });
      return;
    }
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
    const lower = model.toLowerCase();
    if (isResponsesApiOnly(lower)) {
      return sendOpenAiResponses({
        url: `${this.baseUrl}/responses`,
        headers: this.authHeaders(),
        body: this.responsesBody(model, messages, tools, false, options),
        signal: options?.signal,
        providerName: PROVIDER_NAME,
      });
    }
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
      providerName: 'openai',
    });
  }

  private responsesBody(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    stream: boolean,
    options?: ChatOptions,
  ): Record<string, unknown> {
    const lower = model.toLowerCase();
    // Codex rejects `temperature` outright on the Responses path; strip it
    // unconditionally for responsesApiOnly models regardless of caller default.
    const adjusted = options ? { ...options, temperature: undefined } : undefined;
    const reasoningEffort = options?.reasoningEffort ?? defaultReasoningEffort(lower);
    return buildResponsesBody({
      model,
      messages,
      tools: supportsToolsByName(lower) ? tools : undefined,
      stream,
      options: adjusted,
      parallelToolCalls: supportsParallelToolCalls(lower),
      reasoningEffort,
    });
  }

  private authHeaders(): Record<string, string> {
    return bearerAuth(this.apiKey);
  }

  private async getCatalog(): Promise<OpenAiModel[]> {
    if (this.modelsCache) return this.modelsCache;
    const items = await fetchOpenAiCatalog({
      url: `${this.baseUrl}/models`,
      headers: this.authHeaders(),
      providerName: PROVIDER_NAME,
    });
    this.modelsCache = filterOpenAiCatalog(items);
    return this.modelsCache;
  }
}
