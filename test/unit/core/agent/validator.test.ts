import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateResponse } from '../../../../src/core/agent/validator.js';
import {
  retryNudge,
  unknownToolNudge,
  stepNudge,
  prerequisiteNudge,
} from '../../../../src/core/agent/nudges.js';

describe('Nudge templates', () => {
  it('retryNudge is frozen and tagged correctly', () => {
    const n = retryNudge();
    assert.equal(n.role, 'user');
    assert.equal(n.kind, 'retry');
    assert.equal(n.tier, 1);
    assert.ok(n.content.includes('valid tool call'));
    assert.equal(Object.isFrozen(n), true);
  });

  it('unknownToolNudge lists available tools', () => {
    const n = unknownToolNudge('FooBar', ['Read', 'Write', 'Bash']);
    assert.equal(n.kind, 'unknown_tool');
    assert.ok(n.content.includes('FooBar'));
    assert.ok(n.content.includes('Read, Write, Bash'));
  });

  it('unknownToolNudge handles empty available list', () => {
    const n = unknownToolNudge('FooBar', []);
    assert.ok(n.content.includes('(none)'));
  });

  it('prerequisiteNudge lists missing prereqs', () => {
    const n = prerequisiteNudge('Edit', ['Read']);
    assert.equal(n.kind, 'prerequisite');
    assert.ok(n.content.includes('Edit'));
    assert.ok(n.content.includes('Read'));
  });

  it('stepNudge escalates phrasing across tiers', () => {
    const t1 = stepNudge('Respond', ['Read', 'Write'], 1);
    const t2 = stepNudge('Respond', ['Read', 'Write'], 2);
    const t3 = stepNudge('Respond', ['Read', 'Write'], 3);
    assert.equal(t1.tier, 1);
    assert.equal(t2.tier, 2);
    assert.equal(t3.tier, 3);
    assert.ok(t1.content.includes('required steps'));
    assert.ok(t2.content.startsWith('You must call'));
    assert.ok(t3.content.startsWith('STOP.'));
    assert.ok(t3.content.includes('MUST'));
  });
});

describe('validateResponse', () => {
  const toolNames = new Set(['Read', 'Bash']);

  it('returns toolCalls when all are known', () => {
    const result = validateResponse(
      [{ function: { name: 'Read', arguments: { file_path: '/x' } } }],
      '',
      { toolNames, enforceToolCall: true },
    );
    assert.equal(result.needsRetry, false);
    assert.deepEqual(result.toolCalls?.[0]?.function.name, 'Read');
  });

  it('emits unknown_tool nudge when a tool name is not registered', () => {
    const result = validateResponse(
      [{ function: { name: 'FooBar', arguments: {} } }],
      '',
      { toolNames, enforceToolCall: true },
    );
    assert.equal(result.needsRetry, true);
    assert.equal(result.nudge?.kind, 'unknown_tool');
    assert.ok(result.nudge?.content.includes('FooBar'));
    assert.equal(result.toolCalls, undefined);
  });

  it('emits retry nudge when text-only and enforceToolCall=true', () => {
    const result = validateResponse([], 'I would call Read here.', {
      toolNames,
      enforceToolCall: true,
    });
    assert.equal(result.needsRetry, true);
    assert.equal(result.nudge?.kind, 'retry');
  });

  it('does NOT emit retry nudge when enforceToolCall=false (frontier)', () => {
    const result = validateResponse([], 'Here is my answer in plain text.', {
      toolNames,
      enforceToolCall: false,
    });
    assert.equal(result.needsRetry, false);
    assert.equal(result.nudge, undefined);
  });

  it('case-insensitive tool name lookup', () => {
    const result = validateResponse([{ function: { name: 'read', arguments: {} } }], '', {
      toolNames: new Set(['Read']),
      enforceToolCall: true,
    });
    // Case insensitive — the validator should not flag this as unknown.
    assert.equal(result.needsRetry, false);
  });

  it('returns first unknown name when multiple are unknown', () => {
    const result = validateResponse(
      [
        { function: { name: 'X', arguments: {} } },
        { function: { name: 'Y', arguments: {} } },
      ],
      '',
      { toolNames, enforceToolCall: true },
    );
    assert.equal(result.needsRetry, true);
    assert.ok(result.nudge?.content.includes("'X'"));
    assert.ok(!result.nudge?.content.includes("'Y'"));
  });
});
