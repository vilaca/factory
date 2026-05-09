import type { ToolCallMessage } from '../../../providers/types.js';
import type { AgentEvent, PermissionDecision } from '../types.js';
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

// eslint-disable-next-line max-statements, complexity, sonarjs/cognitive-complexity -- TODO(complexity): split permission/exec/event-emit phases.
export async function* executeToolCall(
  toolCall: ToolCallMessage,
  ctx: ToolLoopContext,
  options?: ExecuteToolCallOptions,
): AsyncGenerator<AgentEvent> {
  const { conversation, permissions, toolRegistry, signal, useUserResultFraming, planMode } = ctx;
  const fnName = toolCall.function?.name;
  const fnArgs = toolCall.function?.arguments as Record<string, unknown> | undefined;
  const toolCallId = toolCall.id;

  const recordResult = (output: string, name?: string): void => {
    const finalOutput = options?.outputPrefix ? options.outputPrefix + output : output;
    const labelForCap = name ?? fnName ?? 'tool';
    if (useUserResultFraming) {
      conversation.addUser(formatToolResultMessage(labelForCap, finalOutput));
    } else if (options?.replaceLastToolResult) {
      conversation.replaceLastToolResult(finalOutput, toolCallId, labelForCap);
    } else {
      conversation.addToolResult(finalOutput, toolCallId, labelForCap);
    }
  };

  if (!fnName) {
    recordResult('Error: tool call missing function name');
    return;
  }

  const tool = toolRegistry.get(fnName);
  if (!tool) {
    const errMsg = `Error: unknown tool "${fnName}"`;
    recordResult(errMsg, fnName);
    yield { type: 'error', error: new Error(errMsg) };
    return;
  }

  const args = fnArgs ?? {};

  if (planMode && tool.category !== 'read-only') {
    const planSummary = `[PLAN] Queued ${tool.name} call: ${JSON.stringify(args).slice(0, 200)}`;
    recordResult(planSummary, tool.name);
    yield { type: 'tool-call-planned', toolName: tool.name, args };
    return;
  }

  yield { type: 'tool-call-start', toolName: tool.name, args };

  // Bash policy: built-in forbidden patterns hard-deny here, before any
  // permission prompt. allow-all on Bash cannot bypass these. User rules
  // can also pre-resolve to allow/deny without prompting. See
  // src/security/bash-rules.ts.
  let bashPolicyAllowed = false;
  if (tool.name === TOOL_NAMES.Bash) {
    const command = typeof args.command === 'string' ? args.command : '';
    if (command) {
      const policyEval = permissions.evaluateBashCommand(command);
      if (policyEval.kind === 'deny') {
        recordResult(policyEval.reason, tool.name);
        yield { type: 'tool-call-denied', toolName: tool.name, args };
        return;
      }
      if (policyEval.kind === 'allow') {
        bashPolicyAllowed = true;
      }
      // 'prompt' falls through to the standard permission flow.
    }
  }

  // WebFetch has a per-domain whitelist that gates *before* the standard
  // tool-level permission check. A pre-allowed hostname skips the prompt
  // for this URL even though `WebFetch` itself isn't in `allowedTools`.
  let webFetchHostname: string | undefined;
  let webFetchAlreadyAllowed = false;
  if (tool.name === TOOL_NAMES.WebFetch) {
    const rawUrl = typeof args.url === 'string' ? args.url : '';
    try {
      webFetchHostname = new URL(rawUrl).hostname.toLowerCase();
      if (permissions.isDomainAllowed(webFetchHostname)) {
        webFetchAlreadyAllowed = true;
      }
    } catch {
      // Malformed URL: let the tool's own validation produce the error
      // (no prompt; tool returns success: false immediately).
      webFetchAlreadyAllowed = true;
    }
  }

  // Permission check — inline because async generators can't yield from callbacks
  if (!bashPolicyAllowed && !webFetchAlreadyAllowed && !permissions.isAutoAllowed(tool.name)) {
    let resolvePermission!: (d: PermissionDecision | 'abort') => void;
    const permissionPromise = new Promise<PermissionDecision | 'abort'>(resolve => {
      resolvePermission = resolve;
    });

    // Race against abort signal so we don't hang forever
    let abortHandler: (() => void) | undefined;
    if (signal) {
      abortHandler = () => resolvePermission('abort');
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    let decision: PermissionDecision | 'abort';
    try {
      yield {
        type: 'permission-request' as const,
        toolName: tool.name,
        args,
        respond: (d: PermissionDecision) => resolvePermission(d),
      };
      decision = await permissionPromise;
    } finally {
      // finally so cleanup runs even if the generator is cancelled or throws
      // mid-await — otherwise the closure stays attached to a long-lived signal.
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    }

    if (decision === 'abort') {
      // Aborted — don't add denial to conversation, just stop
      return;
    } else if (decision === 'allow-all') {
      permissions.allowAll(tool.name);
    } else if (decision === 'allow-domain') {
      // WebFetch-only: remember this hostname for the rest of the session.
      // Other tools won't see this decision because the prompt UI only
      // exposes the option for WebFetch.
      if (webFetchHostname) permissions.allowDomain(webFetchHostname);
    } else if (decision === 'deny') {
      recordResult(`Tool call "${tool.name}" was denied by the user.`, tool.name);
      yield { type: 'tool-call-denied', toolName: tool.name, args };
      return;
    }
  }

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
