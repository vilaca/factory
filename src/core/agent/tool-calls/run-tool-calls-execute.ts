import type { ToolCallMessage } from '../../../providers/types.js';
import type { AgentEvent, PermissionDecision } from '../types.js';
import type { ToolHandler } from '../../../tools/host.js';
import type { PermissionManager } from '../../../security/permissions.js';
import { TOOL_NAMES, ToolResolutionError } from '../../../tools/host.js';
import { formatToolResultMessage } from './tool-result-format.js';
import { errorMessage } from '../../../utils/errors.js';
import { validateAgainstSchema } from '../../../utils/json-schema-validate.js';
import type { ToolLoopContext } from './types.js';
import { PLAN_ARGS_PREVIEW_CHARS } from './constants.js';

export interface ExecuteToolCallOptions {
  /**
   * If true, replace the most recent tool_result in the conversation instead
   * of appending. Used by the corrector path so that the original failed
   * call's tool_result gets overwritten with the substituted call's output —
   * keeping a 1:1 tool_use ↔ tool_result invariant for the Anthropic API.
   * Callers must pass false under useUserResultFraming, where results are
   * recorded as user messages (no tool_result to replace).
   */
  replaceLastToolResult?: boolean;
  /** Prepended to the recorded output. */
  outputPrefix?: string;
  /**
   * Internal host escape hatch for deterministic framework-owned calls
   * (e.g. harness-scoped instruction Reads). Skips user permission prompting
   * while still preserving tool-call start/result events and normal execution.
   */
  skipPermissionCheck?: boolean;
}

type RecordResult = (output: string, name?: string) => void;

export async function* executeToolCall(
  toolCall: ToolCallMessage,
  ctx: ToolLoopContext,
  options?: ExecuteToolCallOptions,
): AsyncGenerator<AgentEvent> {
  const fnName = toolCall.function?.name;
  const args = (toolCall.function?.arguments as Record<string, unknown> | undefined) ?? {};
  const recordResult = makeRecordResult(ctx, options, toolCall.id, fnName);

  if (!fnName) {
    recordResult('Error: tool call missing function name');
    return;
  }

  const tool = ctx.toolRegistry.get(fnName);
  if (!tool) {
    const errMsg = `Error: unknown tool "${fnName}"`;
    recordResult(errMsg, fnName);
    yield { type: 'error', error: new Error(errMsg) };
    return;
  }

  // Validate args against the tool's declared JSON Schema before the tool
  // body sees them. Catches the "model called with wrong-shape args"
  // failure mode at the boundary — no tool-body code paths run on
  // malformed input, and the model gets a structured corrective message
  // to retry against. Flagged softError+skipCorrector for the same
  // reason ToolResolutionError is: it's the model's fault (not the
  // tool's), and the message is already actionable, so the LLM
  // corrector would just burn a call.
  const schemaError = validateAgainstSchema(tool.definition.function.parameters, args);
  if (schemaError) {
    const errMsg = `Invalid arguments for "${tool.name}": ${schemaError}`;
    recordResult(errMsg, tool.name);
    yield { type: 'tool-call-start', toolName: tool.name, args };
    yield {
      type: 'tool-call-result',
      toolName: tool.name,
      args,
      result: {
        success: false,
        output: errMsg,
        softError: true,
        skipCorrector: true,
      },
    };
    return;
  }

  if (ctx.planMode && tool.category !== 'read-only') {
    const planSummary = `[PLAN] Queued ${tool.name} call: ${JSON.stringify(args).slice(0, PLAN_ARGS_PREVIEW_CHARS)}`;
    recordResult(planSummary, tool.name);
    yield { type: 'tool-call-planned', toolName: tool.name, args };
    return;
  }

  yield { type: 'tool-call-start', toolName: tool.name, args };

  const bashOutcome = evaluateBashPolicy(tool, args, ctx.permissions);
  if (bashOutcome.kind === 'deny') {
    recordResult(bashOutcome.reason, tool.name);
    yield { type: 'tool-call-denied', toolName: tool.name, args };
    return;
  }
  const webFetch = evaluateWebFetchAccess(tool, args, ctx.permissions);
  if (webFetch.kind === 'deny') {
    recordResult(webFetch.reason, tool.name);
    yield { type: 'tool-call-denied', toolName: tool.name, args };
    return;
  }

  const skipPermissionCheck = options?.skipPermissionCheck ?? false;
  const skipPrompt =
    skipPermissionCheck ||
    bashOutcome.kind === 'pre-allow' ||
    webFetch.kind === 'pre-allow' ||
    ctx.permissions.isAutoAllowed(tool.name);

  if (!skipPrompt) {
    // ctx.permissionMutex is set by the parallel-Delegate batch path so
    // that N concurrent pipelines surface their prompts to the host one
    // at a time. Other call sites leave it undefined; acquire() is a no-
    // op fast-path in that case.
    const release = ctx.permissionMutex ? await ctx.permissionMutex.acquire() : undefined;
    let decision: PermissionDecision | 'aborted';
    try {
      // Re-check the auto-allow cache *after* taking the lock — an earlier
      // prompt in the same batch may have answered "allow-all" for this
      // tool, in which case we skip the redundant prompt entirely.
      if (ctx.permissions.isAutoAllowed(tool.name)) {
        decision = 'allow';
      } else {
        decision = yield* requestPermission(tool.name, args, ctx.signal);
      }
    } finally {
      release?.();
    }
    if (decision === 'aborted') return;
    if (decision === 'deny') {
      recordResult(`Tool call "${tool.name}" was denied by the user.`, tool.name);
      yield { type: 'tool-call-denied', toolName: tool.name, args };
      return;
    }
    const promptedHostname = webFetch.kind === 'prompt' ? webFetch.hostname : undefined;
    applyAllowSideEffect(decision, tool.name, promptedHostname, ctx.permissions);
  }

  yield* executeAndEmit(tool, args, ctx, recordResult);
}

