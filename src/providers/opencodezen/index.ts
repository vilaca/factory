import Anthropic from '@anthropic-ai/sdk';
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
import { buildChatBody, sendOpenAiChat, streamOpenAiChat } from '../_openai/index.js';
import {
  type OpenCodeZenModel,
  buildCapabilities,
  buildModelDetail,
  buildModelWarning,
  detectOpenCodeZenRoute,
  estimateContextWindow,
  estimateMaxOutput,
  estimateModelTier,
  isSupportedOpenCodeZenModel,
  normalizeBaseUrl,
  supportsToolsByName,
  unsupportedOpenCodeZenRouteError,
} from './models.js';
import {
  chatAnthropicNoStream,
  chatAnthropicStream,
} from './anthropic.js';
import { chatGoogleNoStream, chatGoogleStream } from './google.js';

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1';
const PROVIDER_NAME = 'OpenCode Zen';
const MISSING_TOKEN_ERROR =
  'OpenCode Zen API key required. Set OPENCODE_ZEN_API_KEY or OPENCODE_API_KEY env var or use --token flag.';

export class OpenCodeZenProvider implements Provider {
  name = 'opencodezen';
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private modelsCache: OpenCodeZenModel[] | null = null;
  private anthropicClient: Anthropic | null = null;

  constructor(options: { token?: string; host?: string } = {}) {
    this.apiKey = options.token ?? process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_API_KEY;
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
    const route =
      this.modelsCache?.find(item => item.id === model)?.route ?? detectOpenCodeZenRoute(model);
    const supportsTools = route !== 'openai-responses' && supportsToolsByName(lower);

    return {
      contextWindow: estimateContextWindow(lower),
      maxOutputTokens: estimateMaxOutput(lower),
      toolSupport: supportsTools ? 'native' : 'none',
      parallelToolCalls: supportsTools,
      streaming: route !== 'openai-responses',
      tokenCounting: 'exact',
      modelTier: estimateModelTier(lower),
    };
  }

  async getModelInfo(model: string): Promise<ModelInfo> {
    await this.getCatalog();
    const lower = model.toLowerCase();
    const route =
      this.modelsCache?.find(item => item.id === model)?.route ?? detectOpenCodeZenRoute(model);
    return {
      supportsTools: route !== 'openai-responses' && supportsToolsByName(lower),
      capabilities: buildCapabilities(lower, route),
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    switch (detectOpenCodeZenRoute(model)) {
      case 'chat-completions':
        yield* this.chatCompletions(model, messages, tools, options);
        return;
      case 'anthropic-messages':
        yield* chatAnthropicStream(this.getAnthropicClient(), model, messages, tools, options);
        return;
      case 'google-native':
        yield* chatGoogleStream(this.baseUrl, this.requireApiKey(), model, messages, tools, options);
        return;
      case 'openai-responses':
        throw unsupportedOpenCodeZenRouteError(model);
    }
  }

  async chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    switch (detectOpenCodeZenRoute(model)) {
      case 'chat-completions':
        return this.chatCompletionsNoStream(model, messages, tools, options);
      case 'anthropic-messages':
        return chatAnthropicNoStream(this.getAnthropicClient(), model, messages, tools, options);
      case 'google-native':
        return chatGoogleNoStream(
          this.baseUrl,
          this.requireApiKey(),
          model,
          messages,
          tools,
          options,
        );
      case 'openai-responses':
        throw unsupportedOpenCodeZenRouteError(model);
    }
  }

  private async *chatCompletions(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    // TODO: Zen's /models catalog currently includes some chat/completions models
    // that still fail at runtime (for example nemotron-3-super-free -> 500 and
    // trinity-large-preview-free -> wrapped provider 404). If Zen exposes route
    // or availability metadata, use it here to retry with the correct backend
    // instead of surfacing the raw gateway error.
    yield* streamOpenAiChat({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.requireOpenAiAuthHeaders(),
      body: buildChatBody({
        model,
        messages,
        tools,
        stream: true,
        options,
        maxTokensField: 'max_tokens',
      }),
      signal: options?.signal,
      providerName: PROVIDER_NAME,
    });
  }

  private async chatCompletionsNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    return sendOpenAiChat({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.requireOpenAiAuthHeaders(),
      body: buildChatBody({
        model,
        messages,
        tools,
        stream: false,
        options,
        maxTokensField: 'max_tokens',
      }),
      signal: options?.signal,
      providerName: PROVIDER_NAME,
    });
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new Error(MISSING_TOKEN_ERROR);
    }
    return this.apiKey;
  }

  private requireOpenAiAuthHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.requireApiKey()}` };
  }

  private getAnthropicClient(): Anthropic {
    const apiKey = this.requireApiKey();
    if (!this.anthropicClient) {
      this.anthropicClient = new Anthropic({
        apiKey,
        baseURL: this.baseUrl.replace(/\/v1$/, ''),
      });
    }
    return this.anthropicClient;
  }

  private async getCatalog(): Promise<OpenCodeZenModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
    });

    if (!res.ok) {
      throw new Error(`${PROVIDER_NAME} API error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { data?: unknown[] };
    const rawItems: unknown[] = Array.isArray(data?.data) ? data.data : [];
    this.modelsCache = rawItems
      // Note: hide Zen models that route through OpenAI's /responses API until
      // the provider layer can preserve Responses-native events and tool items.
      .filter(isSupportedOpenCodeZenModel)
      .map(item => ({
        id: item.id,
        owned_by: typeof item.owned_by === 'string' ? item.owned_by : undefined,
        route: detectOpenCodeZenRoute(item.id),
      }));

    return this.modelsCache ?? [];
  }
}
