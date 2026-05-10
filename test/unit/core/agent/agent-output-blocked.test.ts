import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createMockProvider, collectEvents, findEvents } from './agent-helpers.js';

// run-agent.ts maps two provider-side terminal reasons onto the
// `output-blocked` event:
//   OpenAI    `content_filter` — output classified as policy-violating
//   Anthropic `refusal`        — Claude declined the request mid-turn (4.x)
// The mapping is deliberately small; verify each one fires and that the
// raw reason flows through to the event payload (UI uses it to choose the
// notice text).

describe('Agent loop — output-blocked event', () => {
  it('emits output-blocked with reason="content_filter" when provider terminates with content_filter', async () => {
    const provider = createMockProvider([
      { content: 'Partial answer cut off because of policy', doneReason: 'content_filter' },
    ]);
    const events = await collectEvents('hi', provider);

    const blocked = findEvents(events, 'output-blocked');
    assert.strictEqual(blocked.length, 1, 'expected exactly one output-blocked event');
    assert.strictEqual((blocked[0] as { reason: string }).reason, 'content_filter');

    // Turn still completes — the event is a notice, not a hard abort.
    const complete = findEvents(events, 'turn-complete');
    assert.strictEqual(complete.length, 1);
  });

  it('emits output-blocked with reason="refusal" when provider terminates with refusal', async () => {
    const provider = createMockProvider([
      { content: 'I cannot help with that.', doneReason: 'refusal' },
    ]);
    const events = await collectEvents('hi', provider);

    const blocked = findEvents(events, 'output-blocked');
    assert.strictEqual(blocked.length, 1);
    assert.strictEqual((blocked[0] as { reason: string }).reason, 'refusal');
  });

  it('does not emit output-blocked for natural stops', async () => {
    // doneReason='stop' (OpenAI natural completion) and undefined doneReason
    // both must be silent; only the policy-block reasons trigger the event.
    const naturalStop = createMockProvider([{ content: 'Done.', doneReason: 'stop' }]);
    const naturalUnset = createMockProvider([{ content: 'Done.' }]);

    const a = await collectEvents('hi', naturalStop);
    const b = await collectEvents('hi', naturalUnset);

    assert.strictEqual(findEvents(a, 'output-blocked').length, 0);
    assert.strictEqual(findEvents(b, 'output-blocked').length, 0);
  });

  it('does not double-fire when both length and a refusal-class reason would apply', async () => {
    // Defensive: only one of the branches in run-agent.ts should match a
    // given doneReason. Here we pick `length` and confirm output-blocked
    // does not fire (output-cap-reached should fire instead).
    const provider = createMockProvider([
      { content: 'truncated', doneReason: 'length' },
    ]);
    const events = await collectEvents('hi', provider);

    assert.strictEqual(findEvents(events, 'output-blocked').length, 0);
    assert.strictEqual(findEvents(events, 'output-cap-reached').length, 1);
  });
});
