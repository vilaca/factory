import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  applyCacheBoundaries,
  countCacheBoundaries,
} from '../../src/core/agent/cache-boundaries.js';
import type { ChatMessage } from '../../src/providers/types.js';

describe('applyCacheBoundaries', () => {
  it('returns the input unchanged when empty', () => {
    assert.deepStrictEqual(applyCacheBoundaries([]), []);
  });

  it('marks the system message', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    const out = applyCacheBoundaries(messages);
    assert.strictEqual(out[0].cacheBoundary, true);
    assert.strictEqual(out[1].cacheBoundary, undefined);
  });

  it('marks the last assistant message when followed by a user message', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'second' },
    ];
    const out = applyCacheBoundaries(messages);
    assert.strictEqual(out[0].cacheBoundary, true);
    assert.strictEqual(out[2].cacheBoundary, true);
    // Untouched
    assert.strictEqual(out[1].cacheBoundary, undefined);
    assert.strictEqual(out[3].cacheBoundary, undefined);
    // Total markers <= 3 (Anthropic's tools marker brings to 4)
    assert.ok(countCacheBoundaries(out) <= 3);
  });

  it('does not mark when the trailing message is the assistant', () => {
    // Mid-stream weirdness — the call would be a continuation, not a new
    // user turn. Don't place a boundary on the in-progress assistant.
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'partial' },
    ];
    const out = applyCacheBoundaries(messages);
    assert.strictEqual(out[0].cacheBoundary, true);
    assert.strictEqual(out[2].cacheBoundary, undefined);
    assert.strictEqual(countCacheBoundaries(out), 1);
  });

  it('marks only the most recent assistant when there are multiple', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
    ];
    const out = applyCacheBoundaries(messages);
    assert.strictEqual(out[2].cacheBoundary, undefined);
    assert.strictEqual(out[4].cacheBoundary, true);
  });

  it('does not mutate the input array', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'more' },
    ];
    applyCacheBoundaries(messages);
    assert.strictEqual(messages[0].cacheBoundary, undefined);
    assert.strictEqual(messages[2].cacheBoundary, undefined);
  });

  it('emits at most 2 message-level markers (under Anthropic 4-max with tools marker)', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
      { role: 'assistant', content: 'f' },
      { role: 'user', content: 'g' },
    ];
    const out = applyCacheBoundaries(messages);
    assert.ok(countCacheBoundaries(out) <= 2);
  });
});
