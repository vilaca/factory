import type { ToolCallMessage } from '../../../providers/types.js';
import type { AgentEvent } from '../types.js';
import { TOOL_NAMES } from '../../../tools/types.js';
import { formatToolResultMessage } from './tool-result-format.js';
import { correctToolCall, readFileForCorrector } from './tool-call-corrector.js';
import { selectWeakTier } from '../call-model/weak-tier.js';
import type { RecoveryState } from '../recovery-state.js';
import { runHook } from '../../hooks/index.js';
import { errorMessage, makeAbortError } from '../../../utils/errors.js';
import { tryReadCacheHit, maintainFileCache } from './run-tool-calls-cache.js';
import { executeToolCall } from './run-tool-calls-execute.js';
import { mergeAsyncGenerators } from './merge-async-generators.js';
import { AsyncMutex } from './async-mutex.js';
import type { ToolLoopContext } from './types.js';

export type { ToolLoopContext };

interface ToolLoopResult {
  deniedCount: number;
}

/**
 * Run every tool call this turn produced. For each one:
 *  - execute (gating on permissions, queueing in plan mode)
 *  - on failure, optionally invoke the LLM corrector once per (name, args)
 *    signature and run the corrected call
 *
 * Updates `recovery` with cross-turn failure state. Yields all per-call events
 * (start, permission-request, result, denied, corrected, corrector-aborted).
 *
 * Aborts mid-loop are surfaced by throwing an AbortError; the orchestrator's
 * outer catch decides how to halt.
 */
export async function* runToolCalls(
  toolCalls: ToolCallMessage[],
  ctx: ToolLoopContext,
  callSignature: string,
  recovery: RecoveryState,
): AsyncGenerator<AgentEvent, ToolLoopResult> {
  let deniedCount = 0;

  // Sequential by default, with one carve-out for Delegate batches (below).
  //
  // Sequential is load-bearing for every other tool: Bash can mutate
  // ctx.cwdRef.current via cwdAfter (so a `cd` in one call is visible to the
  // next), and the read-cache short-circuit assumes earlier Read results are
  // already committed to ctx.fileCache. A future refactor that parallelizes
  // those tools must first redesign cwd propagation (probably: each Bash
  // call gets a snapshot of cwd, the last-completed cwdAfter wins — but
  // "last" isn't well-defined under parallel execution, so this needs
  // explicit policy).
  //
  // Delegate is exempt: it's read-only, never touches cwdRef or fileCache,
  // and each subagent has its own Conversation. When the model emits
  // multiple Delegate calls in one turn, we run them concurrently — see
  // `runDelegateBatch` below.
  let i = 0;
  while (i < toolCalls.length) {
    if (ctx.signal?.aborted) throw makeAbortError();

    const batchEnd = findDelegateBatchEnd(toolCalls, i);
    if (batchEnd > i + 1) {
      const batch = toolCalls.slice(i, batchEnd);
      const { deniedCount: batchDenied } = yield* runDelegateBatch(
        batch,
        ctx,
        recovery,
        callSignature,
      );
      deniedCount += batchDenied;
      i = batchEnd;
      continue;
    }

    const toolCall = toolCalls[i]!;
    i++;
    deniedCount += yield* runSingleToolCall(toolCall, ctx, recovery, callSignature);
  }

  return { deniedCount };
}

/** Walk forward from `start` while the run consists of Delegate calls.
 *  Returns the exclusive end index of the contiguous Delegate run. */
function findDelegateBatchEnd(toolCalls: ToolCallMessage[], start: number): number {
  let j = start;
  while (j < toolCalls.length && toolCalls[j]?.function?.name === TOOL_NAMES.Delegate) {
    j++;
  }
  return j;
}

/** Run a contiguous batch of Delegate calls concurrently.
 *
 *  Each call gets its own pipeline (PreToolUse → execute → PostToolUse →
 *  corrector) as an independent async generator; `mergeAsyncGenerators`
 *  interleaves their events in completion order. The host (UI / test
 *  driver) sees permission-request events as they happen and responds to
 *  each independently — there's no shared prompt slot, only the renderer's
 *  policy on how to display concurrent prompts.
 *
 *  Recovery state is touched by every call's `executeAndTrack`. Under
 *  parallel execution "the last failure wins" is no longer well-defined,
 *  but recovery only feeds the corrector and the consecutive-same-failure
 *  detector — neither cares about strict ordering across siblings in the
 *  same turn, since they only fire on cross-turn repetition. Per-call
 *  corrector still runs at the end of each pipeline as before. */
