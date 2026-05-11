import type { ToolCallMessage } from '../../../providers/types.js';
import type { AgentEvent } from '../types.js';
import type { ToolResult } from '../../../tools/types.js';
import { TOOL_NAMES } from '../../../tools/types.js';
import { FileCache } from '../cache/file-cache.js';
import { formatToolResultMessage } from './tool-result-format.js';
import type { ToolLoopContext } from './run-tool-calls.js';

/** Returns true when args request a partial read (explicit offset or limit).
 *  The cache only knows the file is unchanged — it doesn't track which line
 *  ranges were returned to the model.  Serving a "refer to your earlier Read"
 *  hit for a range the model never saw produces a hallucination-inducing gap,
 *  so partial reads always bypass the cache. */
function isPartialRead(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false;
  const offset = args.offset;
  const limit = args.limit;
  if (typeof offset === 'number' && offset !== 0) return true;
  if (limit !== undefined && limit !== null) return true;
  return false;
}

export async function* tryReadCacheHit(
  toolCall: ToolCallMessage,
  ctx: ToolLoopContext,
): AsyncGenerator<AgentEvent, boolean> {
  if (!ctx.fileCache) return false;
  const args = toolCall.function?.arguments as Record<string, unknown> | undefined;
  const path = typeof args?.file_path === 'string' ? args.file_path : null;
  if (!path) return false;

  // Never serve a cache hit for partial reads (non-zero offset or explicit
  // limit).  The cached entry only proves the file hasn't changed — not that
  // the model has already seen the specific line range it's asking for now.
  if (isPartialRead(args)) return false;

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
    // Only seed the cache when the Read returned the full file.  A partial
    // read (offset/limit) doesn't guarantee the model saw every line, so
    // caching it would let a later full-file Read get a misleading
    // "unchanged — refer to earlier Read" hit that omits lines the model
    // never received.
    if (isPartialRead(args)) return;
    const fp = await FileCache.stamp(path, cache.get(path));
    if (fp) cache.record(path, fp);
  }
}
