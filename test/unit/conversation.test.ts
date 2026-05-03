import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { Conversation } from '../../src/core/conversation.js';

describe('Conversation', () => {
  let conv: Conversation;

  beforeEach(() => {
    conv = new Conversation('You are a helpful assistant.');
  });

  it('getMessages includes system prompt', () => {
    const msgs = conv.getMessages();
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].role, 'system');
    assert.strictEqual(msgs[0].content, 'You are a helpful assistant.');
  });

  it('addUser appends user message', () => {
    conv.addUser('hello');
    const msgs = conv.getMessages();
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[1].role, 'user');
    assert.strictEqual(msgs[1].content, 'hello');
  });

  it('addAssistant appends assistant message', () => {
    conv.addUser('hi');
    conv.addAssistant('hello there');
    const msgs = conv.getMessages();
    assert.strictEqual(msgs.length, 3);
    assert.strictEqual(msgs[2].role, 'assistant');
    assert.strictEqual(msgs[2].content, 'hello there');
  });

  it('addAssistant includes tool_calls when provided', () => {
    const toolCalls = [{
      function: { name: 'Read', arguments: { file_path: '/tmp/test' } },
    }];
    conv.addAssistant('Let me read that.', toolCalls);
    const msgs = conv.getMessages();
    assert.strictEqual(msgs[1].tool_calls?.length, 1);
    assert.strictEqual(msgs[1].tool_calls![0].function.name, 'Read');
  });

  it('addAssistant omits tool_calls when empty', () => {
    conv.addAssistant('No tools needed.');
    const msgs = conv.getMessages();
    assert.strictEqual(msgs[1].tool_calls, undefined);
  });

  it('addToolResult appends tool message', () => {
    conv.addUser('read file');
    conv.addAssistant('Reading...', [{ function: { name: 'Read', arguments: {} } }]);
    conv.addToolResult('file content here');
    const msgs = conv.getMessages();
    assert.strictEqual(msgs.length, 4);
    assert.strictEqual(msgs[3].role, 'tool');
    assert.strictEqual(msgs[3].content, 'file content here');
  });

  it('clear removes all messages but preserves system prompt', () => {
    conv.addUser('hello');
    conv.addAssistant('hi');
    conv.clear();
    const msgs = conv.getMessages();
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].role, 'system');
  });

  it('updateSystemPrompt changes the system message', () => {
    conv.updateSystemPrompt('New prompt.');
    const msgs = conv.getMessages();
    assert.strictEqual(msgs[0].content, 'New prompt.');
  });

  it('maintains message order across multiple exchanges', () => {
    conv.addUser('q1');
    conv.addAssistant('a1');
    conv.addUser('q2');
    conv.addAssistant('a2', [{ function: { name: 'Bash', arguments: { command: 'ls' } } }]);
    conv.addToolResult('files...');
    conv.addUser('q3');
    conv.addAssistant('a3');

    const msgs = conv.getMessages();
    const roles = msgs.map(m => m.role);
    assert.deepStrictEqual(roles, [
      'system', 'user', 'assistant', 'user', 'assistant', 'tool', 'user', 'assistant',
    ]);
  });
});
