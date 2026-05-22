/**
 * Tool prerequisite declaration (next-steps.md §8). Either:
 *   - A bare tool name — the prereq is satisfied if that tool has been
 *     called successfully at least once this run, regardless of args.
 *   - `{ tool, matchArg }` — the prereq is satisfied if that tool was
 *     called with `args[matchArg]` equal to the attempting call's
 *     `args[matchArg]`. Used for "must Read this exact path before
 *     Editing it" guarantees.
 *
 * Prereqs are NOT surfaced in the tool schema sent to the model —
 * adding them is noise the model routinely ignores. The model
 * discovers them via the nudge-on-violation path, which is loud and
 * corrective.
 */
export type ToolPrerequisite = string | { tool: string; matchArg: string };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  /** Optional prerequisite list. When set, the step enforcer (Phase 5)
   *  blocks the call before execution if any prerequisite isn't met
   *  and issues a `prerequisite_nudge`. Validated at registry-build
   *  time — every referenced tool name must be registered, or
   *  construction throws. */
  prerequisites?: ToolPrerequisite[];
}
