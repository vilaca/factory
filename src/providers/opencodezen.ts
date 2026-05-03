import Anthropic from '@anthropic-ai/sdk';
import type {
  Provider, ChatMessage, ChatChunk, ToolDefinition,
  ToolCallMessage, ProviderCapabilities, ChatOptions, ModelInfo, ModelPickerInfo, ModelTier,
} from './types.js';
import { buildChatBody, sendOpenAiChat, streamOpenAiChat } from './_openai/index.js';

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1';
const PROVIDER_NAME = 'OpenCode Zen';
const MISSING_TOKEN_ERROR =
  'OpenCode Zen API key required. Set OPENCODE_ZEN_API_KEY or OPENCODE_API_KEY env var or use --token flag.';

type OpenCodeZenRoute = 'chat-completions' | 'anthropic-messages' | 'google-native' | 'openai-responses';

interface OpenCodeZenModel {
  id: string;
  owned_by?: string;
  route: OpenCodeZenRoute;
}

export class OpenCodeZenProvider implements Provider {
  name = 'opencodezen';
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private modelsCache: OpenCodeZenModel[] | null = null;
  private anthropicClient: Anthropic | null = null;

  constructor(options: { token?: string; host?: string } = {}) {
    this.apiKey = options.token ?? process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_API_KEY;
    this.baseUrl = normalizeBaseUrl(options.host ?? DEFAULT_BASE_URL);
  }

  async listModels(): Promise<string[]> {
    const models = await this.getCatalog();
    return [...new Set(models.map(model => model.id))];
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const match = this.modelsCache?.find(item => item.id === model);
    if (!match) {
      return { label: model };
    }

    return {
      label: model,
      detail: buildModelDetail(match.id),
      warning: buildModelWarning(match.id),
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    const route = this.modelsCache?.find(item => item.id === model)?.route ?? detectOpenCodeZenRoute(model);
    const supportsTools = route !== 'openai-responses' && supportsToolsByName(lower);

    return {
      contextWindow: estimateContextWindow(lower),
      maxOutputTokens: estimateMaxOutput(lower),
      toolSupport: supportsTools ? 'native' : 'none',
      parallelToolCalls: supportsTools,
      streaming: route !== 'openai-responses',
      tokenCounting: 'exact',
      modelTier: estimateModelTier(lower),
    };
  }

  async getModelInfo(model: string): Promise<ModelInfo> {
    await this.getCatalog();
    const lower = model.toLowerCase();
    const route = this.modelsCache?.find(item => item.id === model)?.route ?? detectOpenCodeZenRoute(model);
    return {
      supportsTools: route !== 'openai-responses' && supportsToolsByName(lower),
      capabilities: buildCapabilities(lower, route),
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    switch (detectOpenCodeZenRoute(model)) {
      case 'chat-completions':
        yield* this.chatCompletions(model, messages, tools, options);
        return;
      case 'anthropic-messages':
        yield* this.chatAnthropic(model, messages, tools, options);
        return;
      case 'google-native':
        yield* this.chatGoogle(model, messages, tools, options);
        return;
      case 'openai-responses':
        throw unsupportedOpenCodeZenRouteError(model);
    }
  }

  async chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    switch (detectOpenCodeZenRoute(model)) {
      case 'chat-completions':
        return this.chatCompletionsNoStream(model, messages, tools, options);
      case 'anthropic-messages':
        return this.chatAnthropicNoStream(model, messages, tools, options);
      case 'google-native':
        return this.chatGoogleNoStream(model, messages, tools, options);
      case 'openai-responses':
        throw unsupportedOpenCodeZenRouteError(model);
    }
  }

  private async *chatCompletions(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    // TODO: Zen's /models catalog currently includes some chat/completions models
    // that still fail at runtime (for example nemotron-3-super-free -> 500 and
    // trinity-large-preview-free -> wrapped provider 404). If Zen exposes route
    // or availability metadata, use it here to retry with the correct backend
    // instead of surfacing the raw gateway error.
    yield* streamOpenAiChat({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.requireOpenAiAuthHeaders(),
      body: buildChatBody({ model, messages, tools, stream: true, options, maxTokensField: 'max_tokens' }),
      signal: options?.signal,
      providerName: PROVIDER_NAME,
    });
  }

  private async chatCompletionsNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    return sendOpenAiChat({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.requireOpenAiAuthHeaders(),
      body: buildChatBody({ model, messages, tools, stream: false, options, maxTokensField: 'max_tokens' }),
      signal: options?.signal,
      providerName: PROVIDER_NAME,
    });
  }

