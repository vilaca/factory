import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  AnthropicProvider,
  buildAnthropicTools,
  splitMessagesForAnthropic,
} from '../../src/providers/anthropic.js';
import type { ChatMessage } from '../../src/providers/types.js';

describe('splitMessagesForAnthropic', () => {
  it('extracts the system prompt and leaves user content untouched', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
    ];
    const { system, msgs } = splitMessagesForAnthropic(messages);
    assert.strictEqual(system, 'be helpful');
    assert.deepStrictEqual(msgs, [{ role: 'user', content: 'hi' }]);
  });

  it('embeds tool_use blocks alongside text on assistant turns', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'what files are here?' },
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [{ id: 'toolu_a', function: { name: 'Glob', arguments: { pattern: '*' } } }],
      },
    ];
    const { msgs } = splitMessagesForAnthropic(messages);
    assert.deepStrictEqual(msgs[1], {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_a', name: 'Glob', input: { pattern: '*' } },
      ],
    });
  });

  it('groups consecutive tool results into one user message and uses tool_call_id', () => {
    // Reproduces the bug where two parallel tool calls in one turn produced
    // two separate user messages with tool_use_id="unknown", which Anthropic
    // rejects with a 400.
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'doing it',
        tool_calls: [
          { id: 'toolu_a', function: { name: 'Glob', arguments: {} } },
          { id: 'toolu_b', function: { name: 'Read', arguments: {} } },
        ],
      },
      { role: 'tool', content: 'glob output', tool_call_id: 'toolu_a' },
      { role: 'tool', content: 'read output', tool_call_id: 'toolu_b' },
    ];
    const { msgs } = splitMessagesForAnthropic(messages);
    // user, assistant(text+2 tool_use), user(2 tool_result)
    assert.strictEqual(msgs.length, 3);
    assert.strictEqual(msgs[2].role, 'user');
    assert.deepStrictEqual(msgs[2].content, [
      { type: 'tool_result', tool_use_id: 'toolu_a', content: 'glob output' },
      { type: 'tool_result', tool_use_id: 'toolu_b', content: 'read output' },
    ]);
  });

  it('starts a new user message when a non-tool message intervenes', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'toolu_a', function: { name: 'X', arguments: {} } }],
      },
      { role: 'tool', content: 'a', tool_call_id: 'toolu_a' },
      { role: 'user', content: 'follow-up' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'toolu_b', function: { name: 'Y', arguments: {} } }],
      },
      { role: 'tool', content: 'b', tool_call_id: 'toolu_b' },
    ];
    const { msgs } = splitMessagesForAnthropic(messages);
    // assistant, user(tool_result a), user(follow-up), assistant, user(tool_result b)
    assert.strictEqual(msgs.length, 5);
    assert.strictEqual(msgs[1].content[0].tool_use_id, 'toolu_a');
    assert.strictEqual(msgs[2].content, 'follow-up');
    assert.strictEqual(msgs[4].content[0].tool_use_id, 'toolu_b');
  });

  it('throws when a tool message is missing tool_call_id', () => {
    // Used to silently emit tool_use_id="unknown" and let the API 400. Now
    // we fail at the boundary so upstream bugs surface immediately.
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'toolu_a', function: { name: 'X', arguments: {} } }],
      },
      { role: 'tool', content: 'orphan' },
    ];
    assert.throws(() => splitMessagesForAnthropic(messages), /tool message has no tool_call_id/);
  });
});

