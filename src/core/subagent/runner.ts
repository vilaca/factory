import type { Provider } from '../../providers/types.js';
import type { ToolHandler, ToolResult } from '../../tools/types.js';
import type { AgentEvent } from '../agent-types.js';
import { ToolRegistry } from '../../tools/registry.js';
import { readTool } from '../../tools/read.js';
import { globTool } from '../../tools/glob.js';
import { grepTool } from '../../tools/grep.js';
import { bashTool } from '../../tools/bash.js';
import { Conversation } from '../conversation.js';
import { PermissionManager } from '../../permissions.js';
import { runAgent } from '../agent.js';
import { isCommandAllowed } from './bash-allowlist.js';

/**
 * The subagent's system prompt. Deliberately terse — the parent's task
 * description is what guides the work; the system prompt only sets the
 * *contract* (read-only, return findings as plain text).
 */
export const SUBAGENT_SYSTEM_PROMPT = `You are a read-only research subagent. Investigate and return findings as a single text response. Do not write, edit, or modify files. When you have an answer, stop and emit it as plain text.

Available tools: Read, Glob, Grep, Bash (allow-listed read-only commands only).

Stop as soon as you have an answer. Do not chain calls past what the question requires.`;

/**
 * Wraps the real Bash tool with the subagent allow-list. Anything outside the
 * allow-list is rejected before `spawn` is ever called — we never delegate
 * the trust decision to the prompt.
 */
function makeRestrictedBashTool(): ToolHandler {
  return {
    name: bashTool.name,
    description:
      bashTool.description +
      ' (Subagent: only read-only allow-listed commands run; others are rejected.)',
    category: bashTool.category,
    definition: bashTool.definition,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const command = typeof args.command === 'string' ? args.command : '';
      const decision = isCommandAllowed(command);
      if (!decision.allowed) {
        return {
          success: false,
          output: `Subagent Bash rejected: ${decision.reason}. Use Read/Glob/Grep, or one of the allow-listed shell commands.`,
        };
      }
      return bashTool.execute(args);
    },
  };
}

/**
 * Builds a fresh registry containing only the read-only tools plus a
 * hardened Bash. Edit/Write are intentionally absent — the subagent has
 * literally no way to call them, regardless of what its prompt says.
 */
export function buildSubagentRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  // Drop everything the default constructor added; we want an explicit
  // allow-list, not a deny-list.
  for (const tool of registry.getAll()) {
    registry.unregister(tool.name);
  }
  registry.register(readTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(makeRestrictedBashTool());
  return registry;
}

export interface SubagentResult {
  /** The final assistant text the subagent produced before stopping. */
  finalText: string;
  /** Number of turns the subagent actually used. */
  turnsUsed: number;
  /** Why the subagent stopped (completed, turn-limit, error, user-abort). */
  stopReason: string;
  /** Every event the subagent emitted, in order — caller (Delegate tool)
   *  pipes these into the parent session log under a nested key. Tests rely
   *  on this for assertions; the parent TTY does not show them. */
  events: AgentEvent[];
}

/** Hard ceiling on the number of tool calls a single Delegate run may make.
 *  The agent loop on main has no built-in maxTurns; without an external cap
 *  a chatty model could investigate forever in a default-on configuration.
 *  30 is well above the typical 3–8 read-only tool calls a real
 *  investigation needs, while still bounding the worst case. */
export const SUBAGENT_TOOL_CALL_LIMIT = 30;

export interface SubagentRunOptions {
  provider: Provider;
  model: string;
  task: string;
  signal?: AbortSignal;
  /** Override the tool-call ceiling for this run. Mostly for tests. */
  toolCallLimit?: number;
  /** Allows tests to inject a registry / runner pair. Production code uses
   *  the defaults. */
  registry?: ToolRegistry;
  runner?: typeof runAgent;
}

/**
 * Spawn one round-trip with the subagent. Returns the final assistant text
 * (which is what the Delegate tool surfaces to the parent agent) along with
 * the raw event stream for logging.
 */
export async function runSubagent(
  options: SubagentRunOptions,
): Promise<SubagentResult> {
  const registry = options.registry ?? buildSubagentRegistry();
  const runner = options.runner ?? runAgent;

  const conversation = new Conversation(SUBAGENT_SYSTEM_PROMPT);
  // Subagent runs with a fresh permission manager, all four tools auto-
  // allowed. There is no human in the loop to answer prompts; the safety
  // story is the restricted registry + Bash allow-list, not interactive
  // gating.
  const permissions = new PermissionManager();
  permissions.allowAll('Read');
  permissions.allowAll('Glob');
  permissions.allowAll('Grep');
  permissions.allowAll('Bash');

  const events: AgentEvent[] = [];
  let lastAssistantText = '';
  let turnsUsed = 0;
  let stopReason = 'completed';

  // Tool-call budget enforcement. The agent loop dropped its built-in
  // maxTurns; we cap the subagent externally by counting tool-call-start
  // events and aborting the chained signal once the budget is spent. The
  // model's next turn-boundary signal check then yields user-abort, which
  // we relabel as turn-limit so callers can distinguish "ran over budget"
  // from "user pressed Esc".
  const limit = options.toolCallLimit ?? SUBAGENT_TOOL_CALL_LIMIT;
  const capController = new AbortController();
  const onParentAbort = (): void => capController.abort();
  if (options.signal) {
    if (options.signal.aborted) capController.abort();
    else options.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  let toolCallsSeen = 0;
  let hitCap = false;

  const stream = runner(options.task, {
    provider: options.provider,
    model: options.model,
    conversation,
    permissions,
    toolRegistry: registry,
    signal: capController.signal,
  });

  try {
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'text-done' && event.fullContent) {
        lastAssistantText = event.fullContent;
      }
      if (event.type === 'tool-call-start') {
        toolCallsSeen++;
        if (toolCallsSeen >= limit && !options.signal?.aborted) {
          hitCap = true;
          capController.abort();
        }
      }
      if (event.type === 'turn-complete') {
        turnsUsed = event.turnsUsed;
        stopReason = event.stopReason;
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', onParentAbort);
  }

  if (hitCap) stopReason = 'turn-limit';

  return {
    finalText: lastAssistantText,
    turnsUsed,
    stopReason,
    events,
  };
}
