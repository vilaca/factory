import type { Provider, ToolCallMessage } from '../../providers/types.js';
import type { AgentEvent, PermissionDecision } from '../agent-types.js';
import type { HooksConfig } from '../config-types.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ToolResult } from '../../tools/types.js';
import { TOOL_NAMES } from '../../tools/types.js';
import type { PathPolicy } from '../../security/paths.js';
import type { EnvPolicy } from '../../security/env.js';
import type { Conversation } from '../conversation.js';
import type { PermissionManager } from '../../permissions.js';
import { formatToolResultMessage } from '../tool-result-format.js';
import { correctToolCall } from '../tool-call-corrector.js';
import { selectWeakTier } from './weak-tier.js';
import type { RecoveryState } from './recovery-state.js';
import type { BashDedupTracker } from './bash-dedup.js';
import { FileCache } from './file-cache.js';
import { runHook } from '../hooks/index.js';
import * as fs from 'fs/promises';
import { errorMessage } from '../../utils/errors.js';

export interface ToolLoopContext {
  conversation: Conversation;
  permissions: PermissionManager;
  toolRegistry: ToolRegistry;
  signal: AbortSignal | undefined;
  useUserResultFraming: boolean;
  planMode: boolean;
  enableCorrector: boolean;
  bashDedup?: BashDedupTracker;
  fileCache?: FileCache;
  provider: Provider;
  model: string;
  userInput: string;
  /** Mutable cwd holder for the per-tab working directory. Tools resolve
   * relative paths against `.current`, and Bash updates it via `cwdAfter` so
   * `cd` persists across calls within a turn. The agent loop syncs this back
   * to RunRefs after the loop completes. Optional so headless callers can
   * skip it. */
  cwdRef?: { current: string };
  /** Path-policy deny extensions (built-in deny list always applies). The
   * loop forwards this verbatim to each tool's ToolContext. */
  pathPolicy?: PathPolicy;
  /** Env-policy allow extensions for Bash. Same plumbing as pathPolicy. */
  envPolicy?: EnvPolicy;
  hooksEnabled?: boolean;
  hooksConfig?: HooksConfig;
  onHookStderr?: (command: string, chunk: string) => void;
  onHookError?: (event: string, error: string) => void;
}

export interface ToolLoopResult {
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

