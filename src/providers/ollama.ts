import { AsyncLocalStorage } from 'async_hooks';
import { Ollama, type ChatRequest, type Tool, type Message } from 'ollama';
import type {
  Provider,
  ChatMessage,
  ChatChunk,
  ToolDefinition,
  ProviderCapabilities,
  ChatOptions,
  ModelTier,
  ModelInfo,
} from './types.js';
import { errorCode, errorMessage, isError, makeAbortError } from '../utils/errors.js';

export class OllamaProvider implements Provider {
  name = 'ollama';
  private client: Ollama;
  // Per-call abort signal storage. The Ollama client doesn't accept a signal
  // through chat()/list()/show(), so we route it through a customFetch
  // wrapper. AsyncLocalStorage rather than an instance field because two
  // overlapping chat calls (parallel subagents on the same provider) share
  // this provider — a plain field would race: call B's `this.signal = …`
  // would clobber A's slot before A's customFetch reads it. ALS gives each
  // async context its own store and propagates across awaits.
  private signalStore = new AsyncLocalStorage<AbortSignal | undefined>();
  // Per-model context window pulled from `/api/show` (model_info's
  // `<arch>.context_length` key). Populated by `primeModelCache` /
  // `getModelInfo`; `getCapabilities` consults this before falling back to
  // the hardcoded estimate. Ollama reports the model's native context here,
  // which is what compaction should budget against — the previous hardcoded
  // 16K for deepseek tripped compaction at ~12K tokens on a 128K-capable
  // model.
  private contextWindowCache = new Map<string, number>();

  constructor(host?: string) {
    const customFetch: typeof fetch = (input, init) => {
      const signal = this.signalStore.getStore();
      if (signal && !init?.signal) {
        return fetch(input as RequestInfo | URL, { ...init, signal });
      }
      return fetch(input as RequestInfo | URL, init);
    };
    this.client = new Ollama({
      host: host ?? 'http://127.0.0.1:11434',
      fetch: customFetch,
    });
  }

  async listModels(): Promise<string[]> {
    // Note: Ollama already exposes the locally installed chat-capable models we
    // can target, so we return the server list verbatim without extra filtering.
    const response = await this.client.list();
    return response.models.map(m => m.name);
  }

  async getModelInfo(model: string): Promise<ModelInfo> {
    const response = await this.client.show({ model });
    const capabilities = response.capabilities ?? [];
    const ctx = extractContextLength(response.model_info);
    if (ctx > 0) this.contextWindowCache.set(model, ctx);
    return {
      supportsTools: capabilities.includes('tools'),
      capabilities,
    };
  }

  /** Populate per-model caches (currently just `contextWindowCache`) so the
   *  synchronous `getCapabilities` reads the model's real context length
   *  instead of the hardcoded estimate. Best-effort: failures (server down,
   *  model not pulled) leave the cache empty and `getCapabilities` falls
   *  through to `estimateContextWindow`. Mirrors the listModels priming
   *  step in swap.ts. */
  async primeModelCache(model: string): Promise<void> {
    try {
      await this.getModelInfo(model);
    } catch {
      // Intentionally silent — we don't want session start to fail if the
      // user hasn't pulled the model yet, or the ollama server is briefly
      // unreachable. The capability lookup will use the estimate instead.
    }
  }

  getCapabilities(model: string): ProviderCapabilities {
    const tier = estimateOllamaModelTier(model);
    return {
      contextWindow: this.contextWindowCache.get(model) ?? estimateContextWindow(model),
      maxOutputTokens: 4096,
      toolSupport: tier === 'weak' ? 'basic' : 'native',
      parallelToolCalls: false,
      streaming: true,
      tokenCounting: 'estimated',
      modelTier: tier,
    };
  }