  private requireOpenAiAuthHeaders(): Record<string, string> {
    if (!this.apiKey) {
      throw new Error(MISSING_TOKEN_ERROR);
    }
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async *chatAnthropic(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const { system, msgs } = this.splitAnthropicMessages(messages);

    const params: any = {
      model,
      max_tokens: options?.maxTokens ?? estimateMaxOutput(model.toLowerCase()),
      system: system ?? undefined,
      messages: msgs,
      stream: true,
    };

    if (tools && tools.length > 0) {
      params.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description ?? '',
        input_schema: t.function.parameters,
      }));
    }

    const stream = this.getAnthropicClient().messages.stream(params, {
      signal: options?.signal,
    });

    let currentToolCall: { id: string; name: string; rawArgs: string } | null = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block as any;
        if (block.type === 'tool_use') {
          currentToolCall = { id: block.id, name: block.name, rawArgs: '' };
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta as any;
        if (delta.type === 'text_delta') {
          yield { content: delta.text };
        } else if (delta.type === 'input_json_delta' && currentToolCall) {
          currentToolCall.rawArgs += delta.partial_json;
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolCall) {
          yield {
            tool_calls: [{
              id: currentToolCall.id,
              function: {
                name: currentToolCall.name,
                arguments: parseToolArgs(currentToolCall.rawArgs),
              },
            }],
          };
          currentToolCall = null;
        }
      } else if (event.type === 'message_stop') {
        yield { done: true };
      } else if (event.type === 'message_delta') {
        const delta = event as any;
        if (delta.usage) {
          yield {
            done: true,
            usage: {
              promptTokens: delta.usage.input_tokens ?? 0,
              completionTokens: delta.usage.output_tokens ?? 0,
              totalTokens: (delta.usage.input_tokens ?? 0) + (delta.usage.output_tokens ?? 0),
            },
          };
        }
      }
    }
  }

  private async chatAnthropicNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    const { system, msgs } = this.splitAnthropicMessages(messages);

    const params: any = {
      model,
      max_tokens: options?.maxTokens ?? estimateMaxOutput(model.toLowerCase()),
      system: system ?? undefined,
      messages: msgs,
    };

    if (tools && tools.length > 0) {
      params.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description ?? '',
        input_schema: t.function.parameters,
      }));
    }

    const response = await this.getAnthropicClient().messages.create(params, {
      signal: options?.signal,
    });

    let content = '';
    const toolCalls: ToolCallMessage[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          function: {
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          },
        });
      }
    }

    return {
      content: content || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      done: true,
      usage: {
        promptTokens: (response as any).usage?.input_tokens ?? 0,
        completionTokens: (response as any).usage?.output_tokens ?? 0,
        totalTokens: ((response as any).usage?.input_tokens ?? 0) + ((response as any).usage?.output_tokens ?? 0),
      },
    };
  }

  private async *chatGoogle(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const res = await fetch(this.googleEndpoint(model, true), {
      method: 'POST',
      headers: this.googleHeaders(),
      body: JSON.stringify(this.buildGoogleBody(messages, tools, options)),
      signal: options?.signal,
    });

    if (!res.ok) {
      throw new Error(`OpenCode Zen API error ${res.status}: ${await res.text()}`);
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

        let parsed: any;
        try {
          parsed = JSON.parse(trimmed.slice(6));
        } catch {
          continue;
        }

        usage = extractGoogleUsage(parsed) ?? usage;
        const { content, toolCalls, nextToolIndex } = extractGoogleResponseParts(parsed, seenToolCalls, toolIndex);
        toolIndex = nextToolIndex;

        if (content) {
          yield { content };
        }
        if (toolCalls.length > 0) {
          yield { tool_calls: toolCalls };
        }

        if (parsed.candidates?.some((candidate: any) => candidate?.finishReason)) {
          yield { done: true, usage };
        }
      }
    }
  }

  private async chatGoogleNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    const res = await fetch(this.googleEndpoint(model, false), {
      method: 'POST',
      headers: this.googleHeaders(),
      body: JSON.stringify(this.buildGoogleBody(messages, tools, options)),
      signal: options?.signal,
    });

    if (!res.ok) {
      throw new Error(`OpenCode Zen API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as any;
    const { content, toolCalls } = extractGoogleResponseParts(data, new Set<string>(), 0);
    return {
      content: content || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      done: true,
      usage: extractGoogleUsage(data),
    };
  }

  private googleHeaders(): Record<string, string> {
    if (!this.apiKey) {
      throw new Error(MISSING_TOKEN_ERROR);
    }

    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey,
      'Accept': 'application/json',
    };
  }

  private buildGoogleBody(
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    options?: ChatOptions,
  ): Record<string, unknown> {
    const { systemInstruction, contents } = this.formatGoogleMessages(messages);
    const body: Record<string, unknown> = { contents };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }
    if (tools && tools.length > 0) {
      body.tools = [{
        functionDeclarations: tools.map(tool => ({
          name: tool.function.name,
          description: tool.function.description ?? '',
          parameters: tool.function.parameters,
        })),
      }];
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

  private formatGoogleMessages(messages: ChatMessage[]): {
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
          parts: [{
            functionResponse: {
              name: toolName ?? 'tool',
              response: { content: message.content },
            },
          }],
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

  private splitAnthropicMessages(messages: ChatMessage[]): { system: string | null; msgs: any[] } {
    let system: string | null = null;
    const msgs: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = msg.content;
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        const content: any[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id ?? `toolu_${Math.random().toString(36).slice(2, 14)}`,
            name: tc.function.name,
            input: tc.function.arguments,
          });
        }
        msgs.push({ role: 'assistant', content });
      } else if (msg.role === 'tool') {
        const lastAssistant = msgs[msgs.length - 1];
        let toolUseId = 'unknown';
        if (lastAssistant?.role === 'assistant') {
          const blocks = Array.isArray(lastAssistant.content) ? lastAssistant.content : [];
          const toolUse = blocks.findLast?.((block: any) => block.type === 'tool_use');
          if (toolUse) toolUseId = toolUse.id;
        }
        msgs.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: msg.content,
          }],
        });
      } else {
        msgs.push({ role: msg.role, content: msg.content });
      }
    }

    return { system, msgs };
  }

  private getAnthropicClient(): Anthropic {
    if (!this.apiKey) {
      throw new Error(MISSING_TOKEN_ERROR);
    }
    if (!this.anthropicClient) {
      this.anthropicClient = new Anthropic({
        apiKey: this.apiKey,
        baseURL: this.baseUrl.replace(/\/v1$/, ''),
      });
    }
    return this.anthropicClient;
  }

  private googleEndpoint(model: string, stream: boolean): string {
    const suffix = stream ? ':streamGenerateContent?alt=sse' : ':generateContent';
    return `${this.baseUrl}/models/${model}${suffix}`;
  }

  private async getCatalog(): Promise<OpenCodeZenModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
    });

    if (!res.ok) {
      throw new Error(`OpenCode Zen API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as any;
    const rawItems = Array.isArray(data?.data) ? data.data : [];
    this.modelsCache = rawItems
      // Note: hide Zen models that route through OpenAI's /responses API until
      // the provider layer can preserve Responses-native events and tool items.
      .filter((item: any) => isSupportedOpenCodeZenModel(item))
      .map((item: any) => ({
        id: item.id,
        owned_by: typeof item.owned_by === 'string' ? item.owned_by : undefined,
        route: detectOpenCodeZenRoute(item.id),
      }));

    return this.modelsCache ?? [];
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function isSupportedOpenCodeZenModel(item: any): item is { id: string; owned_by?: string } {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) {
    return false;
  }
  return detectOpenCodeZenRoute(item.id) !== 'openai-responses';
}

function detectOpenCodeZenRoute(model: string): OpenCodeZenRoute {
  const id = model.toLowerCase();
  if (id.startsWith('claude-')) {
    return 'anthropic-messages';
  }
  if (id.startsWith('gemini-')) {
    return 'google-native';
  }
  // TODO: Add Zen /responses support for GPT models once the provider layer can
  // preserve Responses API streaming items and tool events without flattening
  // them into chat-completions semantics.
  if (id.startsWith('gpt-')) {
    return 'openai-responses';
  }
  return 'chat-completions';
}

function unsupportedOpenCodeZenRouteError(model: string): Error {
  return new Error(
    `OpenCode Zen model "${model}" uses the /responses API, which this CLI does not support yet.`
  );
}

function buildModelDetail(modelId: string): string {
  const lower = modelId.toLowerCase();
  const details: string[] = [];
  details.push(isFreeModel(lower) ? 'free' : 'paid');
  details.push(supportsVisionByName(lower) ? 'vision' : 'text-only');
  details.push(supportsToolsByName(lower) ? 'tools' : 'no tools');
  if (supportsReasoningByName(lower)) {
    details.push('reasoning');
  }
  details.push(`max ${formatTokenCount(estimateMaxOutput(lower))} out`);
  details.push(`${formatTokenCount(estimateContextWindow(lower))} ctx`);
  return details.join(' · ');
}

function buildModelWarning(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  if (lower.includes('preview')) return 'preview';
  if (lower.includes('deprecated')) return 'deprecated';
  return undefined;
}

function buildCapabilities(model: string, route: OpenCodeZenRoute): string[] {
  const capabilities: string[] = [];
  capabilities.push(supportsVisionByName(model) ? 'vision' : 'text');
  if (supportsToolsByName(model) && route !== 'openai-responses') {
    capabilities.push('tool-use');
  }
  if (supportsReasoningByName(model)) {
    capabilities.push('reasoning');
  }
  if (isFreeModel(model)) {
    capabilities.push('free');
  }
  return capabilities;
}

function estimateModelTier(model: string): ModelTier {
  if (
    model.includes('qwen3.6-plus') ||
    model.includes('kimi-k2.6') ||
    model.includes('glm-5.1') ||
    model.includes('big-pickle') ||
    model.includes('claude-opus') ||
    model.includes('claude-sonnet') ||
    model.includes('gemini-3.1-pro')
  ) {
    return 'strong';
  }
  if (
    model.includes('qwen3.5-plus') ||
    model.includes('kimi-k2.5') ||
    model.includes('minimax-m2.7') ||
    model.includes('minimax-m2.5') ||
    model.includes('ling-2.6') ||
    model.includes('claude-haiku') ||
    model.includes('gemini-3-flash')
  ) {
    return 'medium';
  }
  return 'weak';
}

function estimateContextWindow(model: string): number {
  if (model.includes('qwen3.6-plus') || model.includes('qwen3.5-plus')) return 262144;
  if (model.includes('claude-')) return 200000;
  if (model.includes('gemini-3.1-pro')) return 1048576;
  if (model.includes('gemini-3-flash')) return 1048576;
  if (model.includes('glm-5.1') || model.includes('glm-5')) return 128000;
  if (model.includes('kimi-k2.6') || model.includes('kimi-k2.5')) return 256000;
  if (model.includes('big-pickle')) return 256000;
  if (model.includes('minimax-m2.7') || model.includes('minimax-m2.5')) return 128000;
  return 128000;
}

function estimateMaxOutput(model: string): number {
  if (model.includes('qwen3.6-plus')) return 65536;
  if (model.includes('claude-opus')) return 32000;
  if (model.includes('claude-sonnet')) return 16000;
  if (model.includes('claude-haiku')) return 8192;
  if (model.includes('gemini-')) return 65536;
  if (model.includes('qwen3.5-plus') || model.includes('kimi-k2.6') || model.includes('kimi-k2.5')) return 32768;
  if (model.includes('glm-5.1') || model.includes('glm-5') || model.includes('big-pickle')) return 32768;
  return 8192;
}

function supportsToolsByName(_model: string): boolean {
  return true;
}

function supportsVisionByName(model: string): boolean {
  return model.includes('hy3') || model.includes('gemini-');
}

function supportsReasoningByName(model: string): boolean {
  return (
    model.includes('qwen') ||
    model.includes('kimi') ||
    model.includes('glm') ||
    model.includes('nemotron') ||
    model.includes('trinity') ||
    model.includes('claude') ||
    model.includes('gemini')
  );
}

function isFreeModel(model: string): boolean {
  return model.includes('free') || model === 'big-pickle';
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions.toFixed(millions % 1 === 0 ? 0 : 1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands.toFixed(thousands % 1 === 0 ? 0 : 1).replace(/\.0$/, '')}k`;
  }
  return String(value);
}

function parseToolArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function extractGoogleUsage(data: any): ChatChunk['usage'] {
  if (!data?.usageMetadata) return undefined;
  const promptTokens = data.usageMetadata.promptTokenCount ?? 0;
  const completionTokens = data.usageMetadata.candidatesTokenCount ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: data.usageMetadata.totalTokenCount ?? (promptTokens + completionTokens),
  };
}

function extractGoogleResponseParts(
  data: any,
  seenToolCalls: Set<string>,
  startIndex: number,
): { content: string; toolCalls: ToolCallMessage[]; nextToolIndex: number } {
  const parts = data?.candidates?.flatMap((candidate: any) => candidate?.content?.parts ?? []) ?? [];
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
