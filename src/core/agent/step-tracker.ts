/**
 * Tracks which required steps have been completed and what arguments
 * every tool call ran with. Lives on the agent run, *outside* the
 * message history — compaction can rewrite the chat log, the
 * step-completion record stays intact (docs/reliability/next-steps.md §3, "Control flow
 * is not memory").
 *
 * StepTracker is intentionally narrow: it answers two questions for
 * StepEnforcer:
 *   1. Has tool X been called successfully yet?
 *   2. Was tool X ever called with `arg=value`?
 *
 * Anything more interpretive (which tools matter, what counts as a
 * "step") lives in StepEnforcer or in caller code.
 */
export class StepTracker {
  /** Set of required step names that have completed at least once.
   *  Insertion order is preserved (used by `pending()` so nudges list
   *  the steps in declaration order, not alphabetical). */
  private readonly completed = new Map<string, true>();

  /** Per-tool execution log. Each entry is the args object the tool
   *  ran with (success — failed calls don't make it here). Used by
   *  the arg-matched prerequisite check ("was Read called with
   *  path=X before this Edit{path=X}?"). */
  private readonly executed = new Map<string, Array<Record<string, unknown>>>();

  constructor(private readonly required: readonly string[]) {}

  /** Record a successful tool call. Increments the per-tool log and,
   *  when `tool` is in the required set, marks the step complete. */
  record(tool: string, args: Record<string, unknown>): void {
    const log = this.executed.get(tool) ?? [];
    log.push(args);
    this.executed.set(tool, log);
    if (this.required.includes(tool)) {
      this.completed.set(tool, true);
    }
  }

  /** Has every required step been recorded at least once? */
  isSatisfied(): boolean {
    return this.required.every(s => this.completed.has(s));
  }

  /** Names of required steps that have not yet completed. Order matches
   *  the original `required` list — readers (StepEnforcer's nudge
   *  formatter) want a stable listing. */
  pending(): string[] {
    return this.required.filter(s => !this.completed.has(s));
  }

  /** Was `tool` ever called (successfully) before? Used by the
   *  name-only prerequisite check. */
  hasCalled(tool: string): boolean {
    const log = this.executed.get(tool);
    return log !== undefined && log.length > 0;
  }

  /** Was `tool` ever called with `args[matchArg] === value`? Used by
   *  the arg-matched prerequisite check. Returns false for missing
   *  args; the goal is "was this exact resource read before?" not "did
   *  some related read happen?" */
  hasCalledWithArg(tool: string, matchArg: string, value: unknown): boolean {
    const log = this.executed.get(tool);
    if (!log) return false;
    return log.some(args => args[matchArg] === value);
  }

  /** Names of every tool that has executed successfully at least once. */
  executedTools(): string[] {
    return [...this.executed.keys()];
  }
}
