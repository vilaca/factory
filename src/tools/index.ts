import type { BashToolHandler, BashToolResult, ToolContext } from './types.js';
import { ToolRegistry } from './registry.js';
import { readTool } from './read.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { bashTool } from './bash.js';
import { isCommandAllowed } from './bash-allowlist.js';

/**
 * Pre-built registry with all built-in tools — kept ONLY as a convenience
 * for unit tests that want a fully-populated registry without going
 * through the CLI startup path. Production code MUST NOT import this:
 * it constructs its own `new ToolRegistry()` in `src/index.ts`, registers
 * MCP and subagent tools into it, and threads the instance through
 * `appOptions.toolRegistry`. The ArchUnit rule in
 * `test/unit/arch/modularity.test.ts` enforces "production code outside
 * this file does not import defaultRegistry."
 *
 * Rationale: a process-global mutable registry forecloses on multi-
 * session daemons / parallel subagents / dynamic tool plug-in&plug-out
 * — three features that may want different tool sets per call site.
 *
 * @deprecated for production; tests only.
 */
export const defaultRegistry = new ToolRegistry();

/**
 * Wraps the real Bash tool with the subagent allow-list. Anything outside the
 * allow-list is rejected before `spawn` is ever called — we never delegate
 * the trust decision to the prompt.
 */
function makeRestrictedBashTool(): BashToolHandler {
  return {
    kind: 'bash',
    name: bashTool.name,
    description:
      bashTool.description +
      ' (Subagent: only read-only allow-listed commands run; others are rejected.)',
    category: bashTool.category,
    definition: bashTool.definition,
    async execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<BashToolResult> {
      const command = typeof args.command === 'string' ? args.command : '';
      const decision = isCommandAllowed(command);
      if (!decision.allowed) {
        return {
          success: false,
          output: `Subagent Bash rejected: ${decision.reason}. Use Read/Glob/Grep, or one of the allow-listed shell commands.`,
        };
      }
      return bashTool.execute(args, ctx);
    },
  };
}

/**
 * Builds a fresh registry containing only the read-only tools plus a
 * hardened Bash. Edit/Write are intentionally absent — the subagent has
 * literally no way to call them, regardless of what its prompt says.
 */
export function buildSubagentRegistry(): ToolRegistry {
  const registry = new ToolRegistry({ empty: true });
  registry.register(readTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(makeRestrictedBashTool());
  return registry;
}
