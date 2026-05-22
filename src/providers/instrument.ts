import type { ChatChunk, ChatMessage, ChatOptions, Provider, ToolDefinition } from './types.js';

/**
 * Source label for an outgoing LLM call. Used by the session log to bucket
 * requests by which subsystem issued them (main agent turn, compaction
 * summary, tool-call corrector, subagent runner).
 */
export type ModelRequestSource = 'main' | 'compaction' | 'corrector' | 'subagent';

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
      onRequest({
        source: defaultSource,
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
      onRequest({
        source: defaultSource,
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
  if (inner.getDisplayModelName) wrapped.getDisplayModelName = inner.getDisplayModelName.bind(inner);
  if (inner.getModelPickerInfo) wrapped.getModelPickerInfo = inner.getModelPickerInfo.bind(inner);
  if (inner.getModelInfo) wrapped.getModelInfo = inner.getModelInfo.bind(inner);
  if (inner.countTokens) wrapped.countTokens = inner.countTokens.bind(inner);
  return wrapped;
}