function makeRecordResult(
  ctx: ToolLoopContext,
  options: ExecuteToolCallOptions | undefined,
  toolCallId: string | undefined,
  fnName: string | undefined,
): RecordResult {
  return (output, name) => {
    const finalOutput = options?.outputPrefix ? options.outputPrefix + output : output;
    const labelForCap = name ?? fnName ?? 'tool';
    if (ctx.useUserResultFraming) {
      ctx.conversation.addUser(formatToolResultMessage(labelForCap, finalOutput));
    } else if (options?.replaceLastToolResult) {
      ctx.conversation.replaceLastToolResult(finalOutput, toolCallId, labelForCap);
    } else {
      ctx.conversation.addToolResult(finalOutput, toolCallId, labelForCap);
    }
  };
}

type BashPolicyOutcome =
  { kind: 'deny'; reason: string } | { kind: 'pre-allow' } | { kind: 'prompt' };

/** Built-in forbidden patterns hard-deny before any permission prompt;
 *  allow-all on Bash cannot bypass these. User rules can also pre-resolve to
 *  allow/deny without prompting. See src/security/bash-rules.ts. Empty Bash
 *  command falls through to 'prompt' so the tool's own validation runs. */
function evaluateBashPolicy(
  tool: ToolHandler,
  args: Record<string, unknown>,
  permissions: PermissionManager,
): BashPolicyOutcome {
  if (tool.name !== TOOL_NAMES.Bash) return { kind: 'prompt' };
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command) return { kind: 'prompt' };
  const policyEval = permissions.evaluateBashCommand(command);
  if (policyEval.kind === 'deny') return { kind: 'deny', reason: policyEval.reason };
  if (policyEval.kind === 'allow') return { kind: 'pre-allow' };
  return { kind: 'prompt' };
}

type WebFetchOutcome =
  | { kind: 'not-webfetch' }
  | { kind: 'deny'; reason: string }
  | { kind: 'pre-allow' }
  | { kind: 'prompt'; hostname: string };

/** WebFetch has a per-domain whitelist that gates *before* the standard
 *  tool-level permission check. A pre-allowed hostname skips the prompt for
 *  this URL even though `WebFetch` itself isn't in `allowedTools`. Malformed
 *  URLs deny at the gate (fail-closed) rather than relying on the tool's
 *  own validation: the security check shouldn't depend on the downstream
 *  parser staying in lockstep with this one. */
function evaluateWebFetchAccess(
  tool: ToolHandler,
  args: Record<string, unknown>,
  permissions: PermissionManager,
): WebFetchOutcome {
  if (tool.name !== TOOL_NAMES.WebFetch) return { kind: 'not-webfetch' };
  const rawUrl = typeof args.url === 'string' ? args.url : '';
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return { kind: 'deny', reason: `WebFetch: invalid URL "${rawUrl}".` };
  }
  if (permissions.isDomainAllowed(hostname)) return { kind: 'pre-allow' };
  return { kind: 'prompt', hostname };
}

/** Yield a permission-request and wait for the response. Races against the
 *  abort signal so an aborted turn doesn't hang the prompt forever. The
 *  finally cleanup runs even if the generator is cancelled mid-await,
 *  preventing the closure from staying attached to a long-lived signal. */
