import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryState, mergeRecoveryClones } from '../../../../src/core/agent/recovery-state.js';

/**
 * Per-pipeline clone+merge used by parallel Delegate batches. The race
 * the reviewer flagged (P0.2) was multiple pipelines read-modify-writing
 * the same RecoveryState. Clones isolate them; mergeRecoveryClones
 * folds the worst-of back into the parent deterministically.
 */
describe('RecoveryState.clone', () => {
  it('produces a deep copy of all mutable fields', () => {
    const r = new RecoveryState(3, 1, 2);
    r.lastFailureMessage = 'boom';
    r.lastFailureSignature = 'Bash:{}';
    r.consecutiveSameFailures = 2;
    r.correctionsUsedThisRun = 1;
    r.correctedSignatures.add('Read:{}');
    r.consecutiveHardToolErrors = 1;
    r.lastHardToolName = 'Bash';
    r.lastHardToolMessage = 'broken';

    const c = r.clone();
    assert.equal(c.lastFailureMessage, 'boom');
    assert.equal(c.consecutiveSameFailures, 2);
    assert.equal(c.correctionsUsedThisRun, 1);
    assert.ok(c.correctedSignatures.has('Read:{}'));
    assert.equal(c.consecutiveHardToolErrors, 1);

    // Mutations on the clone must not bleed into the parent.
    c.correctedSignatures.add('Write:{}');
    c.consecutiveHardToolErrors = 5;
    c.lastFailureMessage = 'changed';
    assert.equal(r.correctedSignatures.has('Write:{}'), false);
    assert.equal(r.consecutiveHardToolErrors, 1);
    assert.equal(r.lastFailureMessage, 'boom');
  });
});

describe('mergeRecoveryClones', () => {
  it('takes the max of hard-error and same-failure counters', () => {
    const parent = new RecoveryState(3, 5, 2);
    const a = parent.clone();
    const b = parent.clone();
    a.consecutiveHardToolErrors = 1;
    a.consecutiveSameFailures = 0;
    b.consecutiveHardToolErrors = 2;
    b.consecutiveSameFailures = 3;
    mergeRecoveryClones(parent, [a, b]);
    assert.equal(parent.consecutiveHardToolErrors, 2);
    assert.equal(parent.consecutiveSameFailures, 3);
  });

  it('takes the first failing sibling in batch order for last* fields', () => {
    const parent = new RecoveryState(3, 5, 2);
    const a = parent.clone();
    const b = parent.clone();
    const c = parent.clone();
    // a clean, b failed, c also failed — first failure wins ordering.
    b.lastFailureMessage = 'b-failed';
    b.lastFailureSignature = 'B:{}';
    b.lastHardToolName = 'B';
    b.lastHardToolMessage = 'b broken';
    b.consecutiveHardToolErrors = 1;
    c.lastFailureMessage = 'c-failed';
    c.lastFailureSignature = 'C:{}';
    c.consecutiveHardToolErrors = 1;
    mergeRecoveryClones(parent, [a, b, c]);
    assert.equal(parent.lastFailureMessage, 'b-failed');
    assert.equal(parent.lastFailureSignature, 'B:{}');
    assert.equal(parent.lastHardToolName, 'B');
    assert.equal(parent.lastHardToolMessage, 'b broken');
  });

  it('clears last* fields when every sibling ended clean', () => {
    const parent = new RecoveryState(3, 5, 2);
    parent.lastFailureMessage = 'stale';
    parent.lastFailureSignature = 'Stale:{}';
    parent.lastHardToolName = 'Stale';
    parent.lastHardToolMessage = 'stale-msg';
    const a = parent.clone();
    const b = parent.clone();
    a.lastFailureMessage = null;
    a.lastFailureSignature = null;
    a.lastHardToolName = null;
    a.lastHardToolMessage = null;
    b.lastFailureMessage = null;
    b.lastFailureSignature = null;
    b.lastHardToolName = null;
    b.lastHardToolMessage = null;
    mergeRecoveryClones(parent, [a, b]);
    assert.equal(parent.lastFailureMessage, null);
    assert.equal(parent.lastFailureSignature, null);
    assert.equal(parent.lastHardToolName, null);
    assert.equal(parent.lastHardToolMessage, null);
  });

  it('unions correctedSignatures across siblings', () => {
    const parent = new RecoveryState(3, 5, 2);
    parent.correctedSignatures.add('Pre:{}');
    const a = parent.clone();
    const b = parent.clone();
    a.correctedSignatures.add('A:{}');
    b.correctedSignatures.add('B:{}');
    mergeRecoveryClones(parent, [a, b]);
    assert.ok(parent.correctedSignatures.has('Pre:{}'));
    assert.ok(parent.correctedSignatures.has('A:{}'));
    assert.ok(parent.correctedSignatures.has('B:{}'));
  });

  it('sums per-pipeline correction deltas against the parent baseline', () => {
    const parent = new RecoveryState(3, 5, 2);
    parent.correctionsUsedThisRun = 1;
    const a = parent.clone();
    const b = parent.clone();
    // a burned one additional correction, b burned two more.
    a.correctionsUsedThisRun = 2;
    b.correctionsUsedThisRun = 3;
    mergeRecoveryClones(parent, [a, b]);
    assert.equal(parent.correctionsUsedThisRun, 1 + 1 + 2);
  });

  it('no-op when called with an empty clone list', () => {
    const parent = new RecoveryState(3, 5, 2);
    parent.consecutiveHardToolErrors = 1;
    parent.lastFailureMessage = 'untouched';
    mergeRecoveryClones(parent, []);
    assert.equal(parent.consecutiveHardToolErrors, 1);
    assert.equal(parent.lastFailureMessage, 'untouched');
  });
});
