import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  formatTokenSegment,
  selectDisplayTokens,
} from '../../../../../src/ui/tui/components/status-bar.js';

// Regression tests for 44aeb26 — "fix(status-bar): show prompt tokens, not
// prompt+completion". The bug: the status bar's "tokens used" figure was
// reading lastUsage.totalTokens (= prompt + completion), so it jittered down
// whenever the model gave a long reply. The fix routes lastUsage.promptTokens
// instead, which approximates "how full is the next prompt". These tests pin
// (a) the selector's promptTokens-over-totalTokens preference, (b) the
// "ctx " prefix that landed alongside, and (c) the sub-1% formatting added
// to keep large-window sessions from displaying a flat "0%".

describe('selectDisplayTokens — fix 44aeb26', () => {
  it('prefers promptTokens over the estimate when usage is reported', () => {
    const r = selectDisplayTokens({ promptTokens: 1234 }, 9999);
    assert.equal(r.totalTokens, 1234);
    assert.equal(r.tokensAreEstimate, false);
  });

  it('does NOT use totalTokens — even when it is present alongside promptTokens', () => {
    // The pre-fix code read totalTokens. If a refactor regresses that, this
    // test catches it: a usage object carrying both must pick promptTokens.
    const r = selectDisplayTokens(
      { promptTokens: 1000, totalTokens: 5000 } as { promptTokens?: number; totalTokens?: number },
      undefined,
    );
    assert.equal(r.totalTokens, 1000);
  });

  it('falls back to the local estimate before the first usage is reported', () => {
    const r = selectDisplayTokens(undefined, 4321);
    assert.equal(r.totalTokens, 4321);
    assert.equal(r.tokensAreEstimate, true, 'estimate flag must be set when usage is unknown');
  });

  it('falls back to the estimate when usage is present but lacks promptTokens', () => {
    // Some providers report totalTokens but not promptTokens. We still treat
    // that as "no model-reported prompt count" and use the local estimate.
    const r = selectDisplayTokens({ totalTokens: 9999 } as { promptTokens?: number }, 500);
    assert.equal(r.totalTokens, 500);
    assert.equal(r.tokensAreEstimate, true);
  });

  it('advances ctx from estimate to Anthropic promptTokens once the terminal usage lands', () => {
    // Mirrors the streaming shape we now normalize in anthropic.ts:
    // message_start carries input_tokens; message_delta can carry only
    // output_tokens. After merge, the status bar must switch from the local
    // estimate to model-reported promptTokens (not totalTokens).
    const before = selectDisplayTokens(undefined, 80);
    assert.equal(before.totalTokens, 80);
    assert.equal(before.tokensAreEstimate, true);

    const after = selectDisplayTokens(
      {
        promptTokens: 123,
        completionTokens: 17,
        totalTokens: 140,
      } as { promptTokens?: number; completionTokens?: number; totalTokens?: number },
      80,
    );
    assert.equal(after.totalTokens, 123);
    assert.equal(after.tokensAreEstimate, false);
    assert.ok((after.totalTokens ?? 0) > (before.totalTokens ?? 0));
  });

  it('returns undefined for both fields when nothing is known', () => {
    const r = selectDisplayTokens(undefined, undefined);
    assert.equal(r.totalTokens, undefined);
    assert.equal(r.tokensAreEstimate, false);
  });

  it('treats promptTokens=0 as "no count yet" and uses the estimate', () => {
    // After routing through contextFillTokens (src/providers/usage.ts),
    // a 0-valued promptTokens is treated as "no real count" — system
    // prompts are always >0 in practice, so 0 here means the provider
    // bugged out or hasn't reported yet. We prefer the local estimate
    // over displaying "ctx 0/N (0%)" which would be misleading. (This
    // is a deliberate semantics change from the prior `?? `-only chain
    // that let 0 pass through; the new behaviour matches the docstring
    // intent of contextFillTokens.)
    const r = selectDisplayTokens({ promptTokens: 0 }, 100);
    assert.equal(r.totalTokens, 100);
    assert.equal(r.tokensAreEstimate, true);
  });
});

describe('formatTokenSegment — "ctx " prefix and percentage formatting', () => {
  it('renders the "ctx " prefix (changed in 44aeb26)', () => {
    const out = formatTokenSegment(10_000, 100_000, false);
    assert.match(out, /ctx /);
  });

  it('includes the leading " · " separator so the segment composes into the bar', () => {
    const out = formatTokenSegment(10_000, 100_000, false);
    assert.ok(out.startsWith(' · '), `expected leading separator, got ${JSON.stringify(out)}`);
  });

  it('formats counts with locale separators', () => {
    const out = formatTokenSegment(12_345, 200_000, false);
    // Match the count and window with locale-aware separator (comma in en-US).
    assert.match(out, /12,345\/200,000/);
  });

  it('rounds to integer percent when ≥1%', () => {
    const out = formatTokenSegment(10_000, 100_000, false);
    assert.match(out, /\(10%\)/);
  });

  it('shows one decimal place when usage is under 1% (avoids a flat "0%")', () => {
    // 600 / 200000 = 0.3%
    const out = formatTokenSegment(600, 200_000, false);
    assert.match(out, /\(0\.3%\)/);
    assert.doesNotMatch(out, /\(0%\)/);
  });

  it('does NOT add a decimal when usage is exactly 1%', () => {
    const out = formatTokenSegment(1_000, 100_000, false);
    assert.match(out, /\(1%\)/);
    assert.doesNotMatch(out, /1\.0%/);
  });

  it('appends "(est.)" when the count is an estimate', () => {
    const out = formatTokenSegment(500, 100_000, true);
    assert.match(out, /\(est\.\)$/);
  });

  it('omits "(est.)" when the count is model-reported', () => {
    const out = formatTokenSegment(500, 100_000, false);
    assert.doesNotMatch(out, /est\./);
  });

  it('returns empty string when totalTokens is undefined', () => {
    assert.equal(formatTokenSegment(undefined, 100_000, false), '');
  });

  it('returns empty string when totalTokens is 0', () => {
    // No count to show — render nothing rather than "0/100,000 (0%)".
    assert.equal(formatTokenSegment(0, 100_000, false), '');
  });

  it('returns empty string when contextWindow is 0 (prevents NaN%)', () => {
    assert.equal(formatTokenSegment(1_000, 0, false), '');
  });
});
