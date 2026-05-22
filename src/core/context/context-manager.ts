import type {
  ChatMessage,
  Provider,
  ProviderCapabilities,
  TokenUsage,
  ToolDefinition,
} from '../../providers/types.js';
import type { Conversation } from './conversation.js';
import {
  estimateMessagesTokens,
  estimateSingleMessageTokens,
  estimateToolDefinitionsTokens,
} from '../../utils/tokens.js';
import { isError } from '../../utils/errors.js';

/** Caller-provided async hook that resolves the (provider, model) used
 *  for the summarization call inside compaction. Returning `null` means
 *  "user declined / not available" — `compact()` will return null
 *  without rewriting the conversation, so the agent continues with
 *  un-compacted history (and likely overflows on the next turn). */
export type CompactionTargetResolver = () => Promise<{
  provider: Provider;
  model: string;
} | null>;

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

/** Token reservations for the summary call's own framing — see
 *  `buildModelSummary`: a system instruction (~30 tokens) and a closing
 *  user prompt (~30 tokens), plus margin. Subtracted from the context
 *  window when deciding whether `toSummarize` fits. */
const SUMMARY_FRAMING_TOKENS = 100;
/** Output tokens reserved for the summary itself — matches `maxTokens`
 *  passed to `provider.chatNoStream` in `buildModelSummary`. */
const SUMMARY_OUTPUT_RESERVE = 512;
/** Safety multiplier applied to the budget after framing/output are
 *  subtracted. The heuristic estimate can undercount by ~10–15% on
 *  tokenizer mismatch, so leaving this margin keeps a near-budget slice
 *  from overflowing the provider limit. */
const SUMMARY_BUDGET_SAFETY = 0.85;

export class ContextManager {
  private tokenEstimate: number = 0;
  /** Last provider-reported prompt token count; floors heuristic estimate. */
  private lastPromptTokensFromApi: number = 0;
  private config: ContextConfig;
  private contextWindow: number;
  /** Resolver used by compact() to obtain the summary-call (provider,
   *  model). Optional — when unset, compact() falls back to using the
   *  primary (provider, model) passed in. This is the headless /
   *  legacy-test path; the TUI always wires a resolver that prompts the
   *  user once per session. */
  private resolveCompactionTarget?: CompactionTargetResolver;
  /** Latched when a resolver call in the current turn returned null
   *  (user cancelled). Suppresses re-prompting during the aggressive
   *  pass in the same `maybeCompact` invocation. Cleared by
   *  `clearCompactionCancelled()`, which the agent loop calls at the
   *  start of each turn. */
  private compactionCancelledThisTurn = false;

