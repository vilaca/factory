export interface ToolCallMessage {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * Semantic message classification used by the reliability stack. Plain
 * role + content doesn't carry enough information for compaction to make
 * informed cut/keep decisions ("drop the retry nudge but keep the
 * reasoning") or for observability to count nudges vs. real text turns.
 * The tag lives only in-process; it's stripped before serialization to
 * any provider, so adding it is wire-invisible.
 *
 * Tag taxonomy follows the reliability spec (docs/reliability/next-steps.md §3):
 *  - `system_prompt`  — never cut by compaction.
 *  - `user_input`     — original user turn; never cut.
 *  - `tool_call`      — assistant message carrying tool_calls; preserved.
 *  - `tool_result`    — `role=tool` payload; truncatable then droppable.
 *  - `reasoning`      — assistant chain-of-thought; preserved through P2.
 *  - `text_response`  — assistant text (no tool call); dropped P3.
 *  - `step_nudge`     — premature-terminal corrective; transient.
 *  - `prerequisite_nudge` — prereq corrective; transient.
 *  - `retry_nudge`    — malformed-call corrective; transient.
 *  - `context_warning` — pressure signal; never persisted (transient by construction).
 *  - `summary`        — synthetic post-compaction summary; preserved.
 *
 * Inference rule when unset: callers that don't tag fall back to a
 * role-based default (see `inferDefaultMessageType`). Phase 2 keeps the
 * old un-tagged appends working while later phases (3, 5, 6) start
 * setting the tag explicitly.
 */
export type MessageType =
  | 'system_prompt'
  | 'user_input'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning'
  | 'text_response'
  | 'step_nudge'
  | 'prerequisite_nudge'
  | 'retry_nudge'
  | 'context_warning'
  | 'summary';

export interface MessageMeta {
  type: MessageType;
  /** Iteration boundary marker. A parallel tool-call batch (one
   *  TOOL_CALL + N TOOL_RESULT messages) shares one `stepIndex` so
   *  tiered compaction (Phase 3) doesn't split a batch mid-cut. Set by
   *  the agent loop; readers must tolerate `undefined` on pre-tagging
   *  history. */
  stepIndex?: number;
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
  /** In-process semantic tag. Stripped by `Conversation.getMessages()`
   *  before any provider sees the array — readers downstream of that
   *  call boundary should never observe it. */
  metadata?: MessageMeta;
}

/** Best-effort default tagging for messages whose author didn't set
 *  `metadata.type`. Encodes the historical mapping that existed before
 *  the tag was introduced — keeps the inference cheap and the test
 *  surface small while later phases migrate call sites to explicit
 *  tagging. */
export function inferDefaultMessageType(msg: ChatMessage): MessageType {
  if (msg.role === 'system') return 'system_prompt';
  if (msg.role === 'user') return 'user_input';
  if (msg.role === 'tool') return 'tool_result';
  // Assistant: a tool_call message carries tool_calls; otherwise plain text.
  if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
    return 'tool_call';
  }
  return 'text_response';
}

/** Strip `metadata` from a `ChatMessage` before it crosses the wire
 *  boundary. Providers don't know about the tag — leaving it on the
 *  serialized payload would either be ignored (best case) or surface as
 *  an unknown field error on strict providers. */
export function stripMetadata(msg: ChatMessage): ChatMessage {
  if (!msg.metadata) return msg;
  const { metadata: _omit, ...rest } = msg;
  return rest;
}
