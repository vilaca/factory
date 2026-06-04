import { describe, it } from 'node:test';
import assert from 'node:assert';
import { callModel } from '../../../../../src/core/agent/call-model/call-model.js';
import type {
  ChatChunk,
  ChatMessage,
  Provider,
  ProviderCapabilities,
  ToolDefinition,
} from '../../../../../src/providers/types.js';
import type { AgentEvent } from '../../../../../src/core/agent/types.js';

async function collect(
  gen: AsyncGenerator<AgentEvent, unknown>,
): Promise<{ events: AgentEvent[]; result: unknown }> {
  const events: AgentEvent[] = [];
  let result: unknown;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      break;
    }
    events.push(next.value as AgentEvent);
  }
  return { events, result };
}

describe('callModel — tool call argument sanitization', () => {
  it('parses stringified tool arguments JSON into an object', async () => {
    const provider: Provider = {
      name: 'stub',
      listModels: async () => [],
      getCapabilities: (): ProviderCapabilities => ({
        contextWindow: 8192,
        maxOutputTokens: 4096,
        toolSupport: 'native',
        parallelToolCalls: false,
        streaming: true,
        tokenCounting: 'estimated',
        modelTier: 'medium',
      }),
      async *chat(): AsyncGenerator<ChatChunk> {
        yield {
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              function: {
                name: 'Read',
                arguments: '{"file_path":"/repo/src/file.ts","offset":5}',
              },
            },
          ],
          done: true,
        };
      },
      async chatNoStream() {
        return { content: '', tool_calls: [], done: true } as ChatChunk;
      },
    };

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const tools: ToolDefinition[] = [];

    const { result } = await collect(callModel(provider, 'model', messages, tools, {}));
    const toolCalls = (result as { toolCalls: any[] }).toolCalls;
    assert.ok(toolCalls.length === 1, 'expected one tool call');
    assert.deepStrictEqual(toolCalls[0]?.function?.arguments, {
      file_path: '/repo/src/file.ts',
      offset: 5,
    });
  });
});