  constructor(
    private conversation: Conversation,
    capabilities: ProviderCapabilities,
    config?: Partial<ContextConfig>,
    resolveCompactionTarget?: CompactionTargetResolver,
  ) {
    this.contextWindow = capabilities.contextWindow;
    if (resolveCompactionTarget) this.resolveCompactionTarget = resolveCompactionTarget;
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

  /** Store prompt-token count from the last model response (floors heuristic). */
  recordPromptUsage(usage: TokenUsage | undefined): void {
    if (usage && usage.promptTokens > 0) {
      this.lastPromptTokensFromApi = usage.promptTokens;
    }
  }

  /** Recompute the token estimate for the *next* model call. Combines
   *  three sources: a heuristic char-to-token estimate of the conversation
   *  messages, the JSON-serialized tool definitions sent alongside (when
   *  applicable), and a floor pulled from the most recent provider
   *  response's `promptTokens` (whichever is larger). The floor matters
   *  because the char heuristic systematically undercounts on tool-heavy
   *  prompts; without it, compaction would defer until the next call
   *  actually overflows the window.
   *
   *  Callers must pass the same definitions the agent loop will hand to
   *  `provider.chat`, or `[]` when no tools will be sent (text-tool
   *  fallback mode). Forgetting to thread the list through means the
   *  estimate undercounts and compaction defers past the safe point. */
  refreshEstimate(toolDefinitions: ToolDefinition[]): void {
    const messagesTokens = estimateMessagesTokens(this.conversation.getMessages());
    const toolsTokens = estimateToolDefinitionsTokens(toolDefinitions);
    const heuristic = messagesTokens + toolsTokens;
    this.tokenEstimate = Math.max(heuristic, this.lastPromptTokensFromApi);
  }

  /** @deprecated Prefer {@link refreshEstimate} with explicit tool
   *  definitions. Kept as a back-compat shim for callers that haven't
   *  threaded the tool list through yet — the resulting estimate
   *  undercounts the per-request tool-schema overhead. */
  updateUsage(usage?: TokenUsage): void {
    if (usage?.promptTokens && usage.promptTokens > 0) {
      this.recordPromptUsage(usage);
    }
    this.refreshEstimate([]);
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

  /** Reset the "user cancelled compaction this turn" latch. Called by the
   *  agent loop at the start of each turn so a cancel in turn N doesn't
   *  bleed into turn N+1. */
  clearCompactionCancelled(): void {
    this.compactionCancelledThisTurn = false;
  }

  /** Age tool results from turns older than the configured threshold. Runs
   *  before compaction in the agent's pre-flight pass — cheaper than full
   *  compaction and cache-friendly because only old messages mutate, so
   *  the prefix of recent turns stays byte-stable for re-cache. Returns
   *  the number of messages aged. */
  ageOldToolResults(toolDefinitions: ToolDefinition[]): number {
    const aged = this.conversation.ageOldToolResults(this.config.toolResultAgingTurns);
    if (aged > 0) {
      this.refreshEstimate(toolDefinitions);
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
      /** Same definitions passed to the main model call — refreshes estimate post-compaction. */
      toolDefinitions?: ToolDefinition[];
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

    // For the summary call, ask the caller (TUI session) which (provider,
    // model) to use. The resolver typically prompts the user once per
    // session via the picker and caches the choice; headless callers
    // pre-seed the choice from --compaction-model. On cancel the resolver
    // returns null and we abort this compaction pass entirely — the
    // conversation stays uncompacted, the cancel latch fires so the
    // aggressive pass in the same maybeCompact() doesn't re-prompt, and
    // the agent loop will retry the prompt on the next turn (the latch
    // is cleared by clearCompactionCancelled()).
    let summaryProvider: Provider = provider;
    let summaryModel: string = model;
    if (this.resolveCompactionTarget && !opts?.precomputedSummary) {
      if (this.compactionCancelledThisTurn) return null;
      const target = await this.resolveCompactionTarget();
      if (target === null) {
        this.compactionCancelledThisTurn = true;
        return null;
      }
      summaryProvider = target.provider;
      summaryModel = target.model;
    }

    let summary: string;
    if (opts?.precomputedSummary !== undefined) {
      // A PreCompact hook returned a custom summary — trust it and skip both
      // the model and mechanical fallbacks. This is the only override path.
      summary = opts.precomputedSummary;
    } else {
      // The summary call carries its own framing (a system instruction
      // and a closing user prompt) and reserves output tokens. Subtract
      // those from the context window before checking whether the slice
      // still fits, then apply a small safety multiplier to absorb the
      // ~10–15% undercount the char heuristic exhibits on tool-heavy
      // conversations. Falls through to the mechanical summary when the
      // slice is too large to summarize in a single model call.
      const summarizeTokens = estimateMessagesTokens(toSummarize);
      const summarizeBudget = Math.max(
        0,
        Math.floor(
          (this.contextWindow - SUMMARY_FRAMING_TOKENS - SUMMARY_OUTPUT_RESERVE) *
            SUMMARY_BUDGET_SAFETY,
        ),
      );
      // No headroom (tiny contextWindow or pathological caps): skip LLM — same
      // as an oversized slice would, instead of stuffing the transcript into a
      // request that cannot reserve framing + output tokens.
      const skipLlmCompaction = summarizeBudget <= 0 || summarizeTokens > summarizeBudget;
      if (skipLlmCompaction) {
        summary = this.buildMechanicalSummary(toSummarize);
      } else {
        // Try the chosen compaction target first; mechanical is the fallback
        // when the model call fails (per the source plan: "skip-model-entirely
        // path is overcautious").
        summary =
          (await this.buildModelSummary(summaryProvider, summaryModel, toSummarize, signal)) ??
          this.buildMechanicalSummary(toSummarize);
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
    this.lastPromptTokensFromApi = 0;
    this.refreshEstimate(opts?.toolDefinitions ?? []);
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
      const tokens = estimateSingleMessageTokens(messages[i]!);
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
        _requestSource: 'compaction',
      });
      return response.content ?? null;
    } catch (err: unknown) {
      if (signal?.aborted || (isError(err) && err.name === 'AbortError')) throw err;
      return null;
    }
  }

  private buildMechanicalSummary(messages: SummaryMessage[]): string {
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

interface SummaryToolCall {
  function: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}
type SummaryMessage = { role: string; content: string; tool_calls?: SummaryToolCall[] };

function findLatestUserRequest(messages: SummaryMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
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
    const msg = messages[i]!;
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
