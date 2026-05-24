/**
 * Wire-level tool definition sent to LLM providers.
 *
 * Lives in `utils/` (not `tools/`) because both `providers/` and
 * `tools/` import it and the arch test in
 * `test/unit/arch/modularity.test.ts` forbids providers from depending
 * on tools. The tool-author contract — `ToolHandler`, `ToolResult`,
 * `ToolContext`, `ToolCategory`, `TOOL_NAMES`, `ToolPrerequisite` —
 * lives in `src/tools/types.ts` (which re-exports `ToolDefinition`
 * and `ToolPrerequisite` from here) and is the file new tools should
 * import from.
 */

/**
 * Tool prerequisite declaration (docs/reliability/next-steps.md §8). Either:
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
 *
 * Defined here (rather than in `src/tools/types.ts`) so the
 * `ToolDefinition.prerequisites` field can be typed without forcing
 * `utils/` to depend on `tools/`. The canonical re-export for tool
 * authors lives in `src/tools/types.ts`.
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
