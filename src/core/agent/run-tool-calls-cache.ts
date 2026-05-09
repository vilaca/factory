import type { ToolCallMessage } from '../../providers/types.js';
import type { AgentEvent } from '../agent-types.js';
import type { ToolResult } from '../../tools/types.js';
import { TOOL_NAMES } from '../../tools/types.js';
import { FileCache } from './file-cache.js';
import { formatToolResultMessage } from '../tool-result-format.js';
import type { ToolLoopContext } from './run-tool-calls.js';

export async function* tryReadCacheHit(
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

export async function maintainFileCache(
  toolCall: ToolCallMessage,
  cache: FileCache,
): Promise<void> {
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
