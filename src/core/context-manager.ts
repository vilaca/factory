import type { Provider, ProviderCapabilities, TokenUsage } from '../providers/types.js';
import type { Conversation } from './conversation.js';
import { estimateMessagesTokens } from '../utils/tokens.js';

export interface ContextConfig {
  compactionThreshold: number; // 0-1, fraction of context window (default 0.75)
  recencyWindow: number;       // messages to keep during compaction (default 6)
}

const DEFAULT_CONFIG: ContextConfig = {
  compactionThreshold: 0.75,
  recencyWindow: 6,
};

// Aggressive mode used to drop the recency window entirely. That nuked the
// active task — the conversation post-compaction looked like a fresh start
// even when the user was mid-thread. Keep two messages so the latest
// user/assistant exchange survives.
const AGGRESSIVE_RECENCY = 2;

const LATEST_USER_MAX_CHARS = 500;
const LATEST_ASSISTANT_MAX_CHARS = 300;
const SUMMARY_PREFIX = '[Previous conversation summary]\n';
const AUTO_RETRY_PREFIX = 'Your last tool call failed with:';

export class ContextManager {
  private tokenEstimate: number = 0;
  private config: ContextConfig;
  private contextWindow: number;

  constructor(
    private conversation: Conversation,
    capabilities: ProviderCapabilities,
    config?: Partial<ContextConfig>,
  ) {
    this.contextWindow = capabilities.contextWindow;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  updateUsage(usage?: TokenUsage): void {
    if (usage) {
      this.tokenEstimate = usage.totalTokens;
    } else {
      this.tokenEstimate = estimateMessagesTokens(this.conversation.getMessages());
    }
  }

  getTokenEstimate(): number {
    return this.tokenEstimate;
  }

  getUsagePercent(): number {
    if (this.contextWindow === 0) return 0;
    return this.tokenEstimate / this.contextWindow;
  }

  shouldCompact(): boolean {
    return this.getUsagePercent() > this.config.compactionThreshold;
  }

  async compact(
    provider: Provider,
    model: string,
    signal?: AbortSignal,
    opts?: { aggressive?: boolean; fingerprints?: Array<{ path: string; hash: string }> },
  ): Promise<{ oldCount: number; newCount: number } | null> {
    const aggressive = opts?.aggressive ?? false;
    const fingerprints = opts?.fingerprints ?? [];
    if (!aggressive && !this.shouldCompact()) return null;

    // Aggressive mode skips the model summary call (sending the to-summarize
    // messages may itself overflow a small context window) and tightens the
    // recency window down to AGGRESSIVE_RECENCY — enough to keep the latest
    // user/assistant exchange so the active task survives.
    const recencyWindow = aggressive ? AGGRESSIVE_RECENCY : this.config.recencyWindow;
    const messages = this.conversation.getMessages();
    if (messages.length <= recencyWindow + 1) {
      return null;
    }

    const summarizeEnd = recencyWindow === 0 ? undefined : -recencyWindow;
    const toSummarize = messages.slice(1, summarizeEnd);
    if (toSummarize.length === 0) return null;

    let summary: string;
    if (aggressive) {
      summary = this.buildMechanicalSummary(toSummarize);
    } else {
      const summaryPrompt = [
        {
          role: 'system' as const,
          content: 'Summarize the key context from this conversation. Include: files accessed, tools used, decisions made, and current task state. Be concise.',
        },
        ...toSummarize,
        {
          role: 'user' as const,
          content: 'Provide a concise summary of the conversation above, focusing on context needed to continue the work.',
        },
      ];
      try {
        const response = await provider.chatNoStream(model, summaryPrompt, undefined, { maxTokens: 512, signal });
        summary = response.content ?? this.buildMechanicalSummary(toSummarize);
      } catch (err: any) {
        // Don't swallow user aborts as a "model failed" — let the agent loop
        // exit cleanly via its existing AbortError handler.
        if (signal?.aborted || err?.name === 'AbortError') throw err;
        summary = this.buildMechanicalSummary(toSummarize);
      }
    }

    // Append known file fingerprints so the agent can re-Read post-compaction
    // and immediately confirm "still unchanged" without us having to keep the
    // full content in conversation history.
    if (fingerprints.length > 0) {
      const lines = ['', 'Known file fingerprints (re-Read to confirm content unchanged):'];
      for (const { path, hash } of fingerprints.slice(0, 30)) {
        lines.push(`  ${path}  sha256:${hash.slice(0, 16)}…`);
      }
      summary = `${summary}\n${lines.join('\n')}`;
    }

    const result = this.conversation.replaceWithSummary(summary, recencyWindow);
    this.tokenEstimate = estimateMessagesTokens(this.conversation.getMessages());
    return result;
  }

  private buildMechanicalSummary(messages: Array<{ role: string; content: string; tool_calls?: any[] }>): string {
    const toolsUsed = new Set<string>();
    const filesAccessed = new Set<string>();
    // Carry forward any prior summary text so cascaded compactions don't drop it.
    const priorSummaries: string[] = [];

    for (const msg of messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolsUsed.add(tc.function.name);
          const args = tc.function.arguments;
          if (args?.file_path) filesAccessed.add(String(args.file_path));
          if (args?.path) filesAccessed.add(String(args.path));
        }
      }
      if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith(SUMMARY_PREFIX)) {
        priorSummaries.push(msg.content.slice(SUMMARY_PREFIX.length));
      }
    }

    const latestUser = findLatestUserRequest(messages);
    const latestAssistant = findLatestAssistantContent(messages);

    const lines = [`Conversation summary (${messages.length} messages compacted):`];
    if (priorSummaries.length > 0) {
      lines.push(...priorSummaries);
    }
    if (latestUser) {
      lines.push(`Latest user request: ${truncate(latestUser, LATEST_USER_MAX_CHARS)}`);
    }
    if (latestAssistant) {
      lines.push(`Latest assistant reply: ${truncate(latestAssistant, LATEST_ASSISTANT_MAX_CHARS)}`);
    }
    if (toolsUsed.size > 0) {
      lines.push(`Tools used: ${[...toolsUsed].join(', ')}`);
    }
    if (filesAccessed.size > 0) {
      lines.push(`Files accessed: ${[...filesAccessed].slice(0, 20).join(', ')}`);
    }
    return lines.join('\n');
  }
}

type SummaryMessage = { role: string; content: string; tool_calls?: any[] };

function findLatestUserRequest(messages: SummaryMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    const content = msg.content.trim();
    if (!content) continue;
    if (content.startsWith(SUMMARY_PREFIX.trim())) continue;
    if (content.startsWith(AUTO_RETRY_PREFIX)) continue;
    return content;
  }
  return null;
}

function findLatestAssistantContent(messages: SummaryMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || typeof msg.content !== 'string') continue;
    const content = msg.content.trim();
    if (!content) continue;
    return content;
  }
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)} …`;
}
