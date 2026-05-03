import type {
  Provider, ChatMessage, ChatChunk, ToolDefinition,
  ProviderCapabilities, ChatOptions, ModelPickerInfo, ModelTier,
} from './types.js';
import { CopilotAuthManager, inferCopilotCredentialKind } from './copilot-auth.js';

const FALLBACK_MODELS = [
  'gpt-4.1',
  'gpt-4o',
  'claude-sonnet-4',
  'gemini-2.5-pro',
  'o4-mini',
];

interface CopilotModelEntry {
  id: string;
}

export class CopilotProvider implements Provider {
  name = 'copilot';
  private auth: CopilotAuthManager;

  constructor(options: { token?: string; githubToken?: string; host?: string } = {}) {
    const envToken = process.env.GITHUB_COPILOT_API_KEY ?? process.env.COPILOT_API_KEY;
    const provided = options.token ?? envToken;
    const kind = inferCopilotCredentialKind(provided);
    this.auth = new CopilotAuthManager({
      copilotToken: kind === 'copilot' ? provided : undefined,
      githubToken: options.githubToken ?? (kind === 'github' ? provided : undefined),
      host: options.host,
    });
  }

  async listModels(): Promise<string[]> {
    const session = await this.auth.getSession();
    const res = await fetch(`${session.apiBaseUrl}/models`, {
      headers: {
        ...this.auth.authHeaders(session.token),
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub Copilot API error ${res.status}: ${text}`);
    }

    const data = await res.json() as unknown;
    const models = extractModelEntries(data);
    return models.length > 0 ? models.map(model => model.id) : [...FALLBACK_MODELS];
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const caps = this.getCapabilities(model);
    return {
      label: model,
      detail: `tools · max ${formatTokenCount(caps.maxOutputTokens)} out`,
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    const tier = estimateCopilotModelTier(lower);
    return {
      contextWindow: estimateCopilotContextWindow(lower),
      maxOutputTokens: lower.includes('mini') || lower.includes('haiku') ? 8192 : 16384,
      toolSupport: 'native',
      parallelToolCalls: true,
      streaming: true,
      tokenCounting: 'exact',
      modelTier: tier,
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const body: any = {
      model,
      messages: messages.map(message => this.formatMessage(message)),
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }
    if (options?.maxTokens) {
      body.max_tokens = options.maxTokens;
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const session = await this.auth.getSession(options?.signal);
    if (!session.chatEnabled) {
      throw new Error('GitHub Copilot chat is not enabled for this account.');
    }

    const res = await fetch(`${session.apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...this.auth.authHeaders(session.token),
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub Copilot API error ${res.status}: ${text}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let toolCalls: ChatChunk['tool_calls'] = undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(trimmed.slice(6));
        } catch {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { content: delta.content };
        }

        if (delta.tool_calls) {
          if (!toolCalls) toolCalls = [];
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id,
                function: { name: '', arguments: {} },
              };
            }
            if (tc.function?.name) {
              toolCalls[idx].function.name += tc.function.name;
            }
            if (tc.function?.arguments) {
              (toolCalls[idx].function as any).__rawArgs =
                ((toolCalls[idx].function as any).__rawArgs ?? '') + tc.function.arguments;
            }
          }
        }

        const finishReason = parsed.choices?.[0]?.finish_reason;
        if (finishReason === 'stop' || finishReason === 'tool_calls') {
          const usage = parsed.usage
            ? {
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
              totalTokens: parsed.usage.total_tokens ?? 0,
            }
            : undefined;
          yield { done: true, usage };
        }
      }
    }

    if (toolCalls && toolCalls.length > 0) {
      const parsed = toolCalls.flatMap(tc => {
        if (!tc?.function || !tc.function.name) {
          return [];
        }
        let args: Record<string, unknown> = {};
        const rawArgs = (tc.function as any).__rawArgs;
        if (rawArgs) {
          try {
            args = JSON.parse(rawArgs);
          } catch {
            args = { _raw: rawArgs };
          }
        }
        return [{
          id: tc.id,
          function: { name: tc.function.name, arguments: args },
        }];
      });
      if (parsed.length > 0) {
        yield { tool_calls: parsed, done: true };
      }
    }
  }

  async chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    const body: any = {
      model,
      messages: messages.map(message => this.formatMessage(message)),
      stream: false,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }
    if (options?.maxTokens) {
      body.max_tokens = options.maxTokens;
    }
    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    const session = await this.auth.getSession(options?.signal);
    if (!session.chatEnabled) {
      throw new Error('GitHub Copilot chat is not enabled for this account.');
    }

    const res = await fetch(`${session.apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...this.auth.authHeaders(session.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub Copilot API error ${res.status}: ${text}`);
    }

    const data = await res.json() as any;
    const choice = data.choices?.[0];

    const result: ChatChunk = {
      content: choice?.message?.content ?? undefined,
      done: true,
    };

    if (choice?.message?.tool_calls) {
      result.tool_calls = choice.message.tool_calls.flatMap((tc: any) => {
        if (!tc?.function || typeof tc.function.name !== 'string' || !tc.function.name) {
          return [];
        }

        return [{
          id: tc.id,
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string'
              ? parseToolArgs(tc.function.arguments)
              : tc.function.arguments,
          },
        }];
      });
    }

    if (data.usage) {
      result.usage = {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        totalTokens: data.usage.total_tokens ?? 0,
      };
    }

    return result;
  }

  private formatMessage(msg: ChatMessage): Record<string, unknown> {
    const formatted: Record<string, unknown> = {
      role: msg.role,
      content: msg.content,
    };

    if (msg.tool_calls) {
      formatted.tool_calls = msg.tool_calls.map(tc => ({
        id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments),
        },
      }));
    }

    if (msg.role === 'tool' && msg.tool_call_id) {
      formatted.tool_call_id = msg.tool_call_id;
    }

    return formatted;
  }
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function extractModelEntries(data: unknown): CopilotModelEntry[] {
  const rawItems =
    Array.isArray(data)
      ? data
      : (data && typeof data === 'object' && Array.isArray((data as any).data))
        ? (data as any).data
        : [];

  const models: string[] = rawItems
    .filter((item: any) => {
      if (!item || typeof item !== 'object') return true;
      // Note: respect Copilot's own picker and policy flags so we do not offer
      // models the upstream service marks as hidden, non-chat, or disabled.
      if (item.model_picker_enabled === false) return false;
      if (item.capabilities?.type && item.capabilities.type !== 'chat') return false;
      if (item.policy?.state && item.policy.state !== 'enabled') return false;
      return true;
    })
    .map((item: any) => {
      if (typeof item === 'string') return item;
      if (item && typeof item.id === 'string') return item.id;
      if (item && typeof item.name === 'string') return item.name;
      return null;
    })
    .filter((value: string | null): value is string => value !== null);

  return [...new Set(models)].map(id => ({ id }));
}

function estimateCopilotModelTier(model: string): ModelTier {
  if (model.includes('opus') || model.includes('sonnet') || model.includes('gpt-5') ||
      model.includes('gpt-4.1') || model.includes('o3') || model.includes('o4') ||
      model.includes('gemini-2.5-pro')) {
    return 'strong';
  }
  return 'medium';
}

function estimateCopilotContextWindow(model: string): number {
  if (model.includes('claude')) return 200000;
  if (model.includes('gemini')) return 128000;
  if (model.includes('gpt') || model.includes('o3') || model.includes('o4')) return 128000;
  return 128000;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  }
  return String(value);
}
