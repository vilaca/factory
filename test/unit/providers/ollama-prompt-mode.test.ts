import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPromptModeToolPreamble,
  downgradeMessagesForPromptMode,
  withPromptModeSystem,
} from '../../../src/providers/ollama-prompt-mode.js';
import type { ChatMessage, ToolDefinition } from '../../../src/providers/types.js';

const TOOLS: ToolDefinition[] = [
  {
    function: {
      name: 'Read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
  {
    function: {
      name: 'Write',
      description: 'Write a file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, body: { type: 'string' } } },
    },
  },
];

describe('buildPromptModeToolPreamble', () => {
  it('lists every tool with its description and JSON schema', () => {
    const out = buildPromptModeToolPreamble(TOOLS);
    assert.match(out, /Read: Read a file/);
    assert.match(out, /Write: Write a file/);
    assert.match(out, /<tool_call>/);
  });

  it('teaches the <tool_call> protocol with an inline example', () => {
    const out = buildPromptModeToolPreamble(TOOLS);
    assert.match(out, /<tool_call>\{"name": "ToolName", "arguments": \{"arg": "value"\}\}<\/tool_call>/);
  });

  it('emits a stable parameters: line per tool', () => {
    const out = buildPromptModeToolPreamble(TOOLS);
    assert.match(out, /parameters: \{"type":"object","properties":\{"path":\{"type":"string"\}\}\}/);
  });
});

describe('downgradeMessagesForPromptMode', () => {
  it('rewrites tool messages as user messages tagged with the call name', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'a', function: { name: 'Read', arguments: { path: '/x' } } }],
      },
      { role: 'tool', content: 'file contents', tool_call_id: 'a' },
    ];
    const out = downgradeMessagesForPromptMode(msgs);
    assert.equal(out.length, 3);
    assert.equal(out[2]!.role, 'user');
    assert.match(out[2]!.content, /\[Tool result for Read\]/);
    assert.match(out[2]!.content, /file contents/);
  });

  it('serialises assistant tool_calls into <tool_call> JSON text', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'I will read it.',
        tool_calls: [{ id: 'a', function: { name: 'Read', arguments: { path: '/x' } } }],
      },
    ];
    const out = downgradeMessagesForPromptMode(msgs);
    assert.equal(out[0]!.role, 'assistant');
    assert.match(out[0]!.content, /I will read it\./);
    assert.match(
      out[0]!.content,
      /<tool_call>\{"name":"Read","arguments":\{"path":"\/x"\}\}<\/tool_call>/,
    );
  });

  it('correlates successive tool results with their assistant calls in order', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', function: { name: 'Read', arguments: {} } },
          { id: 'b', function: { name: 'Write', arguments: {} } },
        ],
      },
      { role: 'tool', content: 'read out', tool_call_id: 'a' },
      { role: 'tool', content: 'write out', tool_call_id: 'b' },
    ];
    const out = downgradeMessagesForPromptMode(msgs);
    assert.match(out[1]!.content, /\[Tool result for Read\]/);
    assert.match(out[2]!.content, /\[Tool result for Write\]/);
  });

  it('passes plain user/assistant/system messages through unchanged', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const out = downgradeMessagesForPromptMode(msgs);
    assert.deepEqual(out, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('does not mutate the input array', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }];
    const snapshot = JSON.parse(JSON.stringify(msgs));
    downgradeMessagesForPromptMode(msgs);
    assert.deepEqual(msgs, snapshot);
  });
});

describe('withPromptModeSystem', () => {
  it('appends the preamble to an existing system message', () => {
    const out = withPromptModeSystem(
      [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hi' },
      ],
      'use tools via <tool_call>',
    );
    assert.equal(out.length, 2);
    assert.equal(out[0]!.role, 'system');
    assert.match(out[0]!.content, /you are helpful/);
    assert.match(out[0]!.content, /use tools via <tool_call>/);
  });

  it('prepends a new system message when none exists', () => {
    const out = withPromptModeSystem(
      [{ role: 'user', content: 'hi' }],
      'use tools',
    );
    assert.equal(out.length, 2);
    assert.equal(out[0]!.role, 'system');
    assert.equal(out[0]!.content, 'use tools');
    assert.equal(out[1]!.role, 'user');
  });
});
