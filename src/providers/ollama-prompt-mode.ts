import type { Message } from 'ollama';
import type { ChatMessage, ToolDefinition } from './types.js';

/**
 * Ollama prompt-mode tool calling. Used when Ollama reports
 * `supportsTools: false` for the chosen model — instead of failing,
 * we inject the tool schema into a system prompt and downgrade the
 * conversation history so the model sees a pure text dialogue. The
 * agent layer's existing `<tool_call>` text parser picks up the
 * model's response on the way back out.
 *
 * Mirrors `docs/reliability/next-steps.md` §16 ("LlamafileClient" block,
 * generalized to Ollama).
 */

/** Build the system-prompt addendum that teaches the model the
 *  prompt-mode tool-calling protocol. Kept short and declarative —
 *  small models do better with one example than with a long spec. */
export function buildPromptModeToolPreamble(tools: readonly ToolDefinition[]): string {
  const lines: string[] = [
    'You can call tools by emitting JSON inside <tool_call>...</tool_call> tags.',
    'Available tools:',
  ];
  for (const t of tools) {
    const desc = t.function.description?.trim() ?? '';
    lines.push(`- ${t.function.name}: ${desc}`);
    const schema = JSON.stringify(t.function.parameters ?? {});
    lines.push(`  parameters: ${schema}`);
  }
  lines.push('');
  lines.push('To call a tool, respond with exactly:');
  lines.push('<tool_call>{"name": "ToolName", "arguments": {"arg": "value"}}</tool_call>');
  lines.push('Call one tool per response. Do not wrap the JSON in any other markup.');
  return lines.join('\n');
}

/** Downgrade an outbound message history for prompt-mode dispatch:
 *
 *  - `role: 'tool'` → `role: 'user'` with a `[Tool result]` prefix. We
 *    correlate by walking back through `out` to find the most recent
 *    assistant tool_call and reusing its name — without that, sequential
 *    tool calls all look the same to the model.
 *  - assistant messages carrying `tool_calls` → assistant text containing
 *    the same call serialized inside `<tool_call>` tags, so the few-shot
 *    history demonstrates the protocol.
 *  - all other messages pass through unchanged.
 *
 *  Pure function — no mutation of the input array. */
export function downgradeMessagesForPromptMode(messages: readonly ChatMessage[]): Message[] {
  const out: Message[] = [];
  // Track the most recently emitted assistant tool call so a following
  // tool result can be tagged with the matching name.
  const recentToolNames: string[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const toolName = recentToolNames.shift() ?? 'tool';
      out.push({
        role: 'user',
        content: `[Tool result for ${toolName}]\n${m.content}`,
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const lines: string[] = [];
      if (m.content) lines.push(m.content);
      for (const tc of m.tool_calls) {
        const payload = JSON.stringify({
          name: tc.function.name,
          arguments: tc.function.arguments ?? {},
        });
        lines.push(`<tool_call>${payload}</tool_call>`);
        recentToolNames.push(tc.function.name);
      }
      out.push({ role: 'assistant', content: lines.join('\n') });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** Inject (or extend) a system prompt with the prompt-mode preamble.
 *  If the history already has a leading system message, the preamble
 *  is appended after a blank line. Otherwise a fresh system message
 *  is prepended. */
export function withPromptModeSystem(messages: Message[], preamble: string): Message[] {
  if (messages.length === 0 || messages[0]!.role !== 'system') {
    return [{ role: 'system', content: preamble }, ...messages];
  }
  const [sys, ...rest] = messages;
  return [{ ...sys!, content: `${sys!.content}\n\n${preamble}` }, ...rest];
}
