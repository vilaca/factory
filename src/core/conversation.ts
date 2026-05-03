import type { ChatMessage, ToolCallMessage } from '../providers/types.js';

export class Conversation {
  private messages: ChatMessage[] = [];

  constructor(private systemPrompt: string) {}

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

  addToolResult(content: string, toolCallId?: string): void {
    const msg: ChatMessage = { role: 'tool', content };
    if (toolCallId) {
      msg.tool_call_id = toolCallId;
    }
    this.messages.push(msg);
  }

  /**
   * Replace all messages before the recency window with a summary message.
   * Keeps the last `keepCount` messages intact.
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

    const kept = this.messages.slice(cutPoint);
    this.messages = [
      { role: 'user', content: `[Previous conversation summary]\n${summary}` },
      { role: 'assistant', content: 'Continuing from the summary above.' },
      ...kept,
    ];

    return { oldCount, newCount: this.messages.length };
  }

  clear(): void {
    this.messages = [];
  }

  updateSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }
}
