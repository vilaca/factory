import type { Provider } from '../providers/types.js';
import type { ToolDefinition, ToolHandler, ToolResult } from './types.js';
import { runSubagent } from '../core/subagent/runner.js';
import type { SessionLogger } from '../core/session-log.js';

/*
 * Future improvements (not blocking this branch's merge):
 *
 * 1. Stream subagent events to the parent UI as they happen.
 *    Today the tool is silent until the subagent's final answer; the
 *    runner already collects every AgentEvent in `result.events`. Surface
 *    them to the parent's display layer (a dimmed "🤖 subagent: Read
 *    foo.ts → 142 lines" line per event) so the user can watch progress
 *    instead of staring at a Running… spinner. The parent runs single-
 *    threaded, so this is purely a yield-vs-buffer change in the runner
 *    and a new display-item kind in the Ink layer. No new architecture.
 *
 * 2. Long-running named workers via tabs.
 *    Pair the one-shot Delegate with a `SpawnTab` (or similar) tool that
 *    opens a new factory tab pinned to a (provider, model, key) and an
 *    `AskTab(id, prompt)` tool to address it across many turns. Reuses
 *    the existing multi-tab + multi-key infrastructure: a "worker" is
 *    just another tab that the model can talk to instead of (or in
 *    addition to) the human. Stays single-process, single-Ink-tree.
 *    Bigger feature — propose only after (1) lands and we have lived
 *    with the read-only single-shot model for a bit.
 */

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'Delegate',
    description:
      'Spawn a read-only research subagent for an isolated investigation. The subagent has access to Read, Glob, Grep, and an allow-listed Bash; it CANNOT edit, write, or run state-changing commands. Use to farm out exploration without polluting your own context. Returns the subagent\'s final answer as plain text.',
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description:
            'The research/investigation task description for the subagent. Be specific about what you want it to find and what shape the answer should take.',
        },
        model: {
          type: 'string',
          description:
            'Optional override for the subagent model. Defaults to the parent\'s weak-tier model if registered, otherwise the parent\'s current model.',
        },
      },
    },
  },
};

export interface DelegateContext {
  provider: Provider;
  /** The parent's currently-selected model. */
  parentModel: string;
  /** The provider's "weak" tier model name, if the host has chosen to
   *  register one. We fall back to parentModel when this is undefined. */
  weakModel?: string;
  /** When provided, every subagent event is appended to the parent session
   *  log under a nested `subagent` key. */
  sessionLogger?: SessionLogger;
  /** Wired in tests; production code leaves this undefined. */
  signal?: AbortSignal;
}

/**
 * Build a Delegate tool bound to a specific parent context. The factory
 * pattern keeps the tool-handler signature pure (args → result) while still
 * letting us inject the parent's provider and model selection.
 */
export function createDelegateTool(ctx: DelegateContext): ToolHandler {
  async function execute(args: Record<string, unknown>): Promise<ToolResult> {
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (!task) {
      return { success: false, output: 'Delegate: "task" is required and must be a non-empty string.' };
    }
    const explicitModel = typeof args.model === 'string' && args.model.trim()
      ? args.model.trim()
      : undefined;
    const subagentModel = explicitModel ?? ctx.weakModel ?? ctx.parentModel;

    try {
      const result = await runSubagent({
        provider: ctx.provider,
        model: subagentModel,
        task,
        signal: ctx.signal,
      });

      // Mirror the subagent's full event stream into the parent session log
      // under a nested key. The parent TTY never sees these directly — they
      // are only for forensic analysis later. We use logWarning with a
      // distinct source so the existing schema doesn't need to change.
      // TODO: subagent events are not actually being logged. `ctx.sessionLogger`
      // is declared on the tool context interface but no caller threads it
      // through — the agent loop builds tool ctx without a sessionLogger,
      // so the `if (ctx.sessionLogger)` guard is always false and this whole
      // block is dead code. Fix: wire sessionLogger from RunRefs (or from
      // run-loop.ts deps) into the ToolContext built in run-tool-calls.ts so
      // forensic logs of delegate runs actually land in the .jsonl session
      // log alongside the rest of the agent events.
      if (ctx.sessionLogger) {
        for (const event of result.events) {
          try {
            ctx.sessionLogger.logWarning(
              'subagent',
              JSON.stringify({ event }),
            );
          } catch {
            // Logging failures must never propagate into the tool result.
          }
        }
      }

      const text = result.finalText.trim();
      if (!text) {
        // The subagent aborted before emitting a final text response.
        return {
          success: false,
          output: `Delegate: subagent stopped (${result.stopReason}, ${result.turnsUsed} turns) without producing a final answer.`,
        };
      }
      // Cap fired mid-investigation. Treat as a failure rather than a success
      // with a note: the answer above is partial and the parent typically
      // re-delegates or redoes the work directly. Marking this as success=true
      // hid the cap note from any UI that gates successful tool results, so
      // users couldn't tell whether the parent's "let me try a different
      // approach" was a model whim or a forced retry.
      // TODO: subagents hit this cap too often in practice. Investigate:
      //   - is the default cap too low for the kinds of tasks parents
      //     delegate (broad codebase searches, multi-file reads)?
      //   - are subagents looping on retryable failures and burning the
      //     budget on near-duplicate tool calls (loop detector applies)?
      //   - should the cap be task-shape-aware (more for "find X across
      //     repo", less for "read this one file and summarize")?
      // Until fixed, parents see truncated answers and re-delegate, which
      // doubles cost and latency.
      if (result.stopReason === 'turn-limit') {
        return {
          success: false,
          output: text + '\n\n[note: subagent hit its tool-call cap; the answer above is its last partial response]',
        };
      }
      return { success: true, output: text };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Delegate: subagent failed: ${msg}` };
    }
  }

  return {
    name: 'Delegate',
    description: definition.function.description,
    category: 'read-only',
    definition,
    execute,
  };
}
