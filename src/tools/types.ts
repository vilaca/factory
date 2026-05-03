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
}

export interface ToolHandler {
  name: string;
  description: string;
  category: ToolCategory;
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}