  /** Returns the context window to send as `num_ctx` on chat requests.
   *  Falls back to the estimate when the cache miss path is hit (e.g.
   *  primeModelCache failed). Sending a `num_ctx` larger than the model's
   *  configured context overflows ollama server-side. */
  private resolveContextWindow(model: string): number {
    return this.contextWindowCache.get(model) ?? estimateContextWindow(model);
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const request: ChatRequest & { stream: true } = {
      model,
      messages: messages as Message[],
      stream: true,
      tools: tools as Tool[],
      // num_predict caps output length so degenerate repetition loops can't
      // run forever. Ollama's default is -1 (no limit).
      options: { num_ctx: this.resolveContextWindow(model), num_predict: options?.maxTokens ?? 4096 },
    };

    const stream = await this.client.chat(request);
    // Tie the iterator's abort to our signal so cancellation propagates to the
    // underlying HTTP request — without this, ESC during prompt-eval (no chunks
    // streaming yet) does nothing because the for-await is blocked. Both
    // stream.abort() AND client.abort() are called: the former is the official
    // per-iterator API, the latter is a belt-and-suspenders that aborts ALL
    // ongoing streamed requests on the client, in case the iterator-level
    // abort doesn't actually close the underlying socket.
    const signal = options?.signal;
    let onAbort: (() => void) | undefined;
    const client = this.client;
    if (signal) {
      if (signal.aborted) {
        stream.abort();
        client.abort();
      } else {
        onAbort = () => {
          stream.abort();
          client.abort();
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    try {
      for await (const chunk of stream) {
        const result: ChatChunk = {};
        if (chunk.message?.content) {
          result.content = chunk.message.content;
        }
        if (chunk.message?.tool_calls) {
          result.tool_calls = chunk.message.tool_calls.map(tc => ({
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments as Record<string, unknown>,
            },
          }));
        }
        if (chunk.done) {
          result.done = true;
          if (typeof chunk.done_reason === 'string') result.doneReason = chunk.done_reason;
          if (chunk.eval_count || chunk.prompt_eval_count) {
            result.usage = {
              promptTokens: chunk.prompt_eval_count ?? 0,
              completionTokens: chunk.eval_count ?? 0,
              totalTokens: (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0),
            };
          }
        }
        yield result;
      }
    } catch (err: unknown) {
      // The iterator throws when stream.abort() runs. Surface this as an
      // AbortError so callers can route it through their existing abort path.
      if (signal?.aborted) {
        throw makeAbortError();
      }
      throw translateOllamaError(err);
    } finally {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    const request: ChatRequest & { stream: false } = {
      model,
      messages: messages as Message[],
      stream: false,
      tools: tools as Tool[],
      options: { num_ctx: this.resolveContextWindow(model), num_predict: options?.maxTokens ?? 4096 },
    };

    const signal = options?.signal;
    if (signal?.aborted) {
      throw makeAbortError();
    }

    // Run the chat call inside an AsyncLocalStorage context so customFetch
    // sees the right signal even when other chat calls overlap on this same
    // provider instance.
    let response;
    try {
      response = await this.signalStore.run(signal, () => this.client.chat(request));
    } catch (err: unknown) {
      if (signal?.aborted || (isError(err) && err.name === 'AbortError')) {
        throw makeAbortError();
      }
      throw translateOllamaError(err);
    }

    const result: ChatChunk = {
      content: response.message?.content,
      done: true,
    };
    if (typeof response.done_reason === 'string') result.doneReason = response.done_reason;
    if (response.message?.tool_calls) {
      result.tool_calls = response.message.tool_calls.map(tc => ({
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments as Record<string, unknown>,
        },
      }));
    }
    if (response.eval_count || response.prompt_eval_count) {
      result.usage = {
        promptTokens: response.prompt_eval_count ?? 0,
        completionTokens: response.eval_count ?? 0,
        totalTokens: (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
      };
    }
    return result;
  }
}

/**
 * Wrap Ollama's cryptic transport errors into a user-actionable message.
 * "EOF" in particular means the server closed the connection mid-response —
 * usually because Ollama crashed, ran out of memory, or unloaded the model
 * and hit a race during reload.
 */
function translateOllamaError(err: unknown): Error {
  const msg = errorMessage(err);
  const code = errorCode(err) ?? '';
  if (
    msg === 'EOF' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed')
  ) {
    const detail = msg || code || 'connection lost';
    const wrapped = new Error(
      `Ollama connection dropped (${detail}). The model may have been unloaded or the server may be out of memory — check ollama serve and retry.`,
    );
    (wrapped as Error & { cause?: unknown }).cause = err;
    return wrapped;
  }
  return err instanceof Error ? err : new Error(msg);
}

function estimateOllamaModelTier(model: string): ModelTier {
  const lower = model.toLowerCase();
  // Extract parameter count from model name (e.g., "qwen2.5-coder:32b", "llama3:70b")
  const paramMatch = lower.match(/(\d+)b/);
  if (paramMatch) {
    const params = parseInt(paramMatch[1]!, 10);
    if (params >= 70) return 'strong';
    if (params >= 14) return 'medium';
    return 'weak';
  }
  // Default to medium for unknown models
  return 'medium';
}

function estimateContextWindow(model: string): number {
  const lower = model.toLowerCase();
  if (lower.includes('qwen')) return 32768;
  if (lower.includes('llama')) return 8192;
  if (lower.includes('mixtral')) return 32768;
  if (lower.includes('deepseek')) return 16384;
  return 8192; // conservative default
}

/** Extract the model's native context length from ollama's `/api/show`
 *  `model_info` field. Ollama prefixes the key by architecture (e.g.
 *  `llama.context_length`, `qwen2.context_length`, `deepseek2.context_length`),
 *  and we anchor on that exact shape so unrelated dotted keys don't slip
 *  through and Map iteration order can't surface a less-specific match
 *  when multiple keys are present. Returns 0 when the field is absent or
 *  non-numeric — callers fall back to {@link estimateContextWindow}.
 *  Defensive against both a real `Map` and a plain-object payload (some
 *  test fakes use the latter even though the SDK types declare a Map). */
function extractContextLength(modelInfo: unknown): number {
  if (!modelInfo) return 0;
  const entries: Iterable<[string, unknown]> =
    modelInfo instanceof Map
      ? modelInfo.entries()
      : typeof modelInfo === 'object'
        ? Object.entries(modelInfo as Record<string, unknown>)
        : [];
  const archContextLength = /^[^.]+\.context_length$/;
  for (const [key, value] of entries) {
    if (
      typeof key === 'string' &&
      archContextLength.test(key) &&
      typeof value === 'number' &&
      value > 0
    ) {
      return value;
    }
  }
  return 0;
}
