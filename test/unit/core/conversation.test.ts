import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { Conversation } from '../../../src/core/context/conversation.js';

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
    const toolCalls = [
      {
        function: { name: 'Read', arguments: { file_path: '/tmp/test' } },
      },
    ];
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
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
    ]);
  });
});

describe('Conversation — per-message tool result cap', () => {
  it('elides tool result content larger than the threshold', () => {
    // 1k token budget = ~4000 chars. Pass content beyond that.
    const conv = new Conversation('sys', 1_000);
    const big = 'A'.repeat(20_000);
    conv.addUser('go');
    conv.addAssistant('', [{ function: { name: 'Bash', arguments: {} } }]);
    conv.addToolResult(big, 'call_1', 'Bash');

    const msgs = conv.getMessages();
    const tool = msgs[msgs.length - 1];
    assert.strictEqual(tool.role, 'tool');
    assert.match(tool.content, /^\[elided: tool=Bash size=\d+kB/);
    assert.strictEqual(tool.tool_call_id, 'call_1');
  });

  it('passes through small tool results unchanged', () => {
    const conv = new Conversation('sys', 1_000);
    conv.addUser('go');
    conv.addAssistant('', [{ function: { name: 'Read', arguments: {} } }]);
    conv.addToolResult('small content', 'call_1', 'Read');

    const msgs = conv.getMessages();
    assert.strictEqual(msgs[msgs.length - 1].content, 'small content');
  });

  it('uses a generic <tool> label when no tool name is given', () => {
    const conv = new Conversation('sys', 1_000);
    const big = 'A'.repeat(20_000);
    conv.addToolResult(big, 'call_1');
    const tool = conv.getMessages()[1];
    assert.match(tool.content, /tool=<tool>/);
  });
});

describe('Conversation — ageOldToolResults', () => {
  function buildTurn(conv: Conversation, label: string, withTool = true): void {
    conv.addUser(`prompt-${label}`);
    if (withTool) {
      conv.addAssistant('', [{ function: { name: 'Read', arguments: {} } }]);
      conv.addToolResult(`output for ${label}`, `call_${label}`, 'Read');
      conv.addAssistant(`reply ${label}`);
    } else {
      conv.addAssistant(`reply ${label}`);
    }
  }

  it('elides tool results from turns older than the threshold and preserves recent ones', () => {
    const conv = new Conversation('sys');
    for (let i = 1; i <= 8; i++) buildTurn(conv, String(i));

    const aged = conv.ageOldToolResults(3);
    // 8 turns, keep last 3 → ages tool results for turns 1..5 (5 total).
    assert.strictEqual(aged, 5);

    const msgs = conv.getMessages();
    const oldTools = msgs.filter((m, idx) => {
      if (m.role !== 'tool') return false;
      // Find the user index that follows this tool message; if it's beyond
      // the last 3 user messages, it's "old".
      let usersAfter = 0;
      for (let j = idx + 1; j < msgs.length; j++) {
        if (msgs[j].role === 'user') usersAfter++;
      }
      return usersAfter >= 3;
    });
    for (const t of oldTools) {
      assert.match(t.content, /^\[elided:/);
    }

    // Recent tool results untouched.
    const lastTool = msgs.filter(m => m.role === 'tool').slice(-1)[0];
    assert.strictEqual(lastTool.content, 'output for 8');
  });

  it('preserves tool_call_id when aging', () => {
    const conv = new Conversation('sys');
    for (let i = 1; i <= 8; i++) buildTurn(conv, String(i));

    conv.ageOldToolResults(3);

    const msgs = conv.getMessages();
    for (const m of msgs) {
      if (m.role === 'tool' && m.content.startsWith('[elided')) {
        assert.ok(m.tool_call_id, 'tool_call_id should be preserved');
      }
    }
  });

  it('is idempotent (already-elided messages are not re-rewritten)', () => {
    const conv = new Conversation('sys');
    for (let i = 1; i <= 8; i++) buildTurn(conv, String(i));

    const first = conv.ageOldToolResults(3);
    const second = conv.ageOldToolResults(3);
    assert.ok(first > 0);
    assert.strictEqual(second, 0);
  });

  it('returns 0 when fewer turns exist than the threshold', () => {
    const conv = new Conversation('sys');
    buildTurn(conv, '1');
    buildTurn(conv, '2');
    const aged = conv.ageOldToolResults(6);
    assert.strictEqual(aged, 0);
  });
});

describe('Conversation — replaceWithSummary cutPoint guard', () => {
  it('summarizes a normal conversation (sanity)', () => {
    const conv = new Conversation('sys');
    conv.addUser('u1');
    conv.addAssistant('a1');
    conv.addUser('u2');
    conv.addAssistant('a2');
    conv.addUser('u3');
    conv.addAssistant('a3');
    const result = conv.replaceWithSummary('summary text', 2);
    assert.strictEqual(result.oldCount, 6);
    // 1 (synth user) + 1 (synth ack) + 2 (kept) = 4.
    assert.strictEqual(result.newCount, 4);
    const msgs = conv.getMessages();
    assert.strictEqual(msgs[1].role, 'user');
    assert.ok(typeof msgs[1].content === 'string' && msgs[1].content.includes('summary text'));
  });

  it('skips summarization when the head is all tool messages (cutPoint=0 edge)', () => {
    // Construct a pathological message sequence: every message is a tool
    // message. The safety-walk loop hits index 0 and would otherwise slice
    // from 0, keeping every message AND prepending a vacuous summary on
    // top — confused timeline. The guard short-circuits this case.
    const conv = new Conversation('sys');
    // Reach into the private messages array via a cast — we deliberately
    // construct an invalid head shape that the public API wouldn't allow,
    // because that's exactly the edge the guard exists to defend against.
    const msgs = (conv as unknown as { messages: { role: string; content: string }[] }).messages;
    for (let i = 0; i < 5; i++) msgs.push({ role: 'tool', content: `t${i}` });

    const before = conv.messageCount();
    const result = conv.replaceWithSummary('SHOULD-NOT-BE-INSERTED', 2);
    // Guard returns the same count for old and new — no change applied.
    assert.strictEqual(result.oldCount, before);
    assert.strictEqual(result.newCount, before);
    const after = conv.getMessages();
    // Original messages still present unmodified, no summary prepended.
    assert.strictEqual(after.length, before + 1); // +1 for the system prompt
    for (const m of after) {
      assert.ok(typeof m.content !== 'string' || !m.content.includes('SHOULD-NOT-BE-INSERTED'));
    }
  });
});
