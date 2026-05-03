import { InferenceClient } from '@huggingface/inference';
import type {
  Provider, ChatMessage, ChatChunk, ToolDefinition,
  ProviderCapabilities, ChatOptions, ModelTier,
} from './types.js';
import {
  mergeStreamedToolCalls,
  finalizeToolCalls,
  type StreamingToolCallAcc,
} from './_openai/tool-calls.js';

export class HuggingFaceProvider implements Provider {
  name = 'huggingface';
  private client: InferenceClient;

  constructor(token?: string) {
    const apiKey = token ?? process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN;
    if (!apiKey) {
      throw new Error(
        'HuggingFace token required. Set HF_TOKEN env var or use --token flag.'
      );
    }
    this.client = new InferenceClient(apiKey);
  }

  async listModels(): Promise<string[]> {
    // Note: HuggingFace does not expose a single reliable "all coding/chat
    // models for this token" catalog here, so we keep a curated starter list.
    return [
      'Qwen/Qwen2.5-Coder-32B-Instruct',
      'meta-llama/Llama-3.3-70B-Instruct',
      'mistralai/Mistral-Small-24B-Instruct-2501',
      'microsoft/Phi-3-mini-4k-instruct',
      'Qwen/Qwen2.5-72B-Instruct',
      'meta-llama/Llama-3.1-8B-Instruct',
      'mistralai/Mixtral-8x7B-Instruct-v0.1',
    ];
  }

  getCapabilities(model: string): ProviderCapabilities {
    const tier = estimateHfModelTier(model);
    return {
      contextWindow: estimateHfContextWindow(model),
      maxOutputTokens: 4096,
      toolSupport: 'basic',
      parallelToolCalls: false,
      streaming: true,
      tokenCounting: 'estimated',
      modelTier: tier,
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const hfMessages = messages.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant' | 'tool',
      content: m.content,
    }));

    try {
      if (options?.signal?.aborted) {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        throw err;
      }

      const stream = this.client.chatCompletionStream({
        model,
        messages: hfMessages,
        tools: tools as any,
        max_tokens: options?.maxTokens ?? 4096,
        signal: options?.signal,
      } as any);

      let toolCalls: StreamingToolCallAcc | undefined;

      for await (const chunk of stream) {
        if (options?.signal?.aborted) break;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        const result: ChatChunk = {};

        if (delta.content) {
          result.content = delta.content;
        }

        if (delta.tool_calls) {
          if (!toolCalls) toolCalls = [];
          mergeStreamedToolCalls(toolCalls, delta.tool_calls as any[]);
        }

        if (chunk.choices?.[0]?.finish_reason === 'tool_calls' ||
            chunk.choices?.[0]?.finish_reason === 'stop') {
          result.done = true;
        }

        if (result.content || result.done) {
          yield result;
        }
      }

      if (toolCalls && toolCalls.length > 0) {
        const finalized = finalizeToolCalls(toolCalls);
        if (finalized.length > 0) {
          yield { tool_calls: finalized, done: true };
        }
      }
    } catch (err: any) {
      throw new Error(`HuggingFace API error: ${err.message}`);
    }
  }

  async chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    const hfMessages = messages.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant' | 'tool',
      content: m.content,
    }));

    const response = await this.client.chatCompletion({
      model,
      messages: hfMessages,
      tools: tools as any,
      max_tokens: options?.maxTokens ?? 4096,
      signal: options?.signal,
    } as any);

    const choice = response.choices?.[0];
    const result: ChatChunk = {
      content: choice?.message?.content ?? undefined,
      done: true,
    };

    if (choice?.message?.tool_calls) {
      result.tool_calls = choice.message.tool_calls.map((tc: any) => ({
        id: tc.id,
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments,
        },
      }));
    }

    if ((response as any).usage) {
      const u = (response as any).usage;
      result.usage = {
        promptTokens: u.prompt_tokens ?? 0,
        completionTokens: u.completion_tokens ?? 0,
        totalTokens: u.total_tokens ?? 0,
      };
    }

    return result;
  }
}

function estimateHfModelTier(model: string): ModelTier {
  const lower = model.toLowerCase();
  const paramMatch = lower.match(/(\d+)b/);
  if (paramMatch) {
    const params = parseInt(paramMatch[1], 10);
    if (params >= 70) return 'strong';
    if (params >= 14) return 'medium';
    return 'weak';
  }
  return 'medium';
}

function estimateHfContextWindow(model: string): number {
  const lower = model.toLowerCase();
  if (lower.includes('qwen')) return 32768;
  if (lower.includes('llama')) return 8192;
  if (lower.includes('mixtral')) return 32768;
  if (lower.includes('phi-3-mini-4k')) return 4096;
  return 8192;
}
