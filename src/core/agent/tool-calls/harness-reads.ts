import { TOOL_NAMES } from '../../../tools/host.js';
import type { ToolCallMessage } from '../../../providers/types.js';
import type { AgentEvent } from '../types.js';
import type { ToolLoopContext } from './types.js';
import { tryReadCacheHit, maintainFileCache } from './run-tool-calls-cache.js';
import { executeToolCall } from './run-tool-calls-execute.js';

function makeHarnessReadToolCall(filePath: string, index: number): ToolCallMessage {
  return {
    id: `harness-scoped-read-${Date.now()}-${index}`,
    function: {
      name: TOOL_NAMES.Read,
      arguments: { file_path: filePath },
    },
  };
}

export async function* runHarnessScopedInstructionReads(
  files: readonly string[],
  ctx: ToolLoopContext,
): AsyncGenerator<AgentEvent> {
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]!;
    const toolCall = makeHarnessReadToolCall(filePath, i);

    if (!ctx.useUserResultFraming) {
      // Keep assistant tool_call ↔ tool_result pairing valid for providers
      // that expect structured tool call messages.
      ctx.conversation.addAssistant('', [toolCall]);
    }

    const synthetic = yield* tryReadCacheHit(toolCall, ctx);
    if (synthetic) continue;

    for await (const event of executeToolCall(toolCall, ctx, { skipPermissionCheck: true })) {
      if (event.type === 'tool-call-result' && event.result.success && ctx.fileCache) {
        await maintainFileCache(toolCall, ctx.fileCache);
      }
      yield event;
    }
  }
}
