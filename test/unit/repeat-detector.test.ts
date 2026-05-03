import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RepeatDetector } from '../../src/core/agent/repeat-detector.js';

describe('RepeatDetector', () => {
  it('returns null for non-repeating output', () => {
    const d = new RepeatDetector(5);
    assert.strictEqual(d.feed('first line\nsecond line\nthird line\n'), null);
  });

  it('triggers when threshold consecutive identical lines arrive in one chunk', () => {
    const d = new RepeatDetector(5);
    const chunk = '|         |\n'.repeat(5);
    const result = d.feed(chunk);
    assert.ok(result);
    assert.strictEqual(result!.line, '|         |');
    assert.strictEqual(result!.streak, 5);
  });

  it('triggers when identical lines accumulate across many small chunks', () => {
    const d = new RepeatDetector(10);
    let trigger: { line: string; streak: number } | null = null;
    // Stream the line in tiny pieces.
    const line = '|         |\n';
    for (let i = 0; i < 12; i++) {
      for (const ch of line) {
        const t = d.feed(ch);
        if (t && !trigger) trigger = t;
      }
    }
    assert.ok(trigger);
    assert.strictEqual(trigger!.line, '|         |');
    assert.ok(trigger!.streak >= 10);
  });

  it('ignores trivially short / blank lines', () => {
    const d = new RepeatDetector(3);
    // 100 blank lines should NOT trigger.
    assert.strictEqual(d.feed('\n'.repeat(100)), null);
    // 100 single-char lines should NOT trigger.
    assert.strictEqual(d.feed('a\n'.repeat(100)), null);
  });

  it('resets when a different line arrives', () => {
    const d = new RepeatDetector(5);
    d.feed('|         |\n|         |\n|         |\n|         |\n');
    // Different line breaks the streak.
    d.feed('different line\n');
    // Now we need 5 MORE identical lines to trigger.
    assert.strictEqual(d.feed('|         |\n|         |\n|         |\n|         |\n'), null);
    const result = d.feed('|         |\n');
    assert.ok(result);
  });

  it('does not trigger on the trailing partial line until a newline arrives', () => {
    const d = new RepeatDetector(3);
    // Three full identical lines + one partial.
    const result = d.feed('|         |\n|         |\n|         |\n|         '); // partial
    // Threshold of 3 reached on the third line — should fire.
    assert.ok(result);
  });
});
