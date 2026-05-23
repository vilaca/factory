import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Provider, ProviderCapabilities } from '../../../../src/providers/types.js';
import { collectEvents, createMockProvider, findEvents } from './agent-helpers.js';
import { TOOL_NAMES } from '../../../../src/utils/tool-names.js';
import { _resetActivationLogForTests } from '../../../../src/core/agent/reliability-config.js';

function withTier(base: Provider, tier: ProviderCapabilities['modelTier']): Provider {
  return {
    ...base,
    getCapabilities: () => ({ ...base.getCapabilities('mock-model'), modelTier: tier }),
  };
}

test('weak-tier text-only response triggers retry_nudge (validator path)', async () => {
  _resetActivationLogForTests();
  // Turn 1: model emits plain text (no tool call).
  // Turn 2: model recovers with a Respond call → short-circuits.
  const provider = withTier(
    createMockProvider([
      { content: 'I would help with that.' },
      {
        tool_calls: [{ function: { name: TOOL_NAMES.Respond, arguments: { message: 'done' } } }],
      },
    ]),
    'weak',
  );

  const events = await collectEvents('hi', provider);
  const retries = findEvents(events, 'auto-retry-injected');
  assert.equal(retries.length, 1, 'one retry-nudge injected on text-only turn');
  assert.equal((retries[0] as { reason: string }).reason, 'retry');
  // After the retry, the second turn's Respond call short-circuits.
  const stripped = findEvents(events, 'respond-stripped');
  assert.equal(stripped.length, 1);
});

test('strong-tier text-only response does NOT trigger retry_nudge', async () => {
  _resetActivationLogForTests();
  const provider = withTier(createMockProvider([{ content: 'Plain text answer.' }]), 'strong');
  const events = await collectEvents('hi', provider);
  const retries = findEvents(events, 'auto-retry-injected');
  assert.equal(retries.length, 0, 'no retry-nudge for strong-tier text-only');
  const completes = events.filter(
    e => e.type === 'turn-complete' && (e as { stopReason: string }).stopReason === 'completed',
  );
  assert.equal(completes.length, 1);
});

test('weak-tier retry_nudge exhaustion falls through to turn-complete', async () => {
  _resetActivationLogForTests();
  // Three text-only responses in a row (budget = 3). The validator
  // injects retry_nudges twice (consuming budget 3 → 1), then on the
  // third text-only the budget hits 0 and the loop falls through to
  // turn-complete instead of looping forever.
  const provider = withTier(
    createMockProvider([
      { content: 'attempt 1' },
      { content: 'attempt 2' },
      { content: 'attempt 3' },
      { content: 'attempt 4' },
    ]),
    'weak',
  );
  const events = await collectEvents('hi', provider);
  const retries = findEvents(events, 'auto-retry-injected');
  assert.ok(retries.length <= 3, 'retry-nudge fires at most as many times as budget');
  const completes = events.filter(
    e => e.type === 'turn-complete' && (e as { stopReason: string }).stopReason === 'completed',
  );
  assert.equal(completes.length, 1, 'eventually completes once budget exhausts');
});
