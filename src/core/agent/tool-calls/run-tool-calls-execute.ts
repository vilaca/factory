import type { ToolCallMessage } from '../../../providers/types.js';
import type { AgentEvent, PermissionDecision } from '../types.js';
import type { ToolHandler } from '../../../tools/types.js';
import type { PermissionManager } from '../../../security/permissions.js';
import { TOOL_NAMES } from '../../../tools/types.js';
import { formatToolResultMessage } from './tool-result-format.js';
import { errorMessage } from '../../../utils/errors.js';
import type { ToolLoopContext } from './run-tool-calls.js';

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

  if (ctx.planMode && tool.category !== 'read-only') {
    const planSummary = `[PLAN] Queued ${tool.name} call: ${JSON.stringify(args).slice(0, 200)}`;
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

  const skipPrompt =
    bashOutcome.kind === 'pre-allow' ||
    webFetch.preAllowed ||
    ctx.permissions.isAutoAllowed(tool.name);

  if (!skipPrompt) {
    const decision = yield* requestPermission(tool.name, args, ctx.signal);
    if (decision === 'aborted') return;
    if (decision === 'deny') {
      recordResult(`Tool call "${tool.name}" was denied by the user.`, tool.name);
      yield { type: 'tool-call-denied', toolName: tool.name, args };
      return;
    }
    applyAllowSideEffect(decision, tool.name, webFetch.hostname, ctx.permissions);
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
  | { kind: 'deny'; reason: string }
  | { kind: 'pre-allow' }
  | { kind: 'prompt' };

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

interface WebFetchAccess {
  hostname?: string;
  preAllowed: boolean;
}

/** WebFetch has a per-domain whitelist that gates *before* the standard
 *  tool-level permission check. A pre-allowed hostname skips the prompt for
 *  this URL even though `WebFetch` itself isn't in `allowedTools`. Malformed
 *  URLs short-circuit too — let the tool's own validation produce the error. */
function evaluateWebFetchAccess(
  tool: ToolHandler,
  args: Record<string, unknown>,
  permissions: PermissionManager,
): WebFetchAccess {
  if (tool.name !== TOOL_NAMES.WebFetch) return { preAllowed: false };
  const rawUrl = typeof args.url === 'string' ? args.url : '';
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return { hostname, preAllowed: permissions.isDomainAllowed(hostname) };
  } catch {
    return { preAllowed: true };
  }
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
        }
      : undefined;
    const result = await tool.execute(args, toolCtx);
    // Bash signals cwd changes via cwdAfter; propagate so subsequent tools in
    // this turn (and the next turn) see the new directory.
    if (result.cwdAfter && ctx.cwdRef) {
      ctx.cwdRef.current = result.cwdAfter;
    }
    recordResult(result.output, tool.name);
    yield { type: 'tool-call-result', toolName: tool.name, args, result };
  } catch (err: unknown) {
    const errMsg = `Tool execution error: ${errorMessage(err)}`;
    recordResult(errMsg, tool.name);
    yield {
      type: 'tool-call-result',
      toolName: tool.name,
      args,
      result: { success: false, output: errMsg },
    };
  }
}
