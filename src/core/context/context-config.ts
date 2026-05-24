/** Tunable knobs for {@link ContextManager}. Exposed as an interface
 *  rather than a class so the defaults stay declarative — see
 *  {@link DEFAULT_CONFIG} below. Callers pass a `Partial<ContextConfig>`
 *  through the `ContextManager` constructor; missing fields fall back to
 *  the defaults via explicit `??` so an explicit `undefined` doesn't
 *  clobber them (object spread copies undefined verbatim). */
export interface ContextConfig {
  compactionThreshold: number; // 0-1, fraction of context window (default 0.75)
  recencyWindow: number; // floor on messages to keep during compaction (default 6)
  /** Soft token budget for the recency window. The actual count of kept
   * messages is whichever is larger — `recencyWindow` (count floor) or as
   * many trailing messages as fit under `recencyTokens`. Default 4000. */
  recencyTokens: number;
  /** Tool results from turns older than this are eligible for aging via
   * `ageOldToolResults`. Default 6. */
  toolResultAgingTurns: number;
  /** Mid-conversation pressure-signal thresholds. Each value is a
   *  fraction of `contextWindow`; when crossed, `checkThresholds()`
   *  returns a warning string that the agent loop injects into the
   *  outbound API payload only — never persisted. Each threshold
   *  fires *at most once per session* (tracked in `_firedThresholds`).
   *  If usage drops below a threshold after compaction, that
   *  threshold becomes re-fireable. Default `[0.65, 0.80]`. */
  contextThresholds: readonly number[];
}

const DEFAULT_CONFIG: ContextConfig = {
  compactionThreshold: 0.75,
  recencyWindow: 6,
  recencyTokens: 4000,
  toolResultAgingTurns: 6,
  contextThresholds: [0.65, 0.8],
};

// Aggressive mode used to drop the recency window entirely. That nuked the
// active task — the conversation post-compaction looked like a fresh start
// even when the user was mid-thread. Keep two messages so the latest
// user/assistant exchange survives.
export const AGGRESSIVE_RECENCY = 2;

/** Merge a partial config over the defaults using explicit `??` per field.
 *  Required (vs. spread) so callers passing `{ compactionThreshold: undefined }`
 *  don't end up with `undefined` overriding the default. */
export function mergeContextConfig(partial?: Partial<ContextConfig>): ContextConfig {
  return {
    compactionThreshold: partial?.compactionThreshold ?? DEFAULT_CONFIG.compactionThreshold,
    recencyWindow: partial?.recencyWindow ?? DEFAULT_CONFIG.recencyWindow,
    recencyTokens: partial?.recencyTokens ?? DEFAULT_CONFIG.recencyTokens,
    toolResultAgingTurns: partial?.toolResultAgingTurns ?? DEFAULT_CONFIG.toolResultAgingTurns,
    contextThresholds: partial?.contextThresholds ?? DEFAULT_CONFIG.contextThresholds,
  };
}
