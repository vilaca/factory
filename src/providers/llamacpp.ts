import type {
  Provider,
  ChatMessage,
  ChatChunk,
  ToolDefinition,
  ProviderCapabilities,
  ChatOptions,
} from './types.js';
import { buildChatBody, sendOpenAiChat, streamOpenAiChat } from './openai/index.js';

const PROVIDER_NAME = 'llama.cpp';

export class LlamaCppProvider implements Provider {
  name = 'llamacpp';
  private baseUrl: string;

  constructor(host?: string) {
    this.baseUrl = host ?? 'http://127.0.0.1:8080';
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`);
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id: string }> };
        if (data.data?.length) {
          // Note: llama.cpp serves the currently loaded model set; we surface
          // that list directly instead of applying provider-side filtering.
          return data.data.map(m => m.id);
        }
      }
    } catch {
      // Older llama.cpp versions may not have /v1/models
    }

    const health = await fetch(`${this.baseUrl}/health`);
    if (!health.ok) {
      throw new Error(`llama.cpp server not reachable at ${this.baseUrl}`);
    }

    // Note: older llama.cpp builds may not expose /v1/models at all, so we
    // fall back to a single synthetic "default" entry after a health check.
    return ['default'];
  }

  getCapabilities(_model: string): ProviderCapabilities {
    // llama.cpp serves a single model; capabilities depend on what's loaded
    // Default to conservative estimates, overridable via config in future
    return {
      contextWindow: 8192,
      maxOutputTokens: 4096,
      toolSupport: 'basic',
      parallelToolCalls: false,
      streaming: true,
      tokenCounting: 'estimated',
      modelTier: 'medium',
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    yield* streamOpenAiChat({
      url: `${this.baseUrl}/v1/chat/completions`,
      headers: {},
      body: buildChatBody({
        model,
        messages,
        tools,
        stream: true,
        options,
        parallelToolCalls: false,
      }),
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
      url: `${this.baseUrl}/v1/chat/completions`,
      headers: {},
      body: buildChatBody({
        model,
        messages,
        tools,
        stream: false,
        options,
        parallelToolCalls: false,
      }),
      signal: options?.signal,
      providerName: PROVIDER_NAME,
    });
  }
}
