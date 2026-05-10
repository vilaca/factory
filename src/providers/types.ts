import type { ToolDefinition } from '../tools/types.js';

export type { ToolDefinition };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCallMessage[];
  tool_call_id?: string;
  /** Hint to providers that this message is the last one in a stable prefix
   * worth caching. Vendor-neutral: providers that support explicit cache
   * markers (Anthropic) translate to their native blocks; others ignore. */
  cacheBoundary?: boolean;
}

export interface ToolCallMessage {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Input tokens served from the provider's prompt cache. Optional —
   * providers that don't surface a cache split leave this undefined. */
  cachedPromptTokens?: number;
  /** Input tokens written into the cache on this turn (Anthropic-style
   * explicit caching). Optional. */
  cacheCreationTokens?: number;
  /** Hidden-reasoning output tokens (OpenAI o-series, codex via the
   * Responses API). Counted *inside* completionTokens; surfaced separately
   * so the UI can split "thinking vs answer" cost. Undefined for providers
   * that don't expose the breakdown. */
  reasoningTokens?: number;
}

export interface ChatChunk {
  content?: string;
  tool_calls?: ToolCallMessage[];
  /** Streaming providers MAY emit more than one `done: true` chunk per call.
   *  The OpenAI chat stream, for example, yields a first `done` carrying
   *  `doneReason` and `usage` when `finish_reason` arrives in the SSE
   *  channel, then a second `done` carrying finalized `tool_calls` after
   *  delta accumulation completes. Consumers must iterate to the generator's
   *  actual end and merge fields chunk-by-chunk; do not break on the first
   *  `done: true` or tool calls will be lost. */
  done?: boolean;
  usage?: TokenUsage;
  /** Provider-supplied stop reason on the final chunk. Ollama uses values like
   * "stop" (natural), "length" (hit num_predict), "load" (model still loading). */
  doneReason?: string;
  /** Stored-response id from OpenAI's /v1/responses, set on the terminal
   *  chunk. The agent loop captures it into a per-session ResponsesChain so
   *  the next call can pass `previous_response_id` and reuse server-side
   *  reasoning tokens — codex generates 5–15k of these per turn at output
   *  rates, so reuse is a real cost reduction. Other providers leave it
   *  undefined. */
  responseId?: string;
}

type ToolSupportLevel = 'native' | 'basic' | 'none';
export type ModelTier = 'strong' | 'medium' | 'weak';
type TokenCountingMethod = 'exact' | 'estimated';

/** Reasoning effort hint passed through to providers that expose a native
 *  reasoning control. OpenAI Responses API maps this to `reasoning.effort`
 *  (https://platform.openai.com/docs/guides/reasoning). Other providers
 *  (Anthropic `thinking`, Google `thinkingConfig`) can map the same enum to
 *  their own shapes when wired. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface ProviderCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  toolSupport: ToolSupportLevel;
  parallelToolCalls: boolean;
  streaming: boolean;
  tokenCounting: TokenCountingMethod;
  modelTier: ModelTier;
  /** True for coding-specialist fine-tunes (codex, coder). Used by the
   *  picker to float them above generic flagships within the same tier
   *  since this CLI is a coding agent. Inferred via generic substring
   *  match — no per-family table needed. */
  codingSpecialist?: boolean;
}

export interface ModelInfo {
  supportsTools: boolean;
  capabilities?: string[];
}

export interface ModelPickerInfo {
  label?: string;
  detail?: string;
  warning?: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Hint to providers that support explicit cache markers (Anthropic,
   * OpenRouter→Anthropic) to cache the tool definitions. Vendor-neutral:
   * other providers ignore. Pairs with `cacheBoundary` on ChatMessage so
   * the agent layer has a single decision point for cache placement. */
  cacheTools?: boolean;
  /** Active OpenAI Responses-API chain pointer. When set on a /v1/responses
   *  call, the body is built with `previous_response_id` and the input is
   *  trimmed to messages.slice(messageCount). Providers that don't speak
   *  the Responses API ignore this. Pairs with ChatChunk.responseId for
   *  capture on the way out. */
  responsesChain?: { lastResponseId: string; messageCount: number };
  /** OpenAI Responses API persistence toggle. Defaults to true when omitted so
   *  codex turns can chain via `previous_response_id`. Set false to opt out of
   *  server-side storage on providers that honor this flag. */
  responsesStore?: boolean;
  /** Responses-API tool strictness hint. When true, providers that support
   *  strict JSON-schema tool calling set the equivalent native flag. */
  toolStrict?: boolean;
  /** Reasoning effort override. When unset, providers pick a per-model
   *  default. Providers without a native reasoning control ignore. */
  reasoningEffort?: ReasoningEffort;
}

export interface Provider {
  name: string;
  listModels(): Promise<string[]>;
  getDisplayModelName?(model: string): string;
  getModelPickerInfo?(model: string): ModelPickerInfo;
  getCapabilities(model: string): ProviderCapabilities;
  getModelInfo?(model: string): Promise<ModelInfo>;
  chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk>;
  chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk>;
  countTokens?(messages: ChatMessage[]): Promise<number>;
}
