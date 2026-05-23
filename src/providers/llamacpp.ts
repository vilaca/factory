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
  /** Cached context window discovered via `/props`. Probed on first
   *  `discoverContextWindow` call and reused; one HTTP round-trip per
   *  session. */
  private discoveredContextWindow: number | undefined;

  constructor(host?: string) {
    this.baseUrl = host ?? 'http://127.0.0.1:8080';
  }

  /**
   * Reliability stack (Phase 11): ask llama-server for its actual
   * context window via the read-only `/props` endpoint instead of
   * guessing. Returns null if the probe fails — caller falls back to
   * the static estimate from `getCapabilities()`. Cached for the life
   * of the provider instance; one probe per session.
   *
   * Strips a `/v1` suffix from the base URL since `/props` lives at
   * the root of llama-server, not under the OpenAI-compat surface.
   */
  async discoverContextWindow(_model: string): Promise<number | null> {
    if (this.discoveredContextWindow !== undefined) {
      return this.discoveredContextWindow;
    }
    const root = this.baseUrl.replace(/\/v1\/?$/, '');
    try {
      const res = await fetch(`${root}/props`);
      if (!res.ok) return null;
      const data = (await res.json()) as {
        default_generation_settings?: { n_ctx?: number };
      };
      const n = data.default_generation_settings?.n_ctx;
      if (typeof n === 'number' && n > 0) {
        this.discoveredContextWindow = n;
        return n;
      }
      return null;
    } catch {
      return null;
    }
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
        providerName: PROVIDER_NAME,
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
        providerName: PROVIDER_NAME,
      }),
      signal: options?.signal,
      providerName: PROVIDER_NAME,
    });
  }
}
