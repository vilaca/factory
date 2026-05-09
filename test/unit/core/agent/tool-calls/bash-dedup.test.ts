import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BashDedupTracker } from '../../../../../src/core/agent/tool-calls/bash-dedup.js';

describe('BashDedupTracker', () => {
  it('does not nudge on the first or second similar command', () => {
    const t = new BashDedupTracker();
    assert.strictEqual(t.observe('find src -name "*.ts" | wc -l'), false);
    assert.strictEqual(t.observe('find src -name "*.ts" -exec wc -l {} \\;'), false);
  });

  it('nudges on the third near-duplicate command', () => {
    const t = new BashDedupTracker();
    t.observe('find src -name "*.ts" -exec wc -l {} \\;');
    t.observe('find src -name "*.ts" -exec grep -c "//" {} \\;');
    // Third near-duplicate (same find/src/exec/ts skeleton).
    assert.strictEqual(t.observe('find src -name "*.ts" -exec grep -n "//" {} \\;'), true);
  });

  it('does not nudge for genuinely different commands', () => {
    const t = new BashDedupTracker();
    assert.strictEqual(t.observe('npm test'), false);
    assert.strictEqual(t.observe('git status'), false);
    assert.strictEqual(t.observe('ls -la'), false);
    assert.strictEqual(t.observe('cat package.json'), false);
  });

  it('does not nudge twice for the same near-duplicate cluster', () => {
    const t = new BashDedupTracker();
    t.observe('find src -name "*.ts" -exec wc -l {} \\;');
    t.observe('find src -name "*.ts" -exec grep -c "//" {} \\;');
    assert.strictEqual(t.observe('find src -name "*.ts" -exec grep -n "//" {} \\;'), true);
    // Same shape — should NOT fire again because we already nudged for this cluster.
    assert.strictEqual(t.observe('find src -name "*.ts" -exec grep -l "//" {} \\;'), false);
  });

  it('re-arms the nudge for a different command cluster after the first nudge', () => {
    const t = new BashDedupTracker();
    t.observe('find src -name "*.ts" -exec wc -l {} \\;');
    t.observe('find src -name "*.ts" -exec grep -c "//" {} \\;');
    t.observe('find src -name "*.ts" -exec grep -n "//" {} \\;'); // first cluster nudges
    // Different shape, different cluster. Builds a new triplet.
    t.observe('git status');
    t.observe('git status -s');
    // Third in this cluster should fire a fresh nudge — the previous nudge
    // was for the find pattern, not for this one.
    assert.strictEqual(t.observe('git status --porcelain'), true);
  });

  it('exposes the recent-commands window', () => {
    const t = new BashDedupTracker();
    t.observe('a');
    t.observe('b');
    t.observe('c');
    assert.deepStrictEqual(t.recentCommands(), ['a', 'b', 'c']);
  });
});
