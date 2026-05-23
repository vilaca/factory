import { ToolRegistry } from './registry.js';

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
