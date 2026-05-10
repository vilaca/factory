import type { ChatChunk, ToolCallMessage } from '../types.js';
import { parseSseStream } from './sse.js';
import { parseToolArgs } from './tool-calls.js';
import {
  appendArgsDelta,
  finalizeResponsesToolCalls,
  noteArgsDone,
  noteFunctionCallItem,
  type ResponsesToolCallAcc,
} from './responses-tool-calls.js';
import { extractResponsesUsage, type ResponsesUsageEnvelope } from './responses-usage.js';

interface OpenAiChatRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  providerName: string;
}

interface ResponsesStreamEvent {
  type?: string;
  output_index?: number;
  item_id?: string;
  delta?: string;
  refusal?: string;
  text?: string;
  name?: string;
  arguments?: string;
  message?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
  };
  response?: ResponsesUsageEnvelope & {
    id?: string;
    error?: { message?: string };
    output?: Array<{
      type?: string;
      role?: string;
      id?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };
}

interface DispatchState {
  toolCalls: ResponsesToolCallAcc;
  usage: ChatChunk['usage'];
  responseId: string | undefined;
  providerName: string;
}

/** Apply one parsed SSE event to the accumulator state and emit any
 *  user-visible content delta. Throwing here rejects the outer generator
 *  so terminal errors propagate correctly. Pulled out of the main stream
 *  loop so the loop's complexity stays under the project's lint cap. */
function dispatchResponsesEvent(
  ev: ResponsesStreamEvent,
  state: DispatchState,
): string | undefined {
  switch (ev.type) {
    case 'response.output_item.added':
      if (ev.item?.type === 'function_call' && typeof ev.output_index === 'number') {
        noteFunctionCallItem(state.toolCalls, ev.output_index, {
          call_id: ev.item.call_id,
          name: ev.item.name,
        });
      }
      return undefined;
    case 'response.output_text.delta':
    case 'response.refusal.delta':
      return ev.delta;
    case 'response.function_call_arguments.delta':
      if (typeof ev.output_index === 'number' && ev.delta) {
        appendArgsDelta(state.toolCalls, ev.output_index, ev.delta);
      }
      return undefined;
    case 'response.function_call_arguments.done':
      if (typeof ev.output_index === 'number') {
        noteArgsDone(state.toolCalls, ev.output_index, {
          name: ev.name,
          arguments: ev.arguments,
        });
      }
      return undefined;
    case 'response.completed':
      state.usage = extractResponsesUsage(ev.response);
      if (ev.response?.id) state.responseId = ev.response.id;
      return undefined;
    case 'response.failed':
    case 'response.incomplete':
    case 'response.error': {
      // TODO(retry): Consider tagging SSE terminal failures (response.failed /
      // response.error) as transient when OpenAI reports internal/server-side
      // issues, so call-model retry can re-attempt instead of treating this as
      // a generic non-retryable message-only error.
      const msg = ev.response?.error?.message ?? ev.message ?? 'unknown error';
      throw new Error(`${state.providerName} API error: ${msg}`);
    }
    default:
      return undefined;
  }
}

/**
 * Stream a /v1/responses SSE channel and yield ChatChunks shaped like
 * the chat-completions stream (text deltas, then a trailing tool_calls
 * + done + usage chunk). Codex / gpt-5-codex are responses-API only;
 * the chat-completions endpoint returns 404 for them.
 */
export async function* streamOpenAiResponses(req: OpenAiChatRequest): AsyncGenerator<ChatChunk> {
  const headers = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    ...req.headers,
  };
  const res = await fetch(req.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(req.body),
    signal: req.signal,
  });

  if (!res.ok) {
    throw new Error(`${req.providerName} API error ${res.status}: ${await res.text()}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const state: DispatchState = {
    toolCalls: new Map(),
    usage: undefined,
    responseId: undefined,
    providerName: req.providerName,
  };

  try {
    for await (const parsed of parseSseStream(reader)) {
      const content = dispatchResponsesEvent(parsed as ResponsesStreamEvent, state);
      if (content) yield { content };
    }

    const finalized = finalizeResponsesToolCalls(state.toolCalls);
    const terminal: ChatChunk = { done: true };
    if (state.usage) terminal.usage = state.usage;
    // Surface responseId only when the response was actually persisted
    // server-side. With store=false the API still returns an id, but it
    // can't be used as `previous_response_id` on a later call (404). Keep
    // this policy at the wire-format boundary so chainRef on the agent
    // side never holds an unreferenceable id.
    if (state.responseId && isChainable(req.body)) terminal.responseId = state.responseId;
    if (finalized.length > 0) terminal.tool_calls = finalized;
    yield terminal;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already-cancelled or stream errored */
    }
  }
}

interface ResponsesNonStreamResponse extends ResponsesUsageEnvelope {
  id?: string;
  output?: Array<{
    type?: string;
    role?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { message?: string };
}

/** One-shot non-streaming /v1/responses call. Walks `output[]` and returns
 *  a single ChatChunk with content, optional tool_calls, and usage. */
export async function sendOpenAiResponses(req: OpenAiChatRequest): Promise<ChatChunk> {
  const headers = { 'Content-Type': 'application/json', ...req.headers };
  const res = await fetch(req.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(req.body),
    signal: req.signal,
  });

  if (!res.ok) {
    throw new Error(`${req.providerName} API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as ResponsesNonStreamResponse;

  let content = '';
  const tcs: ToolCallMessage[] = [];
  for (const item of data.output ?? []) {
    if (item.type === 'message' && item.content) {
      for (const part of item.content) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          content += part.text;
        }
      }
    } else if (item.type === 'function_call' && typeof item.name === 'string' && item.name) {
      tcs.push({
        id: item.call_id,
        function: {
          name: item.name,
          arguments: parseToolArgs(item.arguments),
        },
      });
    }
  }

  const result: ChatChunk = {
    done: true,
    usage: extractResponsesUsage(data),
  };
  // Mirror the streaming path: skip responseId when store=false so the agent
  // chainRef never captures an unreferenceable id (see streamOpenAiResponses).
  if (data.id && isChainable(req.body)) result.responseId = data.id;
  if (content) result.content = content;
  if (tcs.length > 0) result.tool_calls = tcs;
  return result;
}

/** True when the request body permits a future call to chain via
 *  `previous_response_id`. The Responses API returns a response id even when
 *  `store: false`, but the id can't be referenced later — surfacing it would
 *  poison the agent-layer chain pointer. */
function isChainable(body: Record<string, unknown>): boolean {
  return body.store !== false;
}
