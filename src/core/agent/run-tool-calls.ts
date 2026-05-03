import type { Provider, ToolCallMessage } from '../../providers/types.js';
import type { AgentEvent, PermissionDecision } from '../agent-types.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ToolResult } from '../../tools/types.js';
import type { Conversation } from '../conversation.js';
import type { PermissionManager } from '../../permissions.js';
import { formatToolResultMessage } from '../tool-result-format.js';
import { correctToolCall } from '../tool-call-corrector.js';
import type { RecoveryState } from './recovery-state.js';
import type { BashDedupTracker } from './bash-dedup.js';
import { FileCache } from './file-cache.js';
import * as fs from 'fs/promises';

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
    if (ctx.fileCache && toolCall.function?.name === 'Read') {
      const synthetic = yield* tryReadCacheHit(toolCall, ctx);
      if (synthetic) continue;
    }

    let lastFailedResult: { toolName: string; output: string } | null = null;
    for await (const event of executeToolCall(toolCall, ctx)) {
      if (event.type === 'tool-call-denied') {
        deniedCount++;
      }
      if (event.type === 'tool-call-result') {
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

    // Bash-dedup: if the model is spinning on near-duplicate commands, fire
    // a one-shot nudge so it stops trying micro-variations.
    if (
      ctx.bashDedup &&
      toolCall.function?.name === 'Bash'
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
      const correction = await correctToolCall(
        {
          originalCall: toolCall,
          errorMessage: lastFailedResult.output,
          userIntent: ctx.userInput,
          fileContent,
        },
        ctx.provider,
        ctx.model,
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
        for await (const event of executeToolCall(correction.call, ctx)) {
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

  const fp = await FileCache.stamp(path);
  if (!fp || fp.mtimeMs !== cached.mtimeMs || fp.hash !== cached.hash) return false;

  yield { type: 'tool-call-start', toolName: 'Read', args: args ?? {} };
  yield { type: 'read-cache-hit', path, afterCompaction: false };
  const message = `[Read cache hit: ${path} unchanged since your previous Read in this session (sha256:${cached.hash.slice(0, 16)}…). Refer to that earlier Read result for content.]`;
  if (ctx.useUserResultFraming) {
    ctx.conversation.addUser(formatToolResultMessage('Read', message));
  } else {
    ctx.conversation.addToolResult(message, toolCall.id);
  }
  const result: ToolResult = { success: true, output: message, displayOutput: message };
  yield { type: 'tool-call-result', toolName: 'Read', result };
  return true;
}

async function maintainFileCache(toolCall: ToolCallMessage, cache: FileCache): Promise<void> {
  const fnName = toolCall.function?.name;
  const args = toolCall.function?.arguments as Record<string, unknown> | undefined;
  const path = typeof args?.file_path === 'string' ? args.file_path : null;
  if (!path) return;
  if (fnName === 'Edit' || fnName === 'Write') {
    cache.invalidate(path);
    return;
  }
  if (fnName === 'Read') {
    const fp = await FileCache.stamp(path);
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

async function* executeToolCall(
  toolCall: ToolCallMessage,
  ctx: ToolLoopContext,
): AsyncGenerator<AgentEvent> {
  const { conversation, permissions, toolRegistry, signal, useUserResultFraming, planMode } = ctx;
  const fnName = toolCall.function?.name;
  const fnArgs = toolCall.function?.arguments as Record<string, unknown> | undefined;
  const toolCallId = toolCall.id;

  const recordResult = (output: string, name?: string): void => {
    if (useUserResultFraming) {
      const label = name ?? fnName ?? 'unknown';
      conversation.addUser(formatToolResultMessage(label, output));
    } else {
      conversation.addToolResult(output, toolCallId);
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

  // Permission check — inline because async generators can't yield from callbacks
  if (!permissions.isAutoAllowed(tool.name)) {
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
    } else if (decision === 'deny') {
      recordResult(`Tool call "${tool.name}" was denied by the user.`, tool.name);
      yield { type: 'tool-call-denied', toolName: tool.name };
      return;
    }
  }

  try {
    const result = await tool.execute(args);
    recordResult(result.output, tool.name);
    yield { type: 'tool-call-result', toolName: tool.name, result };
  } catch (err: any) {
    const errMsg = `Tool execution error: ${err.message}`;
    recordResult(errMsg, tool.name);
    yield {
      type: 'tool-call-result',
      toolName: tool.name,
      result: { success: false, output: errMsg },
    };
  }
}
