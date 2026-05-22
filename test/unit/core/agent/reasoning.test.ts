import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractThinkTags,
  foldAndSerialize,
} from '../../../../src/core/agent/reasoning.js';
import type { ChatMessage } from '../../../../src/utils/chat-message.js';

describe('extractThinkTags', () => {
  it('returns input unchanged when no tags', () => {
    const r = extractThinkTags('just text');
    assert.equal(r.reasoning, '');
    assert.equal(r.remaining, 'just text');
  });

  it('extracts <think> blocks (Qwen / DeepSeek)', () => {
    const r = extractThinkTags('<think>plan: read X then Y</think>I will read X');
    assert.equal(r.reasoning, 'plan: read X then Y');
    assert.equal(r.remaining, 'I will read X');
  });

  it('extracts [THINK] blocks (Mistral Reasoning)', () => {
    const r = extractThinkTags('[THINK]reasoning here[/THINK]done');
    assert.equal(r.reasoning, 'reasoning here');
    assert.equal(r.remaining, 'done');
  });

  it('joins multiple think blocks with double newline', () => {
    const r = extractThinkTags('<think>first</think>mid<think>second</think>end');
    assert.equal(r.reasoning, 'first\n\nsecond');
    assert.equal(r.remaining, 'midend');
  });

  it('handles empty think blocks', () => {
    const r = extractThinkTags('<think></think>rest');
    assert.equal(r.reasoning, '');
    assert.equal(r.remaining, 'rest');
  });
});

describe('foldAndSerialize', () => {
  it('folds reasoning into the following tool_call message', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi', metadata: { type: 'user_input' } },
      { role: 'assistant', content: 'thought process here', metadata: { type: 'reasoning' } },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'Bash', arguments: {} } }],
        metadata: { type: 'tool_call' },
      },
    ];
    const out = foldAndSerialize(msgs);
    assert.equal(out.length, 2, 'reasoning is folded into following message');
    assert.equal(out[1]!.content, 'thought process here');
    assert.equal(out[1]!.tool_calls?.length, 1);
    // metadata stripped at the wire boundary
    for (const m of out) {
      assert.equal((m as unknown as Record<string, unknown>).metadata, undefined);
    }
  });

  it('emits standalone trailing reasoning as plain assistant message', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi', metadata: { type: 'user_input' } },
      { role: 'assistant', content: 'lone thought', metadata: { type: 'reasoning' } },
    ];
    const out = foldAndSerialize(msgs);
    assert.equal(out.length, 2);
    assert.equal(out[1]!.role, 'assistant');
    assert.equal(out[1]!.content, 'lone thought');
  });

  it('passes through messages without reasoning unchanged (minus metadata)', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys', metadata: { type: 'system_prompt' } },
      { role: 'user', content: 'hi', metadata: { type: 'user_input' } },
      { role: 'assistant', content: 'hello', metadata: { type: 'text_response' } },
    ];
    const out = foldAndSerialize(msgs);
    assert.equal(out.length, 3);
    assert.equal(out[2]!.content, 'hello');
    for (const m of out) {
      assert.equal((m as unknown as Record<string, unknown>).metadata, undefined);
    }
  });
});
