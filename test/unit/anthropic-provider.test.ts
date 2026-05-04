import { describe, it } from 'node:test';
import assert from 'node:assert';
import { splitMessagesForAnthropic } from '../../src/providers/anthropic.js';
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
        tool_calls: [
          { id: 'toolu_a', function: { name: 'Glob', arguments: { pattern: '*' } } },
        ],
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
    assert.throws(
      () => splitMessagesForAnthropic(messages),
      /tool message has no tool_call_id/,
    );
  });
});
