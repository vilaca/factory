import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../../../../src/core/context/conversation.js';

describe('Conversation — MessageType tagging', () => {
  it('default-infers user_input on plain addUser', () => {
    const c = new Conversation('sys');
    c.addUser('hi');
    const tagged = c.getMessagesWithMeta();
    // [system_prompt, user_input]
    assert.equal(tagged[0]!.metadata?.type, 'system_prompt');
    assert.equal(tagged[1]!.metadata?.type, 'user_input');
  });

  it('default-infers text_response on assistant without tool_calls', () => {
    const c = new Conversation('sys');
    c.addAssistant('hello');
    const tagged = c.getMessagesWithMeta();
    assert.equal(tagged[1]!.metadata?.type, 'text_response');
  });

  it('default-infers tool_call on assistant with tool_calls', () => {
    const c = new Conversation('sys');
    c.addAssistant('', [{ function: { name: 'Bash', arguments: {} } }]);
    const tagged = c.getMessagesWithMeta();
    assert.equal(tagged[1]!.metadata?.type, 'tool_call');
  });

  it('default-infers tool_result on tool role', () => {
    const c = new Conversation('sys');
    c.addToolResult('output');
    const tagged = c.getMessagesWithMeta();
    assert.equal(tagged[1]!.metadata?.type, 'tool_result');
  });

  it('honors explicit AppendMeta tags', () => {
    const c = new Conversation('sys');
    c.addUser('You cannot call X yet.', { type: 'step_nudge' });
    const tagged = c.getMessagesWithMeta();
    assert.equal(tagged[1]!.metadata?.type, 'step_nudge');
  });

  it('persists stepIndex when set', () => {
    const c = new Conversation('sys');
    c.addAssistant('', [{ function: { name: 'Bash', arguments: {} } }], {
      type: 'tool_call',
      stepIndex: 3,
    });
    c.addToolResult('done', undefined, undefined, { type: 'tool_result', stepIndex: 3 });
    const tagged = c.getMessagesWithMeta();
    assert.equal(tagged[1]!.metadata?.stepIndex, 3);
    assert.equal(tagged[2]!.metadata?.stepIndex, 3);
  });

  it('getMessages strips metadata before returning to providers', () => {
    const c = new Conversation('sys');
    c.addUser('hi', { type: 'user_input', stepIndex: 1 });
    c.addAssistant('hello', undefined, { type: 'text_response' });
    const wire = c.getMessages();
    for (const m of wire) {
      assert.equal((m as unknown as Record<string, unknown>).metadata, undefined);
    }
  });

  it('replaceLastToolResult preserves existing tag', () => {
    const c = new Conversation('sys');
    c.addToolResult('first', 'call_1', 'Bash', { type: 'tool_result', stepIndex: 5 });
    c.replaceLastToolResult('corrected', 'call_1', 'Bash');
    const tagged = c.getMessagesWithMeta();
    assert.equal(tagged[1]!.metadata?.type, 'tool_result');
    assert.equal(tagged[1]!.metadata?.stepIndex, 5);
    assert.equal(tagged[1]!.content, 'corrected');
  });

  it('replaceWithSummary tags the synthetic summary pair', () => {
    const c = new Conversation('sys');
    for (let i = 0; i < 6; i++) {
      c.addUser(`u${i}`);
      c.addAssistant(`a${i}`);
    }
    c.replaceWithSummary('compressed', 2);
    const tagged = c.getMessagesWithMeta();
    // [system_prompt, summary(user), summary(assistant), kept...]
    assert.equal(tagged[1]!.metadata?.type, 'summary');
    assert.equal(tagged[2]!.metadata?.type, 'summary');
  });

  it('ageOldToolResults preserves the tool_result tag on elided messages', () => {
    const c = new Conversation('sys');
    c.addUser('u1');
    c.addToolResult('a'.repeat(8_000), 'cid', 'Bash', { type: 'tool_result', stepIndex: 1 });
    c.addUser('u2');
    c.addToolResult('b'.repeat(8_000), 'cid2', 'Bash', { type: 'tool_result', stepIndex: 2 });
    c.addUser('u3');
    c.ageOldToolResults(1);
    const tagged = c.getMessagesWithMeta();
    // The first tool result (stepIndex=1) is aged; tag must survive.
    const old = tagged.find(m => m.tool_call_id === 'cid');
    assert.ok(old, 'aged message exists');
    assert.equal(old!.metadata?.type, 'tool_result');
    assert.equal(old!.metadata?.stepIndex, 1);
  });
});