async function* requestPermission(
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, PermissionDecision | 'aborted'> {
  // Short-circuit if the signal already fired before we got here. addEventListener('abort')
  // doesn't auto-invoke for an already-dispatched event, so without this check a permission
  // request entered post-abort would hang forever waiting on a listener that can't fire.
  // Reachable from the parallel-Delegate batch path when an abort lands while a prior
  // pipeline holds the permission mutex.
  if (signal?.aborted) return 'aborted';

  let resolvePermission!: (d: PermissionDecision | 'abort') => void;
  const permissionPromise = new Promise<PermissionDecision | 'abort'>(resolve => {
    resolvePermission = resolve;
  });

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => resolvePermission('abort');
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    yield {
      type: 'permission-request',
      toolName,
      args,
      respond: (d: PermissionDecision) => resolvePermission(d),
    };
    const decision = await permissionPromise;
    return decision === 'abort' ? 'aborted' : decision;
  } finally {
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}

function applyAllowSideEffect(
  decision: PermissionDecision,
  toolName: string,
  webFetchHostname: string | undefined,
  permissions: PermissionManager,
): void {
  if (decision === 'allow-all') {
    permissions.allowAll(toolName);
    return;
  }
  if (decision === 'allow-domain' && webFetchHostname) {
    // WebFetch-only: remember this hostname for the rest of the session.
    // Other tools won't see this decision because the prompt UI only exposes
    // the option for WebFetch.
    permissions.allowDomain(webFetchHostname);
  }
}

async function* executeAndEmit(
  tool: ToolHandler,
  args: Record<string, unknown>,
  ctx: ToolLoopContext,
  recordResult: RecordResult,
): AsyncGenerator<AgentEvent> {
  try {
    const toolCtx = ctx.cwdRef
      ? {
          cwd: ctx.cwdRef.current,
          pathPolicy: ctx.pathPolicy,
          envPolicy: ctx.envPolicy,
          signal: ctx.signal,
          isHostnameAllowed: (h: string) => ctx.permissions.isDomainAllowed(h),
        }
      : undefined;
    const result = await tool.execute(args, toolCtx);
    // Bash signals cwd changes via cwdAfter; propagate so subsequent tools
    // in this turn (and the next turn) see the new directory. The
    // `tool.kind === 'bash'` narrow is what makes `result.cwdAfter`
    // readable here — the standard-tool branch of the discriminated
    // union forbids the field, so this access is only well-typed once
    // we have proved we're holding a `BashToolHandler`.
    if (tool.kind === 'bash' && result.success && result.cwdAfter && ctx.cwdRef) {
      ctx.cwdRef.current = result.cwdAfter;
    }
    recordResult(result.output, tool.name);
    // Reliability stack (Phase 5): record successful calls on the step
    // tracker so required-step satisfaction and arg-matched prereq
    // lookups stay accurate. The enforcer is optional — callers
    // without `requiredSteps` / prereqs leave it undefined and this is
    // a no-op.
    if (result.success && ctx.stepEnforcer) {
      ctx.stepEnforcer.record(tool.name, args);
    }
    // Apply any pending user message AFTER the tool_result is committed so
    // the conversation sequence stays tool_use → tool_result → user(msg).
    // This keeps the Anthropic/Copilot API requirement that tool_result
    // immediately follows tool_use. Currently used by invoke_skill to
    // inject the skill system message without violating that constraint.
    if (result.success && result.pendingUserMessage) {
      ctx.conversation.addUser(result.pendingUserMessage);
    }
    yield { type: 'tool-call-result', toolName: tool.name, args, result };
  } catch (err: unknown) {
    // Reliability stack (Phase 6): ToolResolutionError is the
    // "valid request, no resource" signal from the tool author. Feed
    // the message back as the tool result so the model can read it
    // and retry with different args. Tagged with `softError: true`
    // so the agent loop's hard-error counter skips this case, and
    // `skipCorrector: true` because the resolution message is
    // already the model's feedback — running the LLM corrector on
    // top would be a wasted call.
    if (err instanceof ToolResolutionError) {
      recordResult(err.message, tool.name);
      yield {
        type: 'tool-call-result',
        toolName: tool.name,
        args,
        result: {
          success: false,
          output: err.message,
          softError: true,
          skipCorrector: true,
        },
      };
      return;
    }
    const errMsg = `Tool execution error: ${errorMessage(err)}`;
    recordResult(errMsg, tool.name);
    yield {
      type: 'tool-call-result',
      toolName: tool.name,
      args,
      // `hardError: true` is the signal to the agent loop's
      // consecutive-hard-error counter — the tool's callable threw,
      // which is the 5xx case. Distinguishes a thrown exception from
      // a graceful `{ success: false }` return.
      result: { success: false, output: errMsg, hardError: true },
    };
  }
}
