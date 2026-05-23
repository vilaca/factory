import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ModelRequestSource,
  Provider,
  ToolDefinition,
} from './types.js';

export type { ModelRequestSource } from './types.js';

export interface ModelRequestInfo {
  source: ModelRequestSource;
  streaming: boolean;
  provider: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  options?: ChatOptions;
}

export type OnModelRequest = (info: ModelRequestInfo) => void;

/**
 * Wrap a `Provider` so every `chat` / `chatNoStream` call fires `onRequest`
 * with the outgoing payload before delegating to the underlying provider.
 * The caller decides how to classify the request: the session-level wrapper
 * tags requests as `main` by default, and helpers like the compaction
 * resolver rewrap with `source: 'compaction'`.
 *
 * The wrapped instance preserves all other Provider methods (`listModels`,
 * `getCapabilities`, `getModelInfo`, …) by delegating through proxy bindings.
 * `name` and `getDisplayModelName` are forwarded so picker UI and rotation
 * keying behave identically.
 */
export function instrumentProviderRequests(
  inner: Provider,
  onRequest: OnModelRequest,
  defaultSource: ModelRequestSource = 'main',
): Provider {
  // Best-effort: logging must never break an LLM call. If onRequest throws,
  // surface to stderr once (mirrors the session-log fs-error surface) and
  // continue with the delegated call.
  let onRequestFailureNotified = false;
  const safeFire = (info: ModelRequestInfo): void => {
    try {
      onRequest(info);
    } catch (err) {
      if (!onRequestFailureNotified) {
        onRequestFailureNotified = true;
        process.stderr.write(
          `factory: model-request logger failed — ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  };
  const resolveSource = (options?: ChatOptions): ModelRequestSource =>
    options?._requestSource ?? defaultSource;
  const wrapped: Provider = {
    name: inner.name,
    listModels: inner.listModels.bind(inner),
    getCapabilities: inner.getCapabilities.bind(inner),
    chat(
      model: string,
      messages: ChatMessage[],
      tools?: ToolDefinition[],
      options?: ChatOptions,
    ): AsyncGenerator<ChatChunk> {
      safeFire({
        source: resolveSource(options),
        streaming: true,
        provider: inner.name,
        model,
        messages,
        ...(tools ? { tools } : {}),
        ...(options ? { options } : {}),
      });
      return inner.chat(model, messages, tools, options);
    },
    async chatNoStream(
      model: string,
      messages: ChatMessage[],
      tools?: ToolDefinition[],
      options?: ChatOptions,
    ): Promise<ChatChunk> {
      safeFire({
        source: resolveSource(options),
        streaming: false,
        provider: inner.name,
        model,
        messages,
        ...(tools ? { tools } : {}),
        ...(options ? { options } : {}),
      });
      return inner.chatNoStream(model, messages, tools, options);
    },
  };
  if (inner.getDisplayModelName)
    wrapped.getDisplayModelName = inner.getDisplayModelName.bind(inner);
  if (inner.getModelPickerInfo) wrapped.getModelPickerInfo = inner.getModelPickerInfo.bind(inner);
  if (inner.getModelInfo) wrapped.getModelInfo = inner.getModelInfo.bind(inner);
  if (inner.primeModelCache) wrapped.primeModelCache = inner.primeModelCache.bind(inner);
  if (inner.countTokens) wrapped.countTokens = inner.countTokens.bind(inner);
  return wrapped;
}
