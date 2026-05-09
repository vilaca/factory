import type { PathPolicy } from '../security/paths.js';
import type { EnvPolicy } from '../security/env.js';

/**
 * Canonical names for every built-in tool. String literals were sprinkled
 * across security checks, the text-tool parser, system prompts, the agent
 * loop, and permission gates — a typo at any of those sites silently broke
 * behavior (no match, fallthrough). Routing call sites through this const
 * makes typos a compile error and gives `grep TOOL_NAMES.X` exhaustive
 * coverage when reasoning about a tool's wiring.
 */
export const TOOL_NAMES = {
  Bash: 'Bash',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  Grep: 'Grep',
  Glob: 'Glob',
  WebFetch: 'WebFetch',
  Delegate: 'Delegate',
} as const;

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolCategory = 'read-only' | 'write' | 'execute';

export interface ToolResult {
  success: boolean;
  output: string;
  /** Optional shortened version for terminal display. The full `output` always goes to the model. */
  displayOutput?: string;
  /** True when the call ran cleanly but produced no useful result (e.g. Grep
   * with zero matches). The renderer surfaces these distinctly so they don't
   * look identical to a successful "found something" call. */
  empty?: boolean;
  /** Set when success=true but the body still needs to reach the user — the
   * `experimental.toolPreview` gate treats this as not-noise so the body is
   * rendered. Bash sets it for non-zero exit codes: the tool ran cleanly
   * (so success stays true and auto-retry doesn't fire on every failing
   * test) but the user needs to see the exit code and output. */
  important?: boolean;
  /** Set by Bash when the command changed the working directory. The agent
   * loop reads this and updates the session's refs.cwd so the new directory
   * persists across subsequent tool calls. */
  cwdAfter?: string;
  /** Set on a `success=false` result when the error is a *reasoning hint* for
   * the model rather than a malformed-call problem the corrector can fix.
   * Example: Edit's "old_string found N times — must be unique" already tells
   * the model exactly what to do (add disambiguating context); routing it
   * through the corrector just produces a fabricated retry against an 8000-
   * char file slice. The agent loop checks this flag and skips the corrector
   * when true. */
  skipCorrector?: boolean;
}

/** Per-call context that an agent loop passes when executing a tool.
 *
 * Optional so that headless / test callers can keep using the bare
 * `execute(args)` form. When omitted, tools fall back to process-global
 * defaults (e.g. `process.cwd()` and an empty path/env policy).
 */
export interface ToolContext {
  /** Working directory the tool should resolve relative paths against and
   * spawn shells with. Per-tab in the Ink UI; defaults to process.cwd()
   * elsewhere. */
  cwd: string;
  /** Path-policy deny extensions for this tool call. Read-only; tools must
   * not mutate. The agent loop builds this once per turn from config and
   * passes the same object to every tool. When undefined, tools treat as
   * `{}` (built-in deny list still applies). */
  pathPolicy?: PathPolicy;
  /** Env-policy allow extensions used by Bash to scrub the spawned shell's
   * environment. Same plumbing rules as pathPolicy. */
  envPolicy?: EnvPolicy;
  /** Per-turn abort signal. When fired, tools should cancel in-flight I/O
   * (`fs.readFile({signal})`, `fetch({signal})`, `child_process.spawn`'s
   * AbortController) so an aborted turn doesn't wait out a multi-MB read.
   * Optional — older callers and tests can omit it. */
  signal?: AbortSignal;
  /** WebFetch: probe for the per-session domain allowlist. Lets the tool
   * re-apply the same gate the permission prompt used when validating a
   * redirect target. Hostnames are compared case-insensitively (callers
   * lowercase before passing). */
  isHostnameAllowed?: (hostname: string) => boolean;
}

export interface ToolHandler {
  name: string;
  description: string;
  category: ToolCategory;
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult>;
}
