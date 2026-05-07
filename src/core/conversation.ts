import type { ChatMessage, ToolCallMessage } from '../providers/types.js';
import { CHARS_PER_TOKEN } from '../utils/tokens.js';

const DEFAULT_MAX_TOOL_RESULT_TOKENS = 6_000;

/** Marker emitted in place of the original content when a tool result is
 *  larger than the cap. Keep the shape stable — `ageOldToolResults`
 *  produces the same template, and tooling that greps session JSONL for
 *  elisions matches on this prefix. */
export function elisionStub(toolName: string, byteLength: number): string {
  const kb = Math.max(1, Math.round(byteLength / 1024));
  return `[elided: tool=${toolName} size=${kb}kB — too large for context, ask again or narrow the call]`;
}

export class Conversation {
  private messages: ChatMessage[] = [];

  constructor(
    private systemPrompt: string,
    private maxToolResultTokens: number = DEFAULT_MAX_TOOL_RESULT_TOKENS,
  ) {}

  getMessages(): ChatMessage[] {
    return [
      { role: 'system', content: this.systemPrompt },
      ...this.messages,
    ];
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  messageCount(): number {
    return this.messages.length;
  }

  addUser(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  addAssistant(content: string, toolCalls?: ToolCallMessage[]): void {
    const msg: ChatMessage = { role: 'assistant', content };
    if (toolCalls && toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
    }
    this.messages.push(msg);
  }

  addToolResult(content: string, toolCallId?: string, toolName?: string): void {
    const cap = this.maxToolResultTokens * CHARS_PER_TOKEN;
    const finalContent = content.length > cap
      ? elisionStub(toolName ?? '<tool>', content.length)
      : content;
    const msg: ChatMessage = { role: 'tool', content: finalContent };
    if (toolCallId) {
      msg.tool_call_id = toolCallId;
    }
    this.messages.push(msg);
  }

  /**
   * Replace the most recent tool result in place. Used by the tool-call
   * corrector so that a failed call followed by a corrected substitute
   * resolves into a *single* tool_result keyed to the original tool_use id —
   * appending a second tool_result would have no matching tool_use and the
   * Anthropic API rejects the request.
   *
   * Applies the same size cap as `addToolResult`; otherwise the corrector
   * path is a backdoor for oversized output to bypass the per-result cap.
   * Falls back to appending if no prior tool result exists.
   */
  replaceLastToolResult(content: string, toolCallId?: string, toolName?: string): void {
    const cap = this.maxToolResultTokens * CHARS_PER_TOKEN;
    const finalContent = content.length > cap
      ? elisionStub(toolName ?? '<tool>', content.length)
      : content;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'tool') {
        const msg: ChatMessage = { role: 'tool', content: finalContent };
        if (toolCallId) {
          msg.tool_call_id = toolCallId;
        }
        this.messages[i] = msg;
        return;
      }
    }
    this.addToolResult(content, toolCallId, toolName);
  }

  /**
   * Replace all messages before the recency window with a summary message.
   * Keeps the last `keepCount` messages intact. The synthetic
   * user/assistant pair that opens the post-compaction conversation is
   * marked `cacheBoundary: true` on the assistant ack so explicit-cache
   * providers (Anthropic) can reanchor — without this, every compaction
   * would invalidate the cache for the rest of the session.
   */
  replaceWithSummary(summary: string, keepCount: number): { oldCount: number; newCount: number } {
    if (this.messages.length <= keepCount) {
      return { oldCount: this.messages.length, newCount: this.messages.length };
    }

    const oldCount = this.messages.length;

    // Adjust keep boundary to avoid splitting tool_call/tool_result pairs.
    // If the first kept message is a 'tool' role, extend backwards to include
    // the preceding assistant message (which has the tool_call).
    let cutPoint = this.messages.length - keepCount;
    while (cutPoint > 0 && cutPoint < this.messages.length && this.messages[cutPoint].role === 'tool') {
      cutPoint--;
    }
    // The walk bottoms out at 0 when every message before the recency
    // window is a tool message (pathological — conversations don't open
    // with tools, so this is constructed input or a corrupted log). At
    // cutPoint=0 the slice keeps every original message AND we'd prepend
    // a "previous conversation summary" that duplicates them — confusing
    // timeline. Skip this pass; the next compaction will retry.
    if (cutPoint === 0) {
      return { oldCount, newCount: this.messages.length };
    }

    const kept = this.messages.slice(cutPoint);
    this.messages = [
      { role: 'user', content: `[Previous conversation summary]\n${summary}` },
      { role: 'assistant', content: 'Continuing from the summary above.', cacheBoundary: true },
      ...kept,
    ];

    return { oldCount, newCount: this.messages.length };
  }

  /**
   * Replace tool results from turns older than `turnsToKeep` with elision
   * stubs. Counts user messages from the end as turn boundaries; the
   * `turnsToKeep`-th most recent user message anchors the cut. Tool
   * messages strictly before that index are aged. Preserves tool_call_id
   * so the tool_use ↔ tool_result invariant Anthropic enforces stays
   * intact. Already-elided messages are skipped (idempotent). Returns the
   * number of messages that were rewritten.
   */
  ageOldToolResults(turnsToKeep: number): number {
    if (turnsToKeep <= 0) return 0;
    let userCount = 0;
    let boundaryIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') {
        userCount++;
        if (userCount === turnsToKeep) {
          boundaryIdx = i;
          break;
        }
      }
    }
    if (boundaryIdx <= 0) return 0;

    let aged = 0;
    for (let i = 0; i < boundaryIdx; i++) {
      const m = this.messages[i];
      if (m.role !== 'tool') continue;
      if (m.content.startsWith('[elided:')) continue;
      const replacement: ChatMessage = {
        role: 'tool',
        content: elisionStub('<tool>', m.content.length),
      };
      if (m.tool_call_id) replacement.tool_call_id = m.tool_call_id;
      this.messages[i] = replacement;
      aged++;
    }
    return aged;
  }

  clear(): void {
    this.messages = [];
  }

  updateSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }
}
