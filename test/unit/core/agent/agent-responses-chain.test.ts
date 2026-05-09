import { describe, it } from 'node:test';
import assert from 'node:assert';
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  Provider,
  ProviderCapabilities,
  ToolDefinition,
} from '../../../../src/providers/types.js';
import type { AgentEvent, ResponsesChain } from '../../../../src/core/agent/types.js';
import { Conversation } from '../../../../src/core/context/conversation.js';
import { PermissionManager } from '../../../../src/security/permissions.js';
import { defaultRegistry } from '../../../../src/tools/index.js';
import { runAgent } from '../../../../src/core/agent/run-agent.js';
import { makeFakeCM } from './agent-helpers.js';

interface MockTurn {
  content?: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  responseId?: string;
  /** Throw an AbortError mid-stream (simulates user abort). */
  abortMidStream?: boolean;
}

function makeChainProvider(
  turns: MockTurn[],
  observed: { receivedOptions: ChatOptions[] },
): Provider {
  const queue = [...turns];
  return {
    name: 'mock',
    async listModels() {
      return ['mock-model'];
    },
    getCapabilities(): ProviderCapabilities {
      return {
        contextWindow: 8192,
        maxOutputTokens: 4096,
        toolSupport: 'native',
        parallelToolCalls: false,
        streaming: true,
        tokenCounting: 'estimated',
        modelTier: 'strong',
      };
    },
    async *chat(
      _model: string,
      _messages: ChatMessage[],
      _tools?: ToolDefinition[],
      options?: ChatOptions,
    ): AsyncGenerator<ChatChunk> {
      observed.receivedOptions.push(options ? { ...options } : ({} as ChatOptions));
      const turn = queue.shift() ?? { content: 'fallback.' };
      if (turn.abortMidStream) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      if (turn.content) yield { content: turn.content };
      const tail: ChatChunk = { done: true };
      if (turn.tool_calls) tail.tool_calls = turn.tool_calls as ChatChunk['tool_calls'];
      if (turn.responseId) tail.responseId = turn.responseId;
      yield tail;
    },
    async chatNoStream(): Promise<ChatChunk> {
      throw new Error('not used');
    },
  };
}

interface ChainHarness {
  events: AgentEvent[];
  observed: { receivedOptions: ChatOptions[] };
  chain: { value: ResponsesChain | undefined };
}

async function runWithChain(
  input: string,
  turns: MockTurn[],
  initialChain?: ResponsesChain,
  extra?: { contextManager?: ReturnType<typeof makeFakeCM> },
): Promise<ChainHarness> {
  const observed = { receivedOptions: [] as ChatOptions[] };
  const provider = makeChainProvider(turns, observed);
  const conversation = new Conversation('You are a test assistant.');
  const chain: { value: ResponsesChain | undefined } = { value: initialChain };
  const events: AgentEvent[] = [];

  const agent = runAgent(input, {
    provider,
    model: 'mock-model',
    conversation,
    permissions: new PermissionManager(),
    toolRegistry: defaultRegistry,
    enableCorrector: false,
    responsesChainRef: {
      get: () => chain.value,
      set: v => {
        chain.value = v;
      },
    },
    ...(extra?.contextManager ? { contextManager: extra.contextManager } : {}),
  });

  for await (const event of agent) {
    events.push(event);
    if (event.type === 'permission-request') {
      event.respond('allow');
    }
  }
  return { events, observed, chain };
}

describe('runAgent — Responses-API chain capture', () => {
  it('captures responseId after a successful turn into the chain ref', async () => {
    const harness = await runWithChain('hi', [{ content: 'hello.', responseId: 'resp_1' }]);
    assert.ok(harness.chain.value, 'chain should be set');
    assert.strictEqual(harness.chain.value!.lastResponseId, 'resp_1');
    assert.strictEqual(harness.chain.value!.provider, 'mock');
    assert.strictEqual(harness.chain.value!.model, 'mock-model');
    // messageCount = system + user + assistant = 3 after addAssistant.
    assert.strictEqual(harness.chain.value!.messageCount, 3);
  });

  it('forwards responsesChain into provider.chat options when valid for current tuple', async () => {
    const harness = await runWithChain(
      'hi',
      [{ content: 'ok.', responseId: 'resp_2' }],
      { lastResponseId: 'resp_seed', messageCount: 2, provider: 'mock', model: 'mock-model' },
    );
    const seen = harness.observed.receivedOptions[0]!;
    assert.deepStrictEqual(seen.responsesChain, {
      lastResponseId: 'resp_seed',
      messageCount: 2,
    });
  });

  it('drops a stale chain whose provider does not match the live tuple', async () => {
    const harness = await runWithChain(
      'hi',
      [{ content: 'ok.', responseId: 'resp_3' }],
      { lastResponseId: 'resp_old', messageCount: 2, provider: 'other-provider', model: 'mock-model' },
    );
    const seen = harness.observed.receivedOptions[0]!;
    assert.strictEqual(seen.responsesChain, undefined);
  });

  it('drops a stale chain whose keyId does not match the live key', async () => {
    const harness = await runWithChain('hi', [{ content: 'ok.', responseId: 'r' }], {
      lastResponseId: 'resp_old',
      messageCount: 2,
      provider: 'mock',
      model: 'mock-model',
      keyId: 'key-A',
    });
    // No rotation set → activeKeyId is undefined; chain demands keyId='key-A'
    // — mismatch → drop.
    const seen = harness.observed.receivedOptions[0]!;
    assert.strictEqual(seen.responsesChain, undefined);
  });

  it('clears the chain when the user aborts mid-stream', async () => {
    const harness = await runWithChain(
      'hi',
      [{ abortMidStream: true }],
      { lastResponseId: 'resp_pre', messageCount: 1, provider: 'mock', model: 'mock-model' },
    );
    assert.strictEqual(harness.chain.value, undefined);
  });

  it('clears the chain when compaction rewrites prior messages', async () => {
    const cm = makeFakeCM({
      shouldCompact: () => true,
      compact: async () => ({ oldCount: 10, newCount: 4 }),
      getUsagePercent: () => 0.4,
    });
    const harness = await runWithChain(
      'hi',
      [{ content: 'ok.', responseId: 'resp_post' }],
      { lastResponseId: 'resp_pre', messageCount: 5, provider: 'mock', model: 'mock-model' },
      { contextManager: cm },
    );
    // After compaction the chain reset clears the seed; the post-call
    // capture re-seeds it from the fresh response.
    assert.strictEqual(harness.chain.value!.lastResponseId, 'resp_post');
    // The provider must NOT have received the stale chain pointer on the
    // call that followed compaction.
    const seen = harness.observed.receivedOptions[0]!;
    assert.strictEqual(seen.responsesChain, undefined);
  });
});
