import type { ToolCallMessage } from '../types.js';
import { parseToolArgs } from './tool-calls.js';

interface ResponsesToolCallEntry {
  callId?: string;
  name?: string;
  rawArgs: string;
}

/** Tool-call accumulator for the Responses API stream. Keyed by
 *  `output_index` because every relevant event carries it; `item_id` is
 *  unique per call but only on `output_item.added`. The chat-completions
 *  accumulator can't be reused: chat emits indexed `tool_calls` deltas;
 *  Responses emits separate item-add and argument-delta events. */
export type ResponsesToolCallAcc = Map<number, ResponsesToolCallEntry>;

export function noteFunctionCallItem(
  acc: ResponsesToolCallAcc,
  outputIndex: number,
  item: { call_id?: string; name?: string },
): void {
  const entry = acc.get(outputIndex) ?? { rawArgs: '' };
  if (item.call_id) entry.callId = item.call_id;
  if (item.name) entry.name = item.name;
  acc.set(outputIndex, entry);
}

export function appendArgsDelta(
  acc: ResponsesToolCallAcc,
  outputIndex: number,
  delta: string,
): void {
  const entry = acc.get(outputIndex) ?? { rawArgs: '' };
  entry.rawArgs += delta;
  acc.set(outputIndex, entry);
}

export function noteArgsDone(
  acc: ResponsesToolCallAcc,
  outputIndex: number,
  meta: { name?: string; arguments?: string },
): void {
  const entry = acc.get(outputIndex) ?? { rawArgs: '' };
  if (meta.name && !entry.name) entry.name = meta.name;
  // The done event sometimes carries the full arguments string — adopt it
  // when our incremental buffer is empty (some servers skip the deltas).
  if (meta.arguments && !entry.rawArgs) entry.rawArgs = meta.arguments;
  acc.set(outputIndex, entry);
}

export function finalizeResponsesToolCalls(acc: ResponsesToolCallAcc): ToolCallMessage[] {
  const indexes = [...acc.keys()].sort((a, b) => a - b);
  const out: ToolCallMessage[] = [];
  for (const i of indexes) {
    const entry = acc.get(i)!;
    if (!entry.name) continue;
    out.push({
      id: entry.callId,
      function: {
        name: entry.name,
        arguments: parseToolArgs(entry.rawArgs),
      },
    });
  }
  return out;
}
