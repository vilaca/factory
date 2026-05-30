import type { ChatChunk, ToolCallMessage } from '../types.js';
import { apiError } from './errors.js';
import { parseSseStream } from './sse.js';
import {
  createLinkedAbortController,
  isIdleTimeoutFailure,
  openAiSseIdleTimeoutMs,
  OpenAiSseIdleAbortReason,
} from './stream-common.js';
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
    error?: { message?: string; type?: string; code?: string };
    incomplete_details?: { reason?: string };
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
  /** Set when a terminal SSE event signals a non-error stop reason (e.g.
   *  `response.incomplete` with `incomplete_details.reason === 'max_output_tokens'`).
   *  Surfaced as `doneReason` on the terminal chunk so the agent layer's
   *  length-truncation path fires — same shape as chat-completions'
   *  `finish_reason: 'length'`. Undefined for normal completion. */
  doneReason: string | undefined;
}

/** Map an OpenAI SSE error envelope to an HTTP-style status so the retry
 *  classifier in `call-model/provider-retry.ts` and the rotation classifier
 *  in `call-model/provider-errors.ts` can decide whether to back off on the
 *  same key vs. rotate to a different one. Aligned with
 *  https://developers.openai.com/api/docs/guides/error-codes.md.
 *
 *  OpenAI's standard error envelope overloads `type: 'invalid_request_error'`
 *  for several distinct HTTP statuses — `{type:'invalid_request_error',
 *  code:'invalid_api_key'}` is 401, `code:'model_not_found'` is 404,
 *  generic-shape errors are 400. So we consult `code` first (unambiguous)
 *  and only fall back to `type` (general category) when no specific code
 *  matched. Unknown errors default to 500 (`InternalServerError`, retryable
 *  per OpenAI guidance) — better than the previous "no status, never
 *  retries" behavior and consistent with treating mid-stream failures as
 *  transient by default. */
function sseErrorStatus(err: { type?: string; code?: string } | undefined): number {
  const code = err?.code ?? '';
  if (code === 'invalid_api_key' || code === 'account_deactivated') return 401;
  if (code === 'rate_limit_exceeded' || code === 'insufficient_quota') return 429;
  if (code === 'model_not_found') return 404;
  if (code === 'server_error') return 500;

  const type = err?.type ?? '';
  if (type === 'authentication_error') return 401;
  if (type === 'permission_error') return 403;
  if (type === 'rate_limit_error' || type === 'rate_limit_exceeded') return 429;
  if (type === 'server_error') return 500;
  if (type === 'invalid_request_error' || type === 'invalid_request') return 400;
  return 500;
}

/** Handle the tool-call lifecycle events. Splits out of dispatchResponsesEvent
 *  to keep the dispatcher's branch count under the lint cap. */
function applyToolCallEvent(ev: ResponsesStreamEvent, state: DispatchState): void {
  switch (ev.type) {
    case 'response.output_item.added':
      if (ev.item?.type === 'function_call' && typeof ev.output_index === 'number') {
        noteFunctionCallItem(state.toolCalls, ev.output_index, {
          call_id: ev.item.call_id,
          name: ev.item.name,
        });
      }
      return;
    case 'response.function_call_arguments.delta':
      if (typeof ev.output_index === 'number' && ev.delta) {
        appendArgsDelta(state.toolCalls, ev.output_index, ev.delta);
      }
      return;
    case 'response.function_call_arguments.done':
      if (typeof ev.output_index === 'number') {
        noteArgsDone(state.toolCalls, ev.output_index, {
          name: ev.name,
          arguments: ev.arguments,
        });
      }
  }
}

/** Handle terminal events (completed / incomplete / failed / error). May
 *  throw to reject the outer generator on real failures. */
