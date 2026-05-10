import type { ChatChunk, ToolCallMessage } from '../types.js';
import { apiError } from './errors.js';
import { parseSseStream } from './sse.js';
import {
  finalizeToolCalls,
  mergeStreamedToolCalls,
  parseToolArgs,
  type StreamedToolCallDelta,
  type StreamingToolCallAcc,
} from './tool-calls.js';
import { extractUsage, type OpenAiCompatUsageEnvelope } from './usage.js';

interface OpenAiChatRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  providerName: string;
}

/** OpenAI-compatible streaming chunk shape used by every provider that
 *  speaks the /chat/completions SSE protocol. */
interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: StreamedToolCallDelta[];
    };
    finish_reason?: string;
  }>;
}

interface OpenAiNonStreamMessage {
  content?: string | null;
  tool_calls?: Array<{
    id?: string;
    function?: {
      name?: string;
      arguments?: string | Record<string, unknown>;
    };
  }>;
}

interface OpenAiNonStreamResponse extends OpenAiCompatUsageEnvelope {
  choices?: Array<{
    message?: OpenAiNonStreamMessage;
    finish_reason?: string;
  }>;
}

/**
 * Stream a /chat/completions response and yield ChatChunks.
 *
 * Yields a `done: true` chunk when a finish_reason arrives and forwards it as
 * `doneReason` (`stop`, `tool_calls`, `length`, etc.) so the agent layer can
 * react (e.g. truncation retry on `length`).
 */
export async function* streamOpenAiChat(req: OpenAiChatRequest): AsyncGenerator<ChatChunk> {
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
    throw apiError(req.providerName, res.status, await res.text());
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  let toolCalls: StreamingToolCallAcc | undefined;

  // try/finally so an early exit (consumer break, downstream throw, signal
  // abort propagating after fetch's body becomes unreadable) cancels the
  // reader and releases its lock on the response body. Without this, an
  // abandoned stream holds the underlying connection open until GC.
  try {
    for await (const parsed of parseSseStream(reader)) {
      const p = parsed as OpenAiStreamChunk & OpenAiCompatUsageEnvelope;
      const delta = p.choices?.[0]?.delta;

      if (delta?.content) {
        yield { content: delta.content };
      }

      if (delta?.tool_calls) {
        toolCalls ??= [];
        mergeStreamedToolCalls(toolCalls, delta.tool_calls);
      }

      const finishReason = p.choices?.[0]?.finish_reason;
      if (typeof finishReason === 'string') {
        yield { done: true, doneReason: finishReason, usage: extractUsage(p) };
      }
    }

    if (toolCalls && toolCalls.length > 0) {
      const finalized = finalizeToolCalls(toolCalls);
      if (finalized.length > 0) {
        yield { tool_calls: finalized, done: true };
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already-cancelled or stream errored */
    }
  }
}

/**
 * One-shot non-streaming /chat/completions call. Returns a single ChatChunk
 * with content, optional tool_calls, and usage.
 */
export async function sendOpenAiChat(req: OpenAiChatRequest): Promise<ChatChunk> {
  const headers = { 'Content-Type': 'application/json', ...req.headers };
  const res = await fetch(req.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(req.body),
    signal: req.signal,
  });

  if (!res.ok) {
    throw apiError(req.providerName, res.status, await res.text());
  }

  const data = (await res.json()) as OpenAiNonStreamResponse;
  const choice = data.choices?.[0];
  const result: ChatChunk = {
    content: choice?.message?.content ?? undefined,
    done: true,
    doneReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
    usage: extractUsage(data),
  };

  if (choice?.message?.tool_calls) {
    const tcs: ToolCallMessage[] = choice.message.tool_calls.flatMap(tc => {
      if (!tc?.function || typeof tc.function.name !== 'string' || !tc.function.name) {
        return [];
      }
      const args =
        typeof tc.function.arguments === 'string'
          ? parseToolArgs(tc.function.arguments)
          : (tc.function.arguments ?? {});
      return [
        {
          id: tc.id,
          function: {
            name: tc.function.name,
            arguments: args,
          },
        },
      ];
    });
    if (tcs.length > 0) result.tool_calls = tcs;
  }

  return result;
}