  // Strict sequential execution is load-bearing here, not an implementation
  // detail. Bash can mutate ctx.cwdRef.current via cwdAfter (so a `cd` in
  // one call is visible to the next), and the read-cache short-circuit
  // assumes earlier results are already committed to ctx.fileCache. A
  // future refactor that parallelizes this loop must first redesign cwd
  // propagation (probably: each Bash call gets a snapshot of cwd, the
  // last-completed cwdAfter wins — but "last" isn't well-defined under
  // parallel execution, so this needs explicit policy).
  for (const toolCall of toolCalls) {
    if (ctx.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    // Read-cache short-circuit: if the same file was Read earlier in this
    // session, the prior result is still in conversation (not compacted away),
    // and the file's fingerprint matches, return a one-liner instead of
    // re-sending the full content. Saves real tokens on repeat reads.
    if (ctx.fileCache && toolCall.function?.name === TOOL_NAMES.Read) {
      const synthetic = yield* tryReadCacheHit(toolCall, ctx);
      if (synthetic) continue;
    }

    // PreToolUse hook — can veto the tool call. Hooks see the tool name and
    // arguments and can return `{ cancel: true, errorMessage }`. Vetoes
    // surface to the model as a denial so the agent can react and try
    // something else, the same way a user-denial does.
    if (ctx.hooksEnabled) {
      const fnName = toolCall.function?.name ?? '';
      const fnArgs = toolCall.function?.arguments ?? {};
      // Resolve cwd at fire time, not at agent-loop start, so a hook fired
      // after Bash `cd`'d earlier this turn picks up the project-local
      // .factory/hooks/ at the new directory.
      const cwd = ctx.cwdRef?.current ?? process.cwd();
      try {
        const result = await runHook(
          'PreToolUse',
          { toolName: fnName, args: fnArgs },
          { cwd, config: ctx.hooksConfig, matchValue: fnName, onStderr: ctx.onHookStderr },
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
        if (result.cancel) {
          const reason = result.errorMessage ?? 'Tool call denied by PreToolUse hook.';
          const message = `Tool call "${fnName}" was denied by a PreToolUse hook: ${reason}`;
          if (ctx.useUserResultFraming) {
            ctx.conversation.addUser(formatToolResultMessage(fnName, message));
          } else {
            ctx.conversation.addToolResult(message, toolCall.id);
          }
          deniedCount++;
          yield {
            type: 'hook-veto',
            event: 'PreToolUse',
            toolName: fnName,
            errorMessage: result.errorMessage,
          };
          yield { type: 'tool-call-denied', toolName: fnName, args: fnArgs as Record<string, unknown> };
          continue;
        }
      } catch (err: unknown) {
        const msg = errorMessage(err);
        ctx.onHookError?.('PreToolUse', msg);
        yield { type: 'hook-error', event: 'PreToolUse', error: msg };
      }
    }

    let lastFailedResult: { toolName: string; output: string } | null = null;
    let lastResultForPostHook: { success: boolean; output: string } | null = null;
    for await (const event of executeToolCall(toolCall, ctx)) {
      if (event.type === 'tool-call-denied') {
        deniedCount++;
      }
      if (event.type === 'tool-call-result') {
        lastResultForPostHook = { success: event.result.success, output: event.result.output };
        if (event.result.success) {
          recovery.lastFailureMessage = null;
          recovery.lastFailureSignature = null;
          recovery.consecutiveSameFailures = 0;
          lastFailedResult = null;
          // Update or invalidate the file cache after successful Read/Edit/Write.
          if (ctx.fileCache) await maintainFileCache(toolCall, ctx.fileCache);
        } else {
          recovery.lastFailureMessage = `${event.toolName}: ${event.result.output}`;
          recovery.lastFailureSignature = callSignature;
          lastFailedResult = { toolName: event.toolName, output: event.result.output };
        }
      }
      yield event;
    }

    // PostToolUse / PostToolUseFailure hook — informational; return value is
    // logged but not acted on. Split on success so hook authors can scope a
    // matcher to only failures (e.g. auto-bisect when Bash fails) without
    // branching inside their script.
    if (ctx.hooksEnabled && lastResultForPostHook) {
      // Fires after Bash, which may have updated cwdRef via `cd`. Re-resolve
      // here so the hook sees the post-`cd` directory.
      const cwd = ctx.cwdRef?.current ?? process.cwd();
      const postEvent: 'PostToolUse' | 'PostToolUseFailure' = lastResultForPostHook.success
        ? 'PostToolUse'
        : 'PostToolUseFailure';
      try {
        const result = await runHook(
          postEvent,
          {
            toolName: toolCall.function?.name ?? '',
            args: toolCall.function?.arguments ?? {},
            success: lastResultForPostHook.success,
            output: lastResultForPostHook.output,
          },
          { cwd, config: ctx.hooksConfig, matchValue: toolCall.function?.name ?? '', onStderr: ctx.onHookStderr },
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

    // Bash-dedup: if the model is spinning on near-duplicate commands, fire
    // a one-shot nudge so it stops trying micro-variations.
    if (
      ctx.bashDedup &&
      toolCall.function?.name === TOOL_NAMES.Bash
    ) {
      const cmd = String((toolCall.function?.arguments as Record<string, unknown> | undefined)?.command ?? '');
      if (cmd && ctx.bashDedup.observe(cmd)) {
        yield { type: 'bash-dedup-nudge', recentCommands: ctx.bashDedup.recentCommands() };
        ctx.conversation.addUser(
          '[System nudge: you just ran several near-duplicate Bash commands. Step back — do you already have enough information to answer the user? If yes, answer now. If no, take a fundamentally different approach (different tool, narrower question, or just ask the user). Do NOT run another variant of the same query.]',
        );
      }
    }

    // Tool failed — try the LLM corrector once per (name, args) signature.
    const callSig = `${toolCall.function?.name}:${JSON.stringify(toolCall.function?.arguments ?? {})}`;
    if (
      ctx.enableCorrector &&
      lastFailedResult &&
      !ctx.planMode &&
      !recovery.correctedSignatures.has(callSig) &&
      recovery.correctionsUsedThisRun < recovery.maxCorrections
    ) {
      recovery.correctedSignatures.add(callSig);
      recovery.correctionsUsedThisRun++;

      const fileContent = await readFileForCorrector(toolCall);
      // Tier-route the corrector: a malformed-call fix is a structural
      // edit, not a reasoning task. Run it on the same provider's
      // weak-tier model when one's mapped — same family, lower cost,
      // no quality risk to the user's primary turn (which always uses
      // ctx.model below). Falls back to ctx.model when no mapping exists.
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

      if (correction.kind === 'corrected') {
        yield {
          type: 'tool-call-corrected',
          original: toolCall,
          corrected: correction.call,
          reason: lastFailedResult.output.slice(0, 200),
        };
        // Forward the original tool_use id onto the corrected call. The
        // corrected call's tool_result will *replace* the failed call's
        // tool_result rather than appending a second one — Anthropic requires
        // each tool_result to pair with a tool_use in the previous assistant
        // message, and the model only ever emitted one tool_use here.
        const correctedCall: ToolCallMessage = { ...correction.call, id: toolCall.id };
        const origName = toolCall.function?.name ?? 'unknown';
        const newName = correction.call.function?.name ?? 'unknown';
        const errSnippet = lastFailedResult.output.slice(0, 500);
        const prefix =
          `[Tool corrector: original ${origName} call failed (${errSnippet}). ` +
          `Substituted with ${newName}; output below.]\n\n`;
        for await (const event of executeToolCall(correctedCall, ctx, {
          replaceLastToolResult: !ctx.useUserResultFraming,
          outputPrefix: prefix,
        })) {
          if (event.type === 'tool-call-denied') {
            deniedCount++;
          }
          if (event.type === 'tool-call-result') {
            if (event.result.success) {
              recovery.lastFailureMessage = null;
              recovery.lastFailureSignature = null;
              recovery.consecutiveSameFailures = 0;
            } else {
              recovery.lastFailureMessage = `${event.toolName}: ${event.result.output}`;
              recovery.lastFailureSignature = callSignature;
            }
          }
          yield event;
        }
      } else {
        yield { type: 'tool-call-corrector-aborted', reason: correction.reason };
      }
    }
  }

  return { deniedCount };
}

async function* tryReadCacheHit(
  toolCall: ToolCallMessage,
  ctx: ToolLoopContext,
): AsyncGenerator<AgentEvent, boolean> {
  if (!ctx.fileCache) return false;
  const args = toolCall.function?.arguments as Record<string, unknown> | undefined;
  const path = typeof args?.file_path === 'string' ? args.file_path : null;
  if (!path) return false;
  const cached = ctx.fileCache.get(path);
  if (!cached) return false;
  // If the prior Read was already swept into a compaction summary, the model
  // can't refer back to it — skip the short-circuit and let the read happen.
  if (ctx.fileCache.wasReadBeforeCompaction(path)) return false;

  // Pass the cached fingerprint so stamp() can skip the body read + sha256
  // when stat says the file is unchanged. The hash check below still rejects
  // any false-positive fast-path returns; in the common case it confirms the
  // already-cached hash without rehashing.
  const fp = await FileCache.stamp(path, cached);
  if (!fp || fp.mtimeMs !== cached.mtimeMs || fp.hash !== cached.hash) return false;

  yield { type: 'tool-call-start', toolName: TOOL_NAMES.Read, args: args ?? {} };
  yield { type: 'read-cache-hit', path, afterCompaction: false };
  const message = `[Read cache hit: ${path} unchanged since your previous Read in this session (sha256:${cached.hash.slice(0, 16)}…). Refer to that earlier Read result for content.]`;
  if (ctx.useUserResultFraming) {
    ctx.conversation.addUser(formatToolResultMessage(TOOL_NAMES.Read, message));
  } else {
    ctx.conversation.addToolResult(message, toolCall.id, TOOL_NAMES.Read);
  }
  const result: ToolResult = { success: true, output: message, displayOutput: message };
  yield { type: 'tool-call-result', toolName: TOOL_NAMES.Read, args: args ?? {}, result };
  return true;
}

async function maintainFileCache(toolCall: ToolCallMessage, cache: FileCache): Promise<void> {
  const fnName = toolCall.function?.name;
  const args = toolCall.function?.arguments as Record<string, unknown> | undefined;
  const path = typeof args?.file_path === 'string' ? args.file_path : null;
  if (!path) return;
  if (fnName === TOOL_NAMES.Edit || fnName === TOOL_NAMES.Write) {
    cache.invalidate(path);
    return;
  }
  if (fnName === TOOL_NAMES.Read) {
    const fp = await FileCache.stamp(path, cache.get(path));
    if (fp) cache.record(path, fp);
  }
}

export async function readFileForCorrector(call: ToolCallMessage): Promise<{ path: string; content: string } | undefined> {
  const args = call.function?.arguments as Record<string, unknown> | undefined;
  const path = typeof args?.file_path === 'string' ? args.file_path : null;
  if (!path) return undefined;
  // Cap the read at 32KB. The corrector slices to 8000 chars before sending
  // to the model anyway; reading more is just memory waste on large files.
  const READ_CAP_BYTES = 32 * 1024;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, 'r');
    const buf = Buffer.alloc(READ_CAP_BYTES);
    const { bytesRead } = await handle.read(buf, 0, READ_CAP_BYTES, 0);
    return { path, content: buf.toString('utf-8', 0, bytesRead) };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => { /* ignore */ });
  }
}

interface ExecuteToolCallOptions {
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

async function* executeToolCall(
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
    const planSummary =
      `[PLAN] Queued ${tool.name} call: ${JSON.stringify(args).slice(0, 200)}`;
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
    const permissionPromise = new Promise<PermissionDecision | 'abort'>((resolve) => {
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