describe('splitMessagesForAnthropic — cache markers', () => {
  it('returns system as a string when no cacheBoundary is set', () => {
    const { system } = splitMessagesForAnthropic([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    assert.strictEqual(system, 'sys');
  });

  it('emits system as an array with cache_control when cacheBoundary is set', () => {
    const { system } = splitMessagesForAnthropic([
      { role: 'system', content: 'sys', cacheBoundary: true },
      { role: 'user', content: 'hi' },
    ]);
    assert.deepStrictEqual(system, [
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('attaches cache_control to the last block of an assistant tool_call message', () => {
    const { msgs } = splitMessagesForAnthropic([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'doing it',
        cacheBoundary: true,
        tool_calls: [
          { id: 'toolu_a', function: { name: 'X', arguments: {} } },
          { id: 'toolu_b', function: { name: 'Y', arguments: {} } },
        ],
      },
    ]);
    const asst = msgs[1];
    assert.strictEqual(asst.role, 'assistant');
    assert.strictEqual(asst.content[asst.content.length - 1].cache_control.type, 'ephemeral');
    assert.strictEqual(asst.content[0].cache_control, undefined);
  });

  it('converts plain text assistant content to a block array when cacheBoundary is set', () => {
    const { msgs } = splitMessagesForAnthropic([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply', cacheBoundary: true },
      { role: 'user', content: 'second' },
    ]);
    assert.deepStrictEqual(msgs[1].content, [
      { type: 'text', text: 'reply', cache_control: { type: 'ephemeral' } },
    ]);
    // The other plain-text user messages stay as strings.
    assert.strictEqual(msgs[0].content, 'first');
    assert.strictEqual(msgs[2].content, 'second');
  });

  it('emits no cache_control fields when no cacheBoundary is set anywhere', () => {
    const { system, msgs } = splitMessagesForAnthropic([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
    ]);
    assert.strictEqual(system, 'sys');
    for (const m of msgs) {
      assert.strictEqual(JSON.stringify(m).includes('cache_control'), false);
    }
  });
});

describe('buildAnthropicTools', () => {
  const tools = [
    { type: 'function' as const, function: { name: 'A', description: 'a', parameters: {} } },
    { type: 'function' as const, function: { name: 'B', description: 'b', parameters: {} } },
  ];

  it('returns tools without cache_control when cacheLast is false', () => {
    const out = buildAnthropicTools(tools, false);
    assert.strictEqual(out.length, 2);
    for (const t of out) {
      assert.strictEqual(t.cache_control, undefined);
    }
  });

  it('attaches cache_control: ephemeral to the last tool when cacheLast is true', () => {
    const out = buildAnthropicTools(tools, true);
    assert.strictEqual(out[0].cache_control, undefined);
    assert.deepStrictEqual(out[1].cache_control, { type: 'ephemeral' });
  });

  it('returns an empty array when no tools are passed', () => {
    assert.deepStrictEqual(buildAnthropicTools([], true), []);
  });
});

describe('AnthropicProvider — cache token plumbing', () => {
  it('populates cachedPromptTokens and cacheCreationTokens from chatNoStream response', async () => {
    const provider = new AnthropicProvider('test-key');
    (provider as any).client = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: 'hi' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 5,
          },
        }),
      },
    };

    const result = await provider.chatNoStream('claude-sonnet-4-6', [
      { role: 'user', content: 'hi' },
    ]);

    assert.strictEqual(result.usage?.promptTokens, 100);
    assert.strictEqual(result.usage?.completionTokens, 20);
    assert.strictEqual(result.usage?.cachedPromptTokens, 80);
    assert.strictEqual(result.usage?.cacheCreationTokens, 5);
  });

  it('chatNoStream omits cache fields when the response lacks them', async () => {
    const provider = new AnthropicProvider('test-key');
    (provider as any).client = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 50, output_tokens: 10 },
        }),
      },
    };

    const result = await provider.chatNoStream('claude-sonnet-4-6', [
      { role: 'user', content: 'hi' },
    ]);

    assert.strictEqual(result.usage?.promptTokens, 50);
    assert.strictEqual((result.usage as any)?.cachedPromptTokens, undefined);
    assert.strictEqual((result.usage as any)?.cacheCreationTokens, undefined);
  });

  it('populates cache fields from streaming message_delta usage', async () => {
    const provider = new AnthropicProvider('test-key');

    async function* mockEvents(): AsyncGenerator<any> {
      yield { type: 'content_block_start', content_block: { type: 'text' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } };
      yield { type: 'content_block_stop' };
      yield { type: 'message_stop' };
      yield {
        type: 'message_delta',
        usage: {
          input_tokens: 200,
          output_tokens: 30,
          cache_read_input_tokens: 150,
          cache_creation_input_tokens: 10,
        },
      };
    }

    (provider as any).client = {
      messages: { stream: () => mockEvents() },
    };

    const chunks: any[] = [];
    for await (const chunk of provider.chat('claude-sonnet-4-6', [
      { role: 'user', content: 'hi' },
    ])) {
      chunks.push(chunk);
    }

    const withUsage = chunks.find(c => c.usage);
    assert.ok(withUsage, 'expected a chunk to carry usage');
    assert.strictEqual(withUsage.usage.promptTokens, 200);
    assert.strictEqual(withUsage.usage.completionTokens, 30);
    assert.strictEqual(withUsage.usage.cachedPromptTokens, 150);
    assert.strictEqual(withUsage.usage.cacheCreationTokens, 10);
  });

  it('streaming usage omits cache fields when the response lacks them', async () => {
    const provider = new AnthropicProvider('test-key');

    async function* mockEvents(): AsyncGenerator<any> {
      yield { type: 'content_block_start', content_block: { type: 'text' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } };
      yield { type: 'content_block_stop' };
      yield { type: 'message_stop' };
      yield { type: 'message_delta', usage: { input_tokens: 40, output_tokens: 10 } };
    }

    (provider as any).client = {
      messages: { stream: () => mockEvents() },
    };

    const chunks: any[] = [];
    for await (const chunk of provider.chat('claude-sonnet-4-6', [
      { role: 'user', content: 'hi' },
    ])) {
      chunks.push(chunk);
    }

    const withUsage = chunks.find(c => c.usage);
    assert.ok(withUsage);
    assert.strictEqual(withUsage.usage.cachedPromptTokens, undefined);
    assert.strictEqual(withUsage.usage.cacheCreationTokens, undefined);
  });
});
