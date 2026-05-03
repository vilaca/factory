import type { ToolDefinition } from '../tools/types.js';

export type { ToolDefinition };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCallMessage[];
  tool_call_id?: string;
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

export type ToolSupportLevel = 'native' | 'basic' | 'none';
export type ModelTier = 'strong' | 'medium' | 'weak';
export type TokenCountingMethod = 'exact' | 'estimated';

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
