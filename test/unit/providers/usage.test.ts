// Pin the contextFillTokens selector — the canonical "how full is my
// next prompt?" reading of a TokenUsage. 44aeb26 fixed a status-bar
// regression where consumers were plucking `totalTokens` instead of
// `promptTokens`; this selector is the single function that owns the
// right answer.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { contextFillTokens } from '../../../src/providers/usage.js';

describe('contextFillTokens', () => {
  it('returns undefined when no usage has been reported', () => {
    assert.equal(contextFillTokens(undefined), undefined);
  });

  it('returns undefined when promptTokens is missing', () => {
    // Structurally-compatible usage object that omits promptTokens
    // (other usage fields may be present — irrelevant to the selector).
    assert.equal(contextFillTokens({}), undefined);
  });

  it('returns undefined when promptTokens is 0 (provider bug or pre-response sentinel)', () => {
    // A real system prompt is always >0 tokens, so a reported 0 means
    // the provider hasn't filled in the field correctly. Better to
    // fall back to a local estimate than display "ctx 0 (0%)".
    assert.equal(contextFillTokens({ promptTokens: 0 }), undefined);
  });

  it('returns promptTokens verbatim when it is a positive integer', () => {
    assert.equal(contextFillTokens({ promptTokens: 1 }), 1);
    assert.equal(contextFillTokens({ promptTokens: 1234 }), 1234);
    assert.equal(contextFillTokens({ promptTokens: 1_000_000 }), 1_000_000);
  });

  it('ignores other usage fields entirely (does NOT mix in totalTokens)', () => {
    // Regression for the 44aeb26 bug shape — make sure totalTokens
    // can't sneak in even when it's the larger / more "complete"
    // figure. The selector is about promptTokens, full stop.
    const usage = {
      promptTokens: 1000,
      // The full TokenUsage type also has totalTokens/completionTokens
      // but PromptTokensCarrier deliberately doesn't expose them.
      // Test via structural compatibility:
    } as { promptTokens?: number; totalTokens?: number };
    usage.totalTokens = 9999;
    assert.equal(contextFillTokens(usage), 1000);
  });
});
