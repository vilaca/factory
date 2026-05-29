import type { Provider } from '../../providers/types.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { TOOL_NAMES } from '../../tools/types.js';
import type { AgentEvent } from '../agent/types.js';
import { Conversation } from '../context/conversation.js';
import { PermissionManager } from '../../security/permissions.js';
import { runAgent } from '../agent/run-agent.js';

/**
 * The subagent's system prompt. Deliberately terse — the parent's task
 * description is what guides the work; the system prompt only sets the
 * *contract* (read-only, return findings as plain text).
 */
export const SUBAGENT_SYSTEM_PROMPT = `You are a read-only research subagent. Investigate and return findings as a single text response. Do not write, edit, or modify files. When you have an answer, stop and emit it as plain text.

Available tools: Read, Glob, Grep, Bash (allow-listed read-only commands only).

Stop as soon as you have an answer. Do not chain calls past what the question requires.`;

interface SubagentResult {
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
 *  Broad codebase investigations (multi-file reads, cross-repo searches)
 *  routinely need 30-50 tool calls; the previous cap of 30 fired too often,
 *  forcing truncated answers and costly re-delegations. 80 gives comfortable
 *  headroom for real tasks while still bounding runaway loops. */
const SUBAGENT_TOOL_CALL_LIMIT = 80;

interface SubagentRunOptions {
  provider: Provider;
  model: string;
  task: string;
  signal?: AbortSignal;
  /** Override the tool-call ceiling for this run. Mostly for tests. */
  toolCallLimit?: number;
  /** The registry of tools available to the subagent. Callers must provide
   *  this — use buildSubagentRegistry() from src/tools/index.ts for the
   *  standard read-only set (Read, Glob, Grep, allow-listed Bash). */
  registry: ToolRegistry;
  /** Allows tests to inject a runner. Production code uses the default. */
  runner?: typeof runAgent;
}

/**
 * Spawn one round-trip with the subagent. Returns the final assistant text
 * (which is what the Delegate tool surfaces to the parent agent) along with
 * the raw event stream for logging.
 */
export async function runSubagent(options: SubagentRunOptions): Promise<SubagentResult> {
  const registry = options.registry;
  const runner = options.runner ?? runAgent;

  const conversation = new Conversation(SUBAGENT_SYSTEM_PROMPT);
  // Subagent runs with a fresh permission manager, all four tools auto-
  // allowed. There is no human in the loop to answer prompts; the safety
  // story is the restricted registry + Bash allow-list, not interactive
  // gating.
  const permissions = new PermissionManager();
  permissions.allowAll(TOOL_NAMES.Read);
  permissions.allowAll(TOOL_NAMES.Glob);
  permissions.allowAll(TOOL_NAMES.Grep);
  permissions.allowAll(TOOL_NAMES.Bash);

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
