import type { ToolCallMessage } from '../types.js';

interface ToolCallAcc {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
    __rawArgs?: string;
  };
}

export type StreamingToolCallAcc = ToolCallAcc[];

export function mergeStreamedToolCalls(target: StreamingToolCallAcc, incoming: any[]): void {
  for (const tc of incoming) {
    const idx = tc.index ?? 0;
    if (!target[idx]) {
      target[idx] = {
        id: tc.id,
        function: { name: '', arguments: {} },
      };
    }
    if (tc.function?.name) {
      target[idx].function.name += tc.function.name;
    }
    if (tc.function?.arguments) {
      target[idx].function.__rawArgs =
        (target[idx].function.__rawArgs ?? '') + tc.function.arguments;
    }
  }
}

export function finalizeToolCalls(toolCalls: StreamingToolCallAcc): ToolCallMessage[] {
  return toolCalls.flatMap(tc => {
    if (!tc?.function || !tc.function.name) {
      return [];
    }
    return [{
      id: tc.id,
      function: {
        name: tc.function.name,
        arguments: parseToolArgs(tc.function.__rawArgs),
      },
    }];
  });
}

export function parseToolArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}
