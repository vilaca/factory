import type { ToolCallMessage } from '../types.js';
import { parseToolArgs } from '../shared.js';
export { parseToolArgs };

interface ToolCallAcc {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
    __rawArgs?: string;
  };
}

export type StreamingToolCallAcc = ToolCallAcc[];

/** Shape of a streamed tool-call delta from OpenAI-compatible providers. */
export interface StreamedToolCallDelta {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export function mergeStreamedToolCalls(
  target: StreamingToolCallAcc,
  incoming: StreamedToolCallDelta[],
): void {
  for (const tc of incoming) {
    const idx = tc.index ?? 0;
    target[idx] ??= {
      id: tc.id,
      function: { name: '', arguments: {} },
    };
    if (tc.function?.name) {
      target[idx]!.function.name += tc.function.name;
    }
    if (tc.function?.arguments) {
      target[idx]!.function.__rawArgs =
        (target[idx]!.function.__rawArgs ?? '') + tc.function.arguments;
    }
  }
}

export function finalizeToolCalls(toolCalls: StreamingToolCallAcc): ToolCallMessage[] {
  return toolCalls.flatMap(tc => {
    if (!tc?.function || !tc.function.name) {
      return [];
    }
    return [
      {
        id: tc.id,
        function: {
          name: tc.function.name,
          arguments: parseToolArgs(tc.function.__rawArgs),
        },
      },
    ];
  });
}

