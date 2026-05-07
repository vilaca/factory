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
}

export interface ChatChunk {
  content?: string;
  tool_calls?: ToolCallMessage[];
  done?: boolean;
  usage?: TokenUsage;
  /** Provider-supplied stop reason on the final chunk. Ollama uses values like
   * "stop" (natural), "length" (hit num_predict), "load" (model still loading). */
  doneReason?: string;
}

type ToolSupportLevel = 'native' | 'basic' | 'none';
export type ModelTier = 'strong' | 'medium' | 'weak';
type TokenCountingMethod = 'exact' | 'estimated';

export interface ProviderCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  toolSupport: ToolSupportLevel;
  parallelToolCalls: boolean;
  streaming: boolean;
  tokenCounting: TokenCountingMethod;
  modelTier: ModelTier;
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
