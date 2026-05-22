import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StepEnforcer, collectPrereqs, validatePrereqReferences } from '../../../../src/core/agent/step-enforcer.js';
import {
  StepEnforcementError,
  PrerequisiteError,
} from '../../../../src/core/agent/errors.js';
import type { ToolDefinition } from '../../../../src/utils/tool-definition.js';

function call(name: string, args: Record<string, unknown> = {}) {
  return { function: { name, arguments: args } };
}

describe('StepEnforcer — premature terminal', () => {
  it('passes when required steps satisfied', () => {
    const enf = new StepEnforcer({
      requiredSteps: ['Read'],
      terminalTools: ['Respond'],
      prereqs: new Map(),
    });
    enf.record('Read', { file_path: '/x' });
    const check = enf.check([call('Respond', { message: 'done' })]);
    assert.equal(check.needsNudge, false);
  });

  it('emits tier 1 nudge on first premature attempt', () => {
    const enf = new StepEnforcer({
      requiredSteps: ['Read'],
      terminalTools: ['Respond'],
      prereqs: new Map(),
    });
    const check = enf.check([call('Respond')]);
    assert.equal(check.needsNudge, true);
    assert.equal(check.nudge?.tier, 1);
    assert.equal(check.nudge?.kind, 'step');
  });

  it('escalates tiers on repeated attempts', () => {
    const enf = new StepEnforcer({
      requiredSteps: ['Read'],
      terminalTools: ['Respond'],
      prereqs: new Map(),
      maxPrematureAttempts: 3,
    });
    assert.equal(enf.check([call('Respond')]).nudge?.tier, 1);
    assert.equal(enf.check([call('Respond')]).nudge?.tier, 2);
    assert.equal(enf.check([call('Respond')]).nudge?.tier, 3);
  });

  it('throws StepEnforcementError after max attempts', () => {
    const enf = new StepEnforcer({
      requiredSteps: ['Read'],
      terminalTools: ['Respond'],
      prereqs: new Map(),
      maxPrematureAttempts: 2,
    });
    enf.check([call('Respond')]);
    enf.check([call('Respond')]);
    assert.throws(() => enf.check([call('Respond')]), StepEnforcementError);
  });

  it('resetCounters() lets a clean batch un-stick the tier counter', () => {
    const enf = new StepEnforcer({
      requiredSteps: ['Read'],
      terminalTools: ['Respond'],
      prereqs: new Map(),
      maxPrematureAttempts: 3,
    });
    enf.check([call('Respond')]); // tier 1
    enf.resetCounters();
    const next = enf.check([call('Respond')]);
    assert.equal(next.nudge?.tier, 1);
  });
});

describe('StepEnforcer — prerequisites', () => {
  it('name-only prereq passes after the prereq tool runs', () => {
    const enf = new StepEnforcer({
      requiredSteps: [],
      terminalTools: [],
      prereqs: new Map([['Edit', ['Read']]]),
    });
    enf.record('Read', { file_path: '/x' });
    const check = enf.checkPrerequisites([call('Edit', { file_path: '/x' })]);
    assert.equal(check.needsNudge, false);
  });

  it('name-only prereq fails before the prereq tool runs', () => {
    const enf = new StepEnforcer({
      requiredSteps: [],
      terminalTools: [],
      prereqs: new Map([['Edit', ['Read']]]),
    });
    const check = enf.checkPrerequisites([call('Edit', { file_path: '/x' })]);
    assert.equal(check.needsNudge, true);
    assert.equal(check.nudge?.kind, 'prerequisite');
    assert.ok(check.nudge?.content.includes('Read'));
  });

  it('arg-matched prereq passes only with the matching arg value', () => {
    const enf = new StepEnforcer({
      requiredSteps: [],
      terminalTools: [],
      prereqs: new Map([['Edit', [{ tool: 'Read', matchArg: 'file_path' }]]]),
    });
    enf.record('Read', { file_path: '/x' });
    // Different path → still violated
    const wrong = enf.checkPrerequisites([call('Edit', { file_path: '/y' })]);
    assert.equal(wrong.needsNudge, true);
    // Matching path → cleared
    const right = enf.checkPrerequisites([call('Edit', { file_path: '/x' })]);
    assert.equal(right.needsNudge, false);
  });

  it('throws PrerequisiteError after max violations', () => {
    const enf = new StepEnforcer({
      requiredSteps: [],
      terminalTools: [],
      prereqs: new Map([['Edit', ['Read']]]),
      maxPrereqViolations: 1,
    });
    enf.checkPrerequisites([call('Edit')]);
    assert.throws(() => enf.checkPrerequisites([call('Edit')]), PrerequisiteError);
  });
});

describe('validatePrereqReferences', () => {
  it('passes when every prereq resolves', () => {
    const defs: ToolDefinition[] = [
      { type: 'function', function: { name: 'Read', description: '', parameters: {} } },
      {
        type: 'function',
        function: { name: 'Edit', description: '', parameters: {} },
        prerequisites: ['Read'],
      },
    ];
    assert.doesNotThrow(() => validatePrereqReferences(defs));
  });

  it('throws TypeError listing unknown prereqs', () => {
    const defs: ToolDefinition[] = [
      {
        type: 'function',
        function: { name: 'Edit', description: '', parameters: {} },
        prerequisites: ['NonExistent', { tool: 'AlsoMissing', matchArg: 'x' }],
      },
    ];
    assert.throws(
      () => validatePrereqReferences(defs),
      (err: Error) =>
        err instanceof TypeError &&
        err.message.includes('NonExistent') &&
        err.message.includes('AlsoMissing'),
    );
  });
});

describe('collectPrereqs', () => {
  it('builds a map of toolName → prereqs', () => {
    const defs: ToolDefinition[] = [
      { type: 'function', function: { name: 'Read', description: '', parameters: {} } },
      {
        type: 'function',
        function: { name: 'Edit', description: '', parameters: {} },
        prerequisites: ['Read'],
      },
    ];
    const map = collectPrereqs(defs);
    assert.equal(map.has('Edit'), true);
    assert.equal(map.has('Read'), false);
    assert.deepEqual([...(map.get('Edit') ?? [])], ['Read']);
  });
});