async function* runDelegateBatch(
  batch: ToolCallMessage[],
  ctx: ToolLoopContext,
  recovery: RecoveryState,
  callSignature: string,
): AsyncGenerator<AgentEvent, { deniedCount: number }> {
  // Share one mutex across every pipeline in the batch. executeToolCall
  // reads ctx.permissionMutex and gates its permission-request yield
  // behind it, so prompts surface to the host one at a time even though
  // each pipeline's execute() can run concurrently. The mutex stays local
  // to this batch — no cross-batch contention.
  const batchCtx: ToolLoopContext = { ...ctx, permissionMutex: new AsyncMutex() };
  const pipelines = batch.map(toolCall =>
    runSingleToolCall(toolCall, batchCtx, recovery, callSignature),
  );
  const perCallDenied = yield* mergeAsyncGenerators(pipelines);
  return { deniedCount: perCallDenied.reduce((a, b) => a + b, 0) };
}

/** One tool call's full pipeline: optional read-cache short-circuit,
 *  PreToolUse hook (may veto), execute, PostToolUse hook + bash-dedup
 *  nudge, then the corrector on failure. Returns the call's contribution
 *  to the running denial total — used by the sequential loop and by the
 *  parallel Delegate batch driver. */
async function* runSingleToolCall(
  toolCall: ToolCallMessage,
  ctx: ToolLoopContext,
  recovery: RecoveryState,
  callSignature: string,
): AsyncGenerator<AgentEvent, number> {
  if (ctx.fileCache && toolCall.function?.name === TOOL_NAMES.Read) {
    const synthetic = yield* tryReadCacheHit(toolCall, ctx);
    if (synthetic) return 0;
  }

  const { vetoed } = yield* runPreToolUseHook(toolCall, ctx);
  if (vetoed) return 1;

  let deniedDelta = 0;
  const tracking = yield* executeAndTrack(toolCall, ctx, recovery, callSignature);
  deniedDelta += tracking.deniedCount;

  yield* runPostToolUseHook(toolCall, ctx, tracking.lastResultForPostHook);
  yield* maybeBashDedupNudge(toolCall, ctx);

  if (tracking.lastFailedResult) {
    const { deniedDelta: corrDenied } = yield* runCorrectorIfNeeded(
      { toolCall, lastFailedResult: tracking.lastFailedResult, callSignature },
      ctx,
      recovery,
    );
    deniedDelta += corrDenied;
  }

  return deniedDelta;
}

interface ExecutionTracking {
  deniedCount: number;
  lastFailedResult: { toolName: string; output: string; skipCorrector?: boolean } | null;
  lastResultForPostHook: { success: boolean; output: string } | null;
}

/** Drive `executeToolCall` to completion, forwarding every event and tracking
 *  the per-call state the outer loop needs after execute returns: denial
 *  count for the loop's running total, the failed-result handle that gates
 *  the corrector, and the result envelope the post-hook needs. Recovery
 *  bookkeeping and fileCache maintenance happen here so the outer loop body
 *  stays linear. */
async function* executeAndTrack(
  toolCall: ToolCallMessage,
  ctx: ToolLoopContext,
  recovery: RecoveryState,
  callSignature: string,
): AsyncGenerator<AgentEvent, ExecutionTracking> {
  const tracking: ExecutionTracking = {
    deniedCount: 0,
    lastFailedResult: null,
    lastResultForPostHook: null,
  };
  for await (const event of executeToolCall(toolCall, ctx)) {
    if (event.type === 'tool-call-denied') tracking.deniedCount++;
    if (event.type === 'tool-call-result') {
      tracking.lastResultForPostHook = {
        success: event.result.success,
        output: event.result.output,
      };
      applyResultToRecovery(event, recovery, callSignature);
      if (event.result.success) {
        tracking.lastFailedResult = null;
        // Update or invalidate the file cache after successful Read/Edit/Write.
        if (ctx.fileCache) await maintainFileCache(toolCall, ctx.fileCache);
      } else {
        tracking.lastFailedResult = {
          toolName: event.toolName,
          output: event.result.output,
          skipCorrector: event.result.skipCorrector,
        };
      }
    }
    yield event;
  }
  return tracking;
}

/** Mutate `recovery` in response to a tool-call-result event. Used by both
 *  the top-level loop and the corrector's re-execution loop, so success/fail
 *  bookkeeping stays in one place. Per-call concerns (lastFailedResult,
 *  maintainFileCache) stay in the caller. */
function applyResultToRecovery(
  event: Extract<AgentEvent, { type: 'tool-call-result' }>,
  recovery: RecoveryState,
  callSignature: string,
): void {
  if (event.result.success) {
    recovery.lastFailureMessage = null;
    recovery.lastFailureSignature = null;
    recovery.consecutiveSameFailures = 0;
  } else {
    recovery.lastFailureMessage = `${event.toolName}: ${event.result.output}`;
    recovery.lastFailureSignature = callSignature;
  }
}

