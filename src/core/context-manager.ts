import type {
  ChatMessage,
  Provider,
  ProviderCapabilities,
  TokenUsage,
} from '../providers/types.js';
import type { Conversation } from './conversation.js';
import { estimateMessagesTokens } from '../utils/tokens.js';
import { selectWeakTier } from './agent/weak-tier.js';
import { isError } from '../utils/errors.js';

interface ContextConfig {
  compactionThreshold: number; // 0-1, fraction of context window (default 0.75)
  recencyWindow: number; // floor on messages to keep during compaction (default 6)
  /** Soft token budget for the recency window. The actual count of kept
   * messages is whichever is larger — `recencyWindow` (count floor) or as
   * many trailing messages as fit under `recencyTokens`. Default 4000. */
  recencyTokens: number;
  /** Tool results from turns older than this are eligible for aging via
   * `ageOldToolResults`. Default 6. */
  toolResultAgingTurns: number;
}

const DEFAULT_CONFIG: ContextConfig = {
  compactionThreshold: 0.75,
  recencyWindow: 6,
  recencyTokens: 4000,
  toolResultAgingTurns: 6,
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
    // Build the merged config with explicit `??` fallbacks so callers passing
    // `{ compactionThreshold: undefined }` don't clobber the default. (Object
    // spread copies undefined values verbatim.)
    this.config = {
      compactionThreshold: config?.compactionThreshold ?? DEFAULT_CONFIG.compactionThreshold,
      recencyWindow: config?.recencyWindow ?? DEFAULT_CONFIG.recencyWindow,
      recencyTokens: config?.recencyTokens ?? DEFAULT_CONFIG.recencyTokens,
      toolResultAgingTurns: config?.toolResultAgingTurns ?? DEFAULT_CONFIG.toolResultAgingTurns,
    };
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

  /** Age tool results from turns older than the configured threshold. Runs
   *  before compaction in the agent's pre-flight pass — cheaper than full
   *  compaction and cache-friendly because only old messages mutate, so
   *  the prefix of recent turns stays byte-stable for re-cache. Returns
   *  the number of messages aged. */
  ageOldToolResults(): number {
    const aged = this.conversation.ageOldToolResults(this.config.toolResultAgingTurns);
    if (aged > 0) {
      this.tokenEstimate = estimateMessagesTokens(this.conversation.getMessages());
    }
    return aged;
  }

  async compact(
    provider: Provider,
    model: string,
    signal?: AbortSignal,
    opts?: {
      aggressive?: boolean;
      fingerprints?: Array<{ path: string; hash: string }>;
      /** When set, the LLM summary call is skipped and this string is used
       *  as the summary verbatim. Used by PreCompact hooks to override the
       *  context that survives compaction. */
      precomputedSummary?: string;
    },
  ): Promise<{ oldCount: number; newCount: number } | null> {
    const aggressive = opts?.aggressive ?? false;
    const fingerprints = opts?.fingerprints ?? [];
    if (!aggressive && !this.shouldCompact()) return null;

    // Aggressive mode tightens the recency window down to AGGRESSIVE_RECENCY
    // — enough to keep the latest user/assistant exchange so the active
    // task survives. Normal mode uses a token-weighted recency: keep at
    // least `recencyWindow` messages, plus enough trailing messages to fill
    // `recencyTokens` (whichever is more).
    const messages = this.conversation.getMessages();
    const recencyWindow = aggressive ? AGGRESSIVE_RECENCY : this.computeRecencyKeepCount(messages);
    if (messages.length <= recencyWindow + 1) {
      return null;
    }

    const summarizeEnd = recencyWindow === 0 ? undefined : -recencyWindow;
    const toSummarize = messages.slice(1, summarizeEnd);
    if (toSummarize.length === 0) return null;

    // For the summary call, route to a weak-tier model on the same provider
    // when available — Haiku / Llama-3.1-8B / Gemini-Flash etc. The
    // summarization workload doesn't need the strong tier, and routing the
    // user's primary turn through this is explicitly NOT a goal (see
    // selectWeakTier docs). Both aggressive and normal compaction benefit.
    const summaryModel = selectWeakTier(provider, model) ?? model;

    let summary: string;
    if (opts?.precomputedSummary !== undefined) {
      // A PreCompact hook returned a custom summary — trust it and skip both
      // the model and mechanical fallbacks. This is the only override path.
      summary = opts.precomputedSummary;
    } else {
      // Both aggressive and normal compaction try the weak-tier model first;
      // mechanical is the fallback when the model call fails (per the source
      // plan: "skip-model-entirely path is overcautious").
      summary =
        (await this.buildModelSummary(provider, summaryModel, toSummarize, signal)) ??
        this.buildMechanicalSummary(toSummarize);
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

  /** Walk messages from the end, accumulating estimated tokens, until the
   *  budget is met. Returns the count of trailing messages to keep. The
   *  count is bounded below by `recencyWindow` so a small budget can't
   *  drop the latest exchange. */
  private computeRecencyKeepCount(messages: ChatMessage[]): number {
    const budget = this.config.recencyTokens;
    if (budget <= 0) return this.config.recencyWindow;
    let acc = 0;
    let count = 0;
    for (let i = messages.length - 1; i >= 1; i--) {
      // skip system at [0]
      const tokens = estimateMessagesTokens([messages[i]]);
      acc += tokens;
      count++;
      if (acc >= budget) break;
    }
    return Math.max(count, this.config.recencyWindow);
  }

  /** Ask the model to produce a freeform summary of `toSummarize`. Returns
   *  null on any non-abort failure (caller falls back to mechanical).
   *  Re-throws aborts so the agent loop handles them as user-abort. */
  private async buildModelSummary(
    provider: Provider,
    model: string,
    toSummarize: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<string | null> {
    const summaryPrompt: ChatMessage[] = [
      {
        role: 'system',
        content:
          'Summarize the key context from this conversation. Include: files accessed, tools used, decisions made, and current task state. Be concise.',
      },
      ...toSummarize,
      {
        role: 'user',
        content:
          'Provide a concise summary of the conversation above, focusing on context needed to continue the work.',
      },
    ];
    try {
      const response = await provider.chatNoStream(model, summaryPrompt, undefined, {
        maxTokens: 512,
        signal,
      });
      return response.content ?? null;
    } catch (err: unknown) {
      if (signal?.aborted || (isError(err) && err.name === 'AbortError')) throw err;
      return null;
    }
  }

  private buildMechanicalSummary(
    messages: Array<{ role: string; content: string; tool_calls?: any[] }>,
  ): string {
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
      if (
        msg.role === 'user' &&
        typeof msg.content === 'string' &&
        msg.content.startsWith(SUMMARY_PREFIX)
      ) {
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
      lines.push(
        `Latest assistant reply: ${truncate(latestAssistant, LATEST_ASSISTANT_MAX_CHARS)}`,
      );
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
