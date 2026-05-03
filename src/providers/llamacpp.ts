import type {
  Provider, ChatMessage, ChatChunk, ToolDefinition,
  ProviderCapabilities, ChatOptions,
} from './types.js';

export class LlamaCppProvider implements Provider {
  name = 'llamacpp';
  private baseUrl: string;

  constructor(host?: string) {
    this.baseUrl = host ?? 'http://127.0.0.1:8080';
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`);
      if (res.ok) {
        const data = await res.json() as any;
        if (data.data?.length) {
          // Note: llama.cpp serves the currently loaded model set; we surface
          // that list directly instead of applying provider-side filtering.
          return data.data.map((m: any) => m.id);
        }
      }
    } catch {
      // Older llama.cpp versions may not have /v1/models
    }

    const health = await fetch(`${this.baseUrl}/health`);
    if (!health.ok) {
      throw new Error(`llama.cpp server not reachable at ${this.baseUrl}`);
    }

    // Note: older llama.cpp builds may not expose /v1/models at all, so we
    // fall back to a single synthetic "default" entry after a health check.
    return ['default'];
  }

  getCapabilities(_model: string): ProviderCapabilities {
    // llama.cpp serves a single model; capabilities depend on what's loaded
    // Default to conservative estimates, overridable via config in future
    return {
      contextWindow: 8192,
      maxOutputTokens: 4096,
      toolSupport: 'basic',
      parallelToolCalls: false,
      streaming: true,
      tokenCounting: 'estimated',
      modelTier: 'medium',
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
      messages: messages.map(m => this.formatMessage(m)),
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`llama.cpp error ${res.status}: ${text}`);
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

        if (parsed.choices?.[0]?.finish_reason) {
          yield { done: true };
        }
      }
    }

    if (toolCalls && toolCalls.length > 0) {
      const parsed = toolCalls.map(tc => {
        let args: Record<string, unknown> = {};
        const rawArgs = (tc.function as any).__rawArgs;
        if (rawArgs) {
          try { args = JSON.parse(rawArgs); } catch { args = { _raw: rawArgs }; }
        }
        return {
          id: tc.id,
          function: { name: tc.function.name, arguments: args },
        };
      });
      yield { tool_calls: parsed, done: true };
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
      messages: messages.map(m => this.formatMessage(m)),
      stream: false,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`llama.cpp error ${res.status}: ${text}`);
    }

    const data = await res.json() as any;
    const choice = data.choices?.[0];

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

    if (data.usage) {
      result.usage = {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        totalTokens: data.usage.total_tokens ?? 0,
      };
    }

    return result;
  }

  private formatMessage(msg: ChatMessage): any {
    const formatted: any = { role: msg.role, content: msg.content };
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
    return formatted;
  }
}