/** PreToolUse hook — can veto the tool call. Hooks see the tool name and
 *  arguments and can return `{ cancel: true, errorMessage }`. Vetoes surface
 *  to the model as a denial so the agent can react and try something else,
 *  the same way a user-denial does. Returns `vetoed: true` when the caller
 *  should skip execute and increment deniedCount. */
async function* runPreToolUseHook(
  toolCall: ToolCallMessage,
  ctx: ToolLoopContext,
): AsyncGenerator<AgentEvent, { vetoed: boolean }> {
  if (!ctx.hooksEnabled) return { vetoed: false };
  const fnName = toolCall.function?.name ?? '';
  const fnArgs = toolCall.function?.arguments ?? {};
  // Resolve cwd at fire time, not at agent-loop start, so a hook fired after
  // Bash `cd`'d earlier this turn picks up the project-local
  // .factory/hooks/ at the new directory.
  const cwd = ctx.cwdRef?.current ?? process.cwd();
  try {
    const result = await runHook(
      'PreToolUse',
      { toolName: fnName, args: fnArgs },
      {
        cwd,
        config: ctx.hooksConfig,
        envPolicy: ctx.envPolicy,
        matchValue: fnName,
        onStderr: ctx.onHookStderr,
      },
    );
    for (const e of result.errors) {
      ctx.onHookError?.('PreToolUse', e);
      yield { type: 'hook-error', event: 'PreToolUse', error: e };
    }
    for (const hookCommand of result.firedCommands) {
      yield {
        type: 'hook-fired',
        event: 'PreToolUse',
        hookCommand,
        ...(result.notice ? { notice: result.notice } : {}),
      };
    }
    if (!result.cancel) return { vetoed: false };
    const reason = result.errorMessage ?? 'Tool call denied by PreToolUse hook.';
    const message = `Tool call "${fnName}" was denied by a PreToolUse hook: ${reason}`;
    if (ctx.useUserResultFraming) {
      ctx.conversation.addUser(formatToolResultMessage(fnName, message));
    } else {
      ctx.conversation.addToolResult(message, toolCall.id);
    }
    yield {
      type: 'hook-veto',
      event: 'PreToolUse',
      toolName: fnName,
      errorMessage: result.errorMessage,
    };
    yield {
      type: 'tool-call-denied',
      toolName: fnName,
      args: fnArgs as Record<string, unknown>,
    };
    return { vetoed: true };
  } catch (err: unknown) {
    const msg = errorMessage(err);
    ctx.onHookError?.('PreToolUse', msg);
    yield { type: 'hook-error', event: 'PreToolUse', error: msg };
    return { vetoed: false };
  }
}

/** PostToolUse / PostToolUseFailure hook — informational; return value is
 *  logged but not acted on. Split on success so hook authors can scope a
 *  matcher to only failures (e.g. auto-bisect when Bash fails) without
 *  branching inside their script. No-ops when execute didn't reach a result
 *  (denied at policy / aborted / unknown tool). */
async function* runPostToolUseHook(
  toolCall: ToolCallMessage,
  ctx: ToolLoopContext,
  lastResult: { success: boolean; output: string } | null,
): AsyncGenerator<AgentEvent> {
  if (!ctx.hooksEnabled || !lastResult) return;
  // Re-resolve cwd here so a Bash `cd` earlier this turn is reflected.
  const cwd = ctx.cwdRef?.current ?? process.cwd();
  const postEvent: 'PostToolUse' | 'PostToolUseFailure' = lastResult.success
    ? 'PostToolUse'
    : 'PostToolUseFailure';
  try {
    const result = await runHook(
      postEvent,
      {
        toolName: toolCall.function?.name ?? '',
        args: toolCall.function?.arguments ?? {},
        success: lastResult.success,
        output: lastResult.output,
      },
      {
        cwd,
        config: ctx.hooksConfig,
        envPolicy: ctx.envPolicy,
        matchValue: toolCall.function?.name ?? '',
        onStderr: ctx.onHookStderr,
      },
    );
    for (const e of result.errors) {
      ctx.onHookError?.(postEvent, e);
      yield { type: 'hook-error', event: postEvent, error: e };
    }
    for (const hookCommand of result.firedCommands) {
      yield {
        type: 'hook-fired',
        event: postEvent,
        hookCommand,
        ...(result.notice ? { notice: result.notice } : {}),
      };
    }
  } catch (err: unknown) {
    const msg = errorMessage(err);
    ctx.onHookError?.(postEvent, msg);
    yield { type: 'hook-error', event: postEvent, error: msg };
  }
}

/** When the model is spinning on near-duplicate Bash commands, fire a
 *  one-shot nudge so it stops trying micro-variations. */
