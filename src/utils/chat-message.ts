export interface ToolCallMessage {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

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
