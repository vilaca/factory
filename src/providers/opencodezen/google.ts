// Google-Native (generateContent / streamGenerateContent SSE) route
// adapter for OpenCode Zen. Zen exposes Gemini models via Google's
// native API rather than an OpenAI-compatible shim, so the request/
// response shapes (functionCall / functionResponse / candidates) are
// preserved here. Translation happens at the boundary so the
// orchestrator can stay route-agnostic.

import type { ChatChunk, ChatMessage, ChatOptions, ToolCallMessage, ToolDefinition } from '../types.js';
import { parseToolArgs } from './models.js';

const PROVIDER_NAME = 'OpenCode Zen';

interface GoogleStreamPart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
}

interface GoogleStreamCandidate {
  content?: { parts?: GoogleStreamPart[] };
  finishReason?: string;
}

interface GoogleStreamPayload {
  candidates?: GoogleStreamCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export function googleEndpoint(baseUrl: string, model: string, stream: boolean): string {
  const suffix = stream ? ':streamGenerateContent?alt=sse' : ':generateContent';
  return `${baseUrl}/models/${model}${suffix}`;
}

export function googleHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
    Accept: 'application/json',
  };
}

/** Convert ChatMessages into Google's `contents` + `systemInstruction` shape. */
export function formatGoogleMessages(messages: ChatMessage[]): {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }>;
} {
  const systemParts: Array<{ text: string }> = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];
  const toolCallNames = new Map<string, string>();

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) {
        systemParts.push({ text: message.content });
      }
      continue;
    }

    if (message.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      if (message.content) {
        parts.push({ text: message.content });
      }
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.id) {
          toolCallNames.set(toolCall.id, toolCall.function.name);
        }
        parts.push({
          functionCall: {
            name: toolCall.function.name,
            args: toolCall.function.arguments,
          },
        });
      }
      if (parts.length > 0) {
        contents.push({ role: 'model', parts });
      }
      continue;
    }

    if (message.role === 'tool') {
      const toolName = message.tool_call_id ? toolCallNames.get(message.tool_call_id) : undefined;
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: toolName ?? 'tool',
              response: { content: message.content },
            },
          },
        ],
      });
      continue;
    }

    contents.push({
      role: 'user',
      parts: [{ text: message.content }],
    });
  }

  return {
    systemInstruction: systemParts.length > 0 ? { parts: systemParts } : undefined,
    contents,
  };
}

export function buildGoogleBody(
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  options: ChatOptions | undefined,
): Record<string, unknown> {
  const { systemInstruction, contents } = formatGoogleMessages(messages);
  const body: Record<string, unknown> = { contents };

  if (systemInstruction) {
    body.systemInstruction = systemInstruction;
  }
  if (tools && tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: tools.map(tool => ({
          name: tool.function.name,
          description: tool.function.description ?? '',
          parameters: tool.function.parameters,
        })),
      },
    ];
  }

  const generationConfig: Record<string, unknown> = {};
  if (options?.maxTokens) {
    generationConfig.maxOutputTokens = options.maxTokens;
  }
  if (options?.temperature !== undefined) {
    generationConfig.temperature = options.temperature;
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  return body;
}

export function extractGoogleUsage(data: GoogleStreamPayload | undefined): ChatChunk['usage'] {
  if (!data?.usageMetadata) return undefined;
  const promptTokens = data.usageMetadata.promptTokenCount ?? 0;
  const completionTokens = data.usageMetadata.candidatesTokenCount ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: data.usageMetadata.totalTokenCount ?? promptTokens + completionTokens,
  };
}

export function extractGoogleResponseParts(
  data: GoogleStreamPayload,
  seenToolCalls: Set<string>,
  startIndex: number,
): { content: string; toolCalls: ToolCallMessage[]; nextToolIndex: number } {
  const parts: GoogleStreamPart[] =
    data?.candidates?.flatMap(candidate => candidate?.content?.parts ?? []) ?? [];
  let content = '';
  const toolCalls: ToolCallMessage[] = [];
  let nextToolIndex = startIndex;

  for (const part of parts) {
    if (typeof part?.text === 'string') {
      content += part.text;
    }

    const functionCall = part?.functionCall;
    if (!functionCall?.name) {
      continue;
    }

    const args = normalizeGoogleFunctionArgs(functionCall.args);
    const signature = `${functionCall.name}:${JSON.stringify(args)}`;
    if (seenToolCalls.has(signature)) {
      continue;
    }

    seenToolCalls.add(signature);
    nextToolIndex += 1;
    toolCalls.push({
      id: `call_${nextToolIndex}`,
      function: {
        name: functionCall.name,
        arguments: args,
      },
    });
  }

  return { content, toolCalls, nextToolIndex };
}

function normalizeGoogleFunctionArgs(args: unknown): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === 'string') {
    return parseToolArgs(args);
  }
  if (typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

export async function* chatGoogleStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  options: ChatOptions | undefined,
): AsyncGenerator<ChatChunk> {
  const res = await fetch(googleEndpoint(baseUrl, model, true), {
    method: 'POST',
    headers: googleHeaders(apiKey),
    body: JSON.stringify(buildGoogleBody(messages, tools, options)),
    signal: options?.signal,
  });

  if (!res.ok) {
    throw new Error(`${PROVIDER_NAME} API error ${res.status}: ${await res.text()}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let usage: ChatChunk['usage'];
  const seenToolCalls = new Set<string>();
  let toolIndex = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      let parsed: GoogleStreamPayload;
      try {
        parsed = JSON.parse(trimmed.slice(6)) as GoogleStreamPayload;
      } catch {
        continue;
      }

      usage = extractGoogleUsage(parsed) ?? usage;
      const { content, toolCalls, nextToolIndex } = extractGoogleResponseParts(
        parsed,
        seenToolCalls,
        toolIndex,
      );
      toolIndex = nextToolIndex;

      if (content) {
        yield { content };
      }
      if (toolCalls.length > 0) {
        yield { tool_calls: toolCalls };
      }

      if (parsed.candidates?.some(candidate => !!candidate?.finishReason)) {
        yield { done: true, usage };
      }
    }
  }
}

export async function chatGoogleNoStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  options: ChatOptions | undefined,
): Promise<ChatChunk> {
  const res = await fetch(googleEndpoint(baseUrl, model, false), {
    method: 'POST',
    headers: googleHeaders(apiKey),
    body: JSON.stringify(buildGoogleBody(messages, tools, options)),
    signal: options?.signal,
  });

  if (!res.ok) {
    throw new Error(`${PROVIDER_NAME} API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as GoogleStreamPayload;
  const { content, toolCalls } = extractGoogleResponseParts(data, new Set<string>(), 0);
  return {
    content: content || undefined,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    done: true,
    usage: extractGoogleUsage(data),
  };
}