async function* maybeBashDedupNudge(
  toolCall: ToolCallMessage,
  ctx: ToolLoopContext,
): AsyncGenerator<AgentEvent> {
  if (!ctx.bashDedup) return;
  if (toolCall.function?.name !== TOOL_NAMES.Bash) return;
  const cmd = String(
    (toolCall.function?.arguments as Record<string, unknown> | undefined)?.command ?? '',
  );
  if (!cmd || !ctx.bashDedup.observe(cmd)) return;
  yield { type: 'bash-dedup-nudge', recentCommands: ctx.bashDedup.recentCommands() };
  ctx.conversation.addUser(
    '[System nudge: you just ran several near-duplicate Bash commands. Step back — do you already have enough information to answer the user? If yes, answer now. If no, take a fundamentally different approach (different tool, narrower question, or just ask the user). Do NOT run another variant of the same query.]',
  );
}

interface CorrectorParams {
  toolCall: ToolCallMessage;
  lastFailedResult: { toolName: string; output: string; skipCorrector?: boolean };
  callSignature: string;
}

/** Tool failed — try the LLM corrector once per (name, args) signature. The
 *  corrected call replaces the failed call's tool_result rather than
 *  appending a second one (Anthropic requires 1:1 tool_use ↔ tool_result),
 *  unless useUserResultFraming is on (no tool_result to replace). */
async function* runCorrectorIfNeeded(
  params: CorrectorParams,
  ctx: ToolLoopContext,
  recovery: RecoveryState,
): AsyncGenerator<AgentEvent, { deniedDelta: number }> {
  const { toolCall, lastFailedResult, callSignature } = params;
  const callSig = `${toolCall.function?.name}:${JSON.stringify(toolCall.function?.arguments ?? {})}`;
  if (
    !ctx.enableCorrector ||
    ctx.planMode ||
    lastFailedResult.skipCorrector ||
    recovery.correctedSignatures.has(callSig) ||
    recovery.correctionsUsedThisRun >= recovery.maxCorrections
  ) {
    return { deniedDelta: 0 };
  }
  recovery.correctedSignatures.add(callSig);
  recovery.correctionsUsedThisRun++;

  const fileContent = await readFileForCorrector(toolCall);
  // Tier-route the corrector: a malformed-call fix is a structural edit, not
  // a reasoning task. Run it on the same provider's weak-tier model when one
  // is mapped — same family, lower cost, no quality risk to the user's
  // primary turn (which always uses ctx.model below). Falls back to ctx.model
  // when no mapping exists.
  const correctorModel = selectWeakTier(ctx.provider, ctx.model) ?? ctx.model;
  const correction = await correctToolCall(
    {
      originalCall: toolCall,
      errorMessage: lastFailedResult.output,
      userIntent: ctx.userInput,
      fileContent,
    },
    ctx.provider,
    correctorModel,
    ctx.toolRegistry,
    ctx.signal,
  );

  if (correction.kind !== 'corrected') {
    yield { type: 'tool-call-corrector-aborted', reason: correction.reason };
    return { deniedDelta: 0 };
  }

  yield {
    type: 'tool-call-corrected',
    original: toolCall,
    corrected: correction.call,
    reason: lastFailedResult.output.slice(0, 200),
  };

  // Forward the original tool_use id onto the corrected call. The corrected
  // call's tool_result will *replace* the failed call's tool_result rather
  // than appending a second one — Anthropic requires each tool_result to
  // pair with a tool_use in the previous assistant message, and the model
  // only ever emitted one tool_use here.
  const correctedCall: ToolCallMessage = { ...correction.call, id: toolCall.id };
  const origName = toolCall.function?.name ?? 'unknown';
  const newName = correction.call.function?.name ?? 'unknown';
  const errSnippet = lastFailedResult.output.slice(0, 500);
  const prefix =
    `[Tool corrector: original ${origName} call failed (${errSnippet}). ` +
    `Substituted with ${newName}; output below.]\n\n`;

  let deniedDelta = 0;
  for await (const event of executeToolCall(correctedCall, ctx, {
    replaceLastToolResult: !ctx.useUserResultFraming,
    outputPrefix: prefix,
  })) {
    if (event.type === 'tool-call-denied') deniedDelta++;
    if (event.type === 'tool-call-result') {
      applyResultToRecovery(event, recovery, callSignature);
      // Maintain fileCache against the *corrected* call — its file_path is
      // what was actually read/written. Skipping this would mean a corrected
      // Read never seeds the read-cache, so a subsequent Read of the same
      // file would re-send full content instead of short-circuiting.
      if (event.result.success && ctx.fileCache) {
        await maintainFileCache(correctedCall, ctx.fileCache);
      }
    }
    yield event;
  }
  return { deniedDelta };
}
