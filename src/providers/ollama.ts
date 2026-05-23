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
import { resolveSampling, resolveThinking, type ResolvedSampling } from './shared.js';
import { discardThinkTags } from '../utils/think-tags.js';
import {
  buildPromptModeToolPreamble,
  downgradeMessagesForPromptMode,
  withPromptModeSystem,
} from './ollama-prompt-mode.js';

type ToolMode = 'native' | 'prompt';

/** Build the per-request `options` object for Ollama's chat endpoint.
 *  Pulled out of the chat/chatNoStream bodies so the per-call sampling
 *  threading is a flat data transform (each key in `sampling` maps 1:1
 *  to an Ollama option) instead of a long inline conditional ladder.
 *  Ollama silently ignores undefined fields, but trimming them keeps
 *  request shape stable across calls for log diffing. */
function ollamaOptions(
  numCtx: number,
  maxTokens: number | undefined,
  sampling: ResolvedSampling,
): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    // num_ctx comes from the caller so the per-model real value
    // (populated by primeModelCache → contextWindowCache) wins over
    // the hardcoded estimate; sending a num_ctx larger than the
    // model's configured context overflows ollama server-side.
    num_ctx: numCtx,
    num_predict: maxTokens ?? 4096,
  };
  // Ollama's option names match the snake_case ResolvedSampling shape
  // 1:1, so the merge is a plain copy of defined fields.
  for (const [k, v] of Object.entries(sampling)) {
    if (v !== undefined) opts[k] = v;
  }
  return opts;
}

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

  /** Test-only hook: when set, customFetch awaits this barrier between
   *  reading the ALS-scoped signal and invoking the real `fetch`. Used by
   *  the re-entrancy contract suite to deterministically interleave two
   *  concurrent chatNoStream calls' signal reads with each other's signal
   *  assignments — the exact race shape that the 0b80a98 fix protects
   *  against. Default (undefined) means no barrier; production paths are
   *  unaffected. The hook does NOT receive or mutate the signal; it only
   *  controls the timing of when customFetch resumes. */
  private fetchBarrier?: () => Promise<void>;

  constructor(host?: string, opts?: { fetchBarrier?: () => Promise<void> }) {
    this.fetchBarrier = opts?.fetchBarrier;
    const customFetch: typeof fetch = async (input, init) => {
      // Test-only barrier (see fetchBarrier docstring). Awaited BEFORE the
      // signal read so the test can deterministically arrange "both
      // chatNoStream calls have assigned their signals before either
      // customFetch reads one." With ALS, each customFetch still reads
      // its own context's signal regardless of timing. With a shared
      // instance field (the 0b80a98 bug), the later assignment would
      // have overwritten the earlier one by the time the read happens.
      if (this.fetchBarrier) {
        await this.fetchBarrier();
      }
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

  /** Reliability stack §16: per-model tool-mode cache. `getModelInfo`
   *  reports whether Ollama considers the model tool-capable; if not,
   *  we transparently downgrade to prompt-mode (system-injected tool
   *  schema + text round-trip). Cached so we don't pay the /api/show
   *  cost on every chat call. */
  private toolModeCache = new Map<string, ToolMode>();
  private async resolveToolMode(model: string, hasTools: boolean): Promise<ToolMode> {
    // No tools → mode is irrelevant; don't probe and don't cache.
    if (!hasTools) return 'native';
    const cached = this.toolModeCache.get(model);
    if (cached) return cached;
    try {
      const info = await this.getModelInfo(model);
      const mode: ToolMode = info.supportsTools ? 'native' : 'prompt';
      this.toolModeCache.set(model, mode);
      return mode;
    } catch {
      // Probe failed (model not pulled, server unreachable). Default to
      // native — the underlying chat call will surface the real error
      // via translateOllamaError. Don't cache so a subsequent successful
      // probe wins.
      return 'native';
    }
  }

  /** Populate per-model caches (currently just `contextWindowCache`) so the
   *  synchronous `getCapabilities` reads the model's real context length
   *  instead of the hardcoded estimate. Best-effort: failures (server down,
   *  model not pulled) leave the cache empty and `getCapabilities` falls
   *  through to `estimateContextWindow`. Mirrors the listModels priming
   *  step in swap.ts.
   *
   *  Note: this supersedes the reliability stack's `discoverContextWindow`
   *  for Ollama. Both probe `/api/show` and parse the same
   *  `<arch>.context_length` key out of `model_info`; we keep a single
   *  cache (`contextWindowCache`) and a single priming entry point so
   *  callers don't duplicate the round-trip. The `Provider.discoverContextWindow`
   *  interface (docs/reliability/next-steps.md §11) is still implemented
   *  by `LlamaCppProvider` for the `/props` lookup; Ollama doesn't
   *  implement it since `primeModelCache` already populates the cache
   *  that `getCapabilities` reads. */
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

  /** Common request-builder for `chat` / `chatNoStream`. Pulls the
   *  tool-mode resolution + sampling + thinking branches out of the
   *  public methods so they stay under the eslint complexity cap.
   *  Prompt-mode strips `tools` from the wire payload — the model
   *  discovers them via the injected system preamble and emits its
   *  call as text the agent layer's <tool_call> parser picks up. */
  private async buildChatRequest(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    options: ChatOptions | undefined,
  ): Promise<{ base: Omit<ChatRequest, 'stream'>; think: boolean }> {
    const samplingOpts = resolveSampling(options, { model, providerName: 'ollama' });
    const think = resolveThinking(model, options?.thinking);
    const hasTools = !!tools && tools.length > 0;
    const toolMode = await this.resolveToolMode(model, hasTools);
    const messagesForWire =
      toolMode === 'prompt'
        ? withPromptModeSystem(
            downgradeMessagesForPromptMode(messages),
            buildPromptModeToolPreamble(tools!),
          )
        : (messages as Message[]);
    const base: Omit<ChatRequest, 'stream'> = {
      model,
      messages: messagesForWire,
      ...(toolMode === 'native' && hasTools ? { tools: tools as Tool[] } : {}),
      // num_predict caps output length so degenerate repetition loops can't
      // run forever. Ollama's default is -1 (no limit).
      options: ollamaOptions(this.resolveContextWindow(model), options?.maxTokens, samplingOpts),
      think,
    };
    return { base, think };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const { base, think } = await this.buildChatRequest(model, messages, tools, options);
    const request: ChatRequest & { stream: true } = { ...base, stream: true };

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
        yield mapOllamaChunk(chunk, think);
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
    const { base, think } = await this.buildChatRequest(model, messages, tools, options);
    const request: ChatRequest & { stream: false } = { ...base, stream: false };

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

    // Non-streaming responses are implicitly "done"; reuse the streaming
    // mapper with done=true forced on top.
    return { ...mapOllamaChunk({ ...response, done: true }, think), done: true };
  }
}

/** Shape we read off Ollama responses. Both streaming chunks and
 *  /api/chat non-stream responses fit this — distinct fields stay
 *  optional. Captured as an interface (rather than `any`-coerced) so
 *  the mapper stays type-checked. */
interface OllamaChunkLike {
  message?: {
    content?: string;
    tool_calls?: ReadonlyArray<{
      function: { name: string; arguments: unknown };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  eval_count?: number;
  prompt_eval_count?: number;
}

/** Convert an Ollama streaming chunk (or non-stream response coerced
 *  to the same shape) into the cross-provider ChatChunk. Extracted
 *  from `chat`/`chatNoStream` so the per-method complexity stays
 *  under the eslint cap. Applies the §15 think-tag discard when the
 *  caller opted out of thinking. */
function mapOllamaChunk(chunk: OllamaChunkLike, think: boolean): ChatChunk {
  const result: ChatChunk = {};
  const rawContent = chunk.message?.content;
  if (rawContent) {
    result.content = think ? rawContent : discardThinkTags(rawContent);
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
  return result;
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
 *  and we anchor on `<single-dotted-segment>.context_length` so unrelated
 *  dotted keys don't slip through. Returns 0 when the field is absent or
 *  non-numeric — callers fall back to {@link estimateContextWindow}.
 *  If `model_info` ever contains more than one matching key, iteration
 *  order decides — that's server-controlled (Object.entries follows
 *  insertion order, Map preserves it), so we trust whatever ollama puts
 *  first rather than try to guess which arch is "more specific."
 *  The SDK types declare `model_info: Map<string, any>`, but `show()`
 *  returns `(await response.json()) as ShowResponse` — JSON has no Map,
 *  so the runtime payload is always a plain object. The Map branch is
 *  defensive cover for a future SDK that actually constructs one. */
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
