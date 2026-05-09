import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  estimateToolDefinitionsTokens,
  estimateSingleMessageTokens,
  estimateMessagesTokens,
} from '../../../src/utils/tokens.js';
import type { ChatMessage, ToolDefinition } from '../../../src/providers/types.js';

describe('tokens', () => {
  it('estimateToolDefinitionsTokens returns 0 for an empty array', () => {
    assert.strictEqual(estimateToolDefinitionsTokens([]), 0);
  });

  it('estimateToolDefinitionsTokens scales with JSON size', () => {
    const defs: ToolDefinition[] = [
      {
        type: 'function',
        function: { name: 'Foo', description: 'x'.repeat(100), parameters: { type: 'object', properties: {} } },
      },
    ];
    const t = estimateToolDefinitionsTokens(defs);
    assert.ok(t > 0);
  });

  it('estimateSingleMessageTokens has no per-call +3 conversation overhead', () => {
    const m: ChatMessage = { role: 'user', content: 'abcd' };
    const single = estimateSingleMessageTokens(m);
    const viaBatch = estimateMessagesTokens([m]);
    assert.ok(viaBatch > single, 'full conversation estimate includes global overhead');
  });

  it('recency-style walk should sum single-message estimates, not estimateMessagesTokens([one])', () => {
    const tail: ChatMessage[] = Array.from({ length: 10 }, () => ({
      role: 'user' as const,
      content: 'hi',
    }));
    let inflated = 0;
    let correct = 0;
    for (const m of tail) {
      inflated += estimateMessagesTokens([m]);
      correct += estimateSingleMessageTokens(m);
    }
    assert.ok(
      inflated >= correct + 25,
      'wrapping each message added spurious global overhead (~3 tokens each)',
    );
  });
});