function applyTerminalEvent(ev: ResponsesStreamEvent, state: DispatchState): void {
  switch (ev.type) {
    case 'response.completed':
      state.usage = extractResponsesUsage(ev.response);
      if (ev.response?.id) state.responseId = ev.response.id;
      return;
    case 'response.incomplete': {
      // The Responses API signals truncation via `response.incomplete` with
      // an `incomplete_details.reason`. The `max_output_tokens` reason is the
      // SSE equivalent of chat-completions' `finish_reason: 'length'` — it's
      // a stop reason, not an error, and the agent layer already has a
      // length-truncation retry path keyed off `doneReason: 'length'`. We
      // therefore record the reason on the terminal chunk instead of throwing.
      // Other incomplete reasons (e.g. `content_filter`) are real failures and
      // are not retryable per OpenAI's BadRequestError guidance.
      const reason = ev.response?.incomplete_details?.reason;
      if (reason === 'max_output_tokens') {
        state.doneReason = 'length';
        if (ev.response) state.usage = extractResponsesUsage(ev.response);
        if (ev.response?.id) state.responseId = ev.response.id;
        return;
      }
      const msg = ev.response?.error?.message ?? reason ?? 'incomplete response';
      throw apiError(state.providerName, 400, msg);
    }
    case 'response.failed':
    case 'response.error': {
      // Tag SSE terminal failures with an HTTP-style status so the retry
      // classifier can decide based on the error type. Unknown error types
      // default to 500 (`InternalServerError`), which is what OpenAI's
      // error-codes guide tells callers to retry with backoff — and matches
      // the empirical pattern in the 2026-05-10 session log where a generic
      // "Internal server error" via response.error killed a turn that a
      // straight retry would have recovered.
      const msg = ev.response?.error?.message ?? ev.message ?? 'unknown error';
      const status = sseErrorStatus(ev.response?.error);
      throw apiError(state.providerName, status, msg);
    }
  }
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
    case 'response.output_text.delta':
    case 'response.refusal.delta':
    case 'response.reasoning_summary_text.delta':
      // Reasoning summaries are provider-redacted visibility text (safe to
      // surface, unlike raw chain-of-thought). Treat as normal text deltas.
      return ev.delta;
    case 'response.output_item.added':
    case 'response.function_call_arguments.delta':
    case 'response.function_call_arguments.done':
      applyToolCallEvent(ev, state);
      return undefined;
    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed':
    case 'response.error':
      applyTerminalEvent(ev, state);
      return undefined;
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
  const { controller, dispose } = createLinkedAbortController(req.signal);

  // TODO(stream/refactor-shared-runner): this fetch + SSE loop + idle-timeout
  // mapping + reader-cancel pattern is duplicated in stream.ts.
  // Extract a shared runner that takes an event dispatcher + terminalizer so
  // behavior stays aligned across both transports.
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });

    // TODO(observability/request-id): capture `x-request-id` from res.headers
    // and propagate it through ChatChunk + apiError so support tickets and
    // session logs can reference the OpenAI-side request id. Both
    // openai-node and openai-python surface it on every response; today we
    // discard it. Attach to apiError on the !res.ok path below as well.
    if (!res.ok) {
      throw apiError(req.providerName, res.status, await res.text(), res.headers);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const state: DispatchState = {
      toolCalls: new Map(),
      usage: undefined,
      responseId: undefined,
      providerName: req.providerName,
      doneReason: undefined,
    };

    try {
      for await (const parsed of parseSseStream(reader, {
        idleTimeoutMs: openAiSseIdleTimeoutMs(),
        onIdleTimeout: () => controller.abort(new OpenAiSseIdleAbortReason()),
      })) {
        const content = dispatchResponsesEvent(parsed as ResponsesStreamEvent, state);
        if (content) yield { content };
      }

      const finalized = finalizeResponsesToolCalls(state.toolCalls);
      const terminal: ChatChunk = { done: true };
      if (state.usage) terminal.usage = state.usage;
      if (state.doneReason) terminal.doneReason = state.doneReason;
      // Surface responseId only when the response was actually persisted
      // server-side. With store=false the API still returns an id, but it
      // can't be used as `previous_response_id` on a later call (404). Keep
      // this policy at the wire-format boundary so chainRef on the agent
      // side never holds an unreferenceable id.
      if (state.responseId && isChainable(req.body)) terminal.responseId = state.responseId;
      if (finalized.length > 0) terminal.tool_calls = finalized;
      yield terminal;
    } catch (error) {
      if (isIdleTimeoutFailure(error, controller)) {
        throw apiError(req.providerName, 504, 'OpenAI SSE stream stalled (idle timeout)');
      }
      throw error;
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already-cancelled or stream errored */
      }
    }
  } finally {
    dispose();
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
    throw apiError(req.providerName, res.status, await res.text(), res.headers);
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
 *  poison the agent-layer chain pointer.
 *
 *  TODO(encrypted-reasoning): finish the store:false reasoning continuity
 *  feature. Request side is done — when store:false, buildResponsesBody now
 *  sets `include: ["reasoning.encrypted_content"]`. Remaining work:
 *    (1) capture: in dispatchResponsesEvent, observe `response.output_item.done`
 *        events whose `item.type === "reasoning"` and stash item.encrypted_content
 *        plus the item shape onto DispatchState (new field encryptedReasoning).
 *    (2) terminal chunk: extend ChatChunk with optional encryptedReasoning and
 *        emit it on the terminal yield (parallel to how responseId is emitted).
 *    (3) chainRef shape: extend the agent-layer chain pointer (run-agent.ts)
 *        to carry either lastResponseId (store:true path) OR encryptedReasoning
 *        blobs (store:false path).
 *    (4) replay: in toResponsesInput / buildResponsesBody, when the chain
 *        carries encryptedReasoning instead of lastResponseId, prepend those
 *        reasoning items into the `input` array.
 *    (5) tests: parallel to the existing chained-turn tests in
 *        responses-stream.test.ts.
 *  Without (1)-(5) the include is sent but its output is dropped, so
 *  store:false sessions still lose the cache-hit (~40%→80%) and reasoning-
 *  reuse benchmark gains documented at
 *  https://developers.openai.com/cookbook/examples/responses_api/reasoning_items. */
function isChainable(body: Record<string, unknown>): boolean {
  return body.store !== false;
}
