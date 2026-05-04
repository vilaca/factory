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
  /** Set by Bash when the command changed the working directory. The agent
   * loop reads this and updates the session's refs.cwd so the new directory
   * persists across subsequent tool calls. */
  cwdAfter?: string;
}

/** Per-call context that an agent loop passes when executing a tool.
 *
 * Optional so that headless / test callers can keep using the bare
 * `execute(args)` form. When omitted, tools fall back to process-global
 * defaults (e.g. `process.cwd()`).
 */
export interface ToolContext {
  /** Working directory the tool should resolve relative paths against and
   * spawn shells with. Per-tab in the Ink UI; defaults to process.cwd()
   * elsewhere. */
  cwd: string;
}

export interface ToolHandler {
  name: string;
  description: string;
  category: ToolCategory;
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult>;
}
