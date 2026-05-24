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
import { runTieredCompact, type CompactionPhase } from './tiered-compact.js';
import { AGGRESSIVE_RECENCY, mergeContextConfig, type ContextConfig } from './context-config.js';
import {
  buildMechanicalSummary,
  buildModelSummary,
  defaultWarningTemplate,
  shouldSkipLlmSummary,
} from './context-summary.js';

/** Caller-provided async hook that resolves the (provider, model) used
 *  for the summarization call inside compaction. Returning `null` means
 *  "user declined / not available" — `compact()` will return null
 *  without rewriting the conversation, so the agent continues with
 *  un-compacted history (and likely overflows on the next turn). */
export type CompactionTargetResolver = () => Promise<{
  provider: Provider;
  model: string;
} | null>;

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
    this.config = mergeContextConfig(config);
  }

  /** Per-session record of which thresholds have already fired. The
   *  reliability spec wants at-most-once-per-threshold to avoid
   *  hammering the model with the same warning every turn. Cleared
   *  in-place when usage drops below a threshold so the threshold
   *  becomes re-fireable on the next pressure cycle. */
  private firedThresholds = new Set<number>();

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
    // Re-arm threshold latches whose fraction is now above current
    // usage — necessary so a drop (e.g. after compaction) clears the
    // latch even if `checkThresholds` isn't called at the low point.
    const pct = this.getUsagePercent();
    for (const t of [...this.firedThresholds]) {
      if (pct < t) this.firedThresholds.delete(t);
    }
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

  /** Replace the context window. Providers like ollama can only learn the
   *  model's real `num_ctx` asynchronously (via `/api/show`); the first
   *  ContextManager is constructed with the synchronous estimate, then
   *  `primeModelCache` settles and we call this to install the real value.
   *  The primed value is the model's actual context, so we trust it whether
   *  it's larger or smaller than the estimate (e.g. the user pulled a
   *  smaller-context variant). No-op when `n <= 0` so a failed prime can't
   *  zero out the window. */
  setContextWindow(n: number): void {
    if (n > 0) this.contextWindow = n;
  }

  getContextWindow(): number {
    return this.contextWindow;
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

  /**
   * Reliability stack (Phase 7): mid-conversation context-pressure
   * warning. Returns the first not-yet-fired threshold's message
   * when current usage is above that threshold; null when nothing to
   * say. The caller injects the returned string as a transient
   * `{ role: 'user', content: <warning> }` into the outbound API
   * payload only — it must NOT call `conversation.addUser`.
   *
   * The template wording matches the reliability spec (§11): polite
   * "context filling up" at 65%, terser "context nearly full" at
   * 80%. Wording escalates so the model treats them as distinct
   * pressure stages.
   *
   * `role` is `"user"` rather than `"system"` because the spec
   * documents that Jinja chat templates on llama-server reject
   * mid-conversation system messages — using `"user"` keeps the wire
   * format valid across every backend.
   *
   * Threshold-firing has a one-shot latch per threshold. When usage
   * drops back below a threshold (e.g. after compaction), the latch
   * clears so the threshold becomes re-fireable on the next pressure
   * cycle.
   */
  checkThresholds(): string | null {
    const pct = this.getUsagePercent();
    // Clear fired latches that are no longer above their threshold
    // — usage dropped (likely from compaction); re-arm.
    for (const t of [...this.firedThresholds]) {
      if (pct < t) this.firedThresholds.delete(t);
    }
    // Walk highest-first so an 80% crossing wins over a 65% crossing
    // when both are above. Skip ones already fired.
    const sorted = [...this.config.contextThresholds].sort((a, b) => b - a);
    for (const t of sorted) {
      if (pct >= t && !this.firedThresholds.has(t)) {
        this.firedThresholds.add(t);
        return defaultWarningTemplate(t);
      }
    }
    return null;
  }

  /** Test-only — clear the fired-threshold set so each test starts
   *  clean. Production callers shouldn't need this. */
  _resetThresholdsForTests(): void {
    this.firedThresholds.clear();
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

  /**
   * Run the tiered (deterministic) compaction strategy in place. Escalates
   * through phases 1–3 until usage drops below the soft threshold (or
   * Phase 3 has run and there is nothing more to cut). Skips the LLM
   * summary call entirely; that path stays as the Phase 4 emergency
   * fallback (`compact()`).
   *
   * Returns the phase that fired and the message-count delta. Phase 0
   * means nothing changed (already under budget or nothing eligible);
   * callers should treat that as "no event to emit."
   */
  tieredCompact(toolDefinitions: ToolDefinition[]): {
    phase: 0 | 1 | 2 | 3;
    oldCount: number;
    newCount: number;
    changed: boolean;
  } {
    const stored = this.conversation.getStoredMessages();
    const oldCount = stored.length;
    const result = runTieredCompact({
      messages: stored,
      estimateFraction: msgs => this.estimateFractionFor(msgs, toolDefinitions),
      stopBelow: this.config.compactionThreshold,
    });
    if (result.changed) {
      this.conversation.replaceStoredMessages(result.messages);
      this.lastPromptTokensFromApi = 0;
      this.refreshEstimate(toolDefinitions);
    }
    return {
      phase: result.phase,
      oldCount,
      newCount: result.messages.length,
      changed: result.changed,
    };
  }

  /** Token fraction (vs context window) the supplied message slice would
   *  consume on the wire, including the tool-schema overhead. Used by
   *  the tiered compaction loop to decide whether to escalate.
   *
   *  We intentionally pre-pend a system-shaped placeholder for parity
   *  with the real wire layout — the system prompt's tokens aren't in
   *  `stored`, but they ride on every request and matter for the
   *  budgeting decision. */
  private estimateFractionFor(messages: ChatMessage[], toolDefinitions: ToolDefinition[]): number {
    if (this.contextWindow === 0) return 0;
    const systemTokens = estimateSingleMessageTokens({
      role: 'system',
      content: this.conversation.getSystemPrompt(),
    });
    const bodyTokens = estimateMessagesTokens(messages);
    const toolsTokens = estimateToolDefinitionsTokens(toolDefinitions);
    return (systemTokens + bodyTokens + toolsTokens) / this.contextWindow;
  }

  /** Surface the latest phase value to consumers (currently the agent
   *  loop's `compaction-phase` event). Returned from `tieredCompact()`
   *  but also exposed via `getLastCompactionPhase()` so observability
   *  surfaces that don't see the return value can still pick it up. */
  private lastPhase: CompactionPhase = 0;
  setLastCompactionPhase(phase: CompactionPhase): void {
    this.lastPhase = phase;
  }
  getLastCompactionPhase(): CompactionPhase {
    return this.lastPhase;
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
    } else if (shouldSkipLlmSummary(toSummarize, this.contextWindow)) {
      // Slice is too large to summarize in a single model call (or there
      // isn't enough headroom for framing + reserved output). Fall back
      // to the mechanical summary.
      summary = buildMechanicalSummary(toSummarize);
    } else {
      // Try the chosen compaction target first; mechanical is the fallback
      // when the model call fails (per the source plan: "skip-model-entirely
      // path is overcautious").
      summary =
        (await buildModelSummary(summaryProvider, summaryModel, toSummarize, signal)) ??
        buildMechanicalSummary(toSummarize);
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
}
