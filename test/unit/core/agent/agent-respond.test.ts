import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Provider, ProviderCapabilities } from '../../../../src/providers/types.js';
import { collectEvents, createMockProvider, findEvents } from './agent-helpers.js';
import { TOOL_NAMES } from '../../../../src/tools/types.js';
import { defaultRegistry } from '../../../../src/tools/index.js';
import { _resetActivationLogForTests } from '../../../../src/core/agent/reliability-config.js';

function withTier(base: Provider, tier: ProviderCapabilities['modelTier']): Provider {
  return {
    ...base,
    getCapabilities: () => ({ ...base.getCapabilities('mock-model'), modelTier: tier }),
  };
}

test('weak-tier: single Respond call short-circuits to text-done + respond-stripped', async () => {
  _resetActivationLogForTests();
  const provider = withTier(
    createMockProvider([
      {
        tool_calls: [
          { function: { name: TOOL_NAMES.Respond, arguments: { message: 'hello world' } } },
        ],
      },
    ]),
    'weak',
  );

  const events = await collectEvents('hi', provider);
  const stripped = findEvents(events, 'respond-stripped');
  const textDone = findEvents(events, 'text-done');
  const completes = events.filter(
    e => e.type === 'turn-complete' && (e as { stopReason: string }).stopReason === 'completed',
  );

  assert.equal(stripped.length, 1, 'one respond-stripped event');
  assert.equal((stripped[0] as { message: string }).message, 'hello world');
  assert.equal(textDone.length, 1, 'one text-done emitted for the Respond message');
  assert.equal((textDone[0] as { fullContent: string }).fullContent, 'hello world');
  assert.equal(completes.length, 1, 'turn-complete with stopReason=completed');
  assert.equal(
    findEvents(events, 'tool-call-start').length,
    0,
    'Respond is short-circuited — no tool-call-start emitted',
  );
});

test('weak-tier: Respond is exposed on the wire (toolDefinitions includes it)', async () => {
  _resetActivationLogForTests();
  let observedToolDefs: { name: string }[] | undefined;
  const base = createMockProvider([{ content: 'noop' }]);
  const provider: Provider = {
    ...withTier(base, 'weak'),
    async *chat(model, messages, tools) {
      observedToolDefs = (tools ?? []).map(t => ({ name: t.function.name }));
      yield* base.chat(model, messages, tools);
    },
  };

  await collectEvents('hi', provider);

  const names = (observedToolDefs ?? []).map(t => t.name);
  assert.ok(
    names.includes(TOOL_NAMES.Respond),
    `Respond expected in tool defs, got: ${names.join(',')}`,
  );
});

test('strong-tier: Respond is excluded from the wire', async () => {
  _resetActivationLogForTests();
  let observedToolDefs: { name: string }[] | undefined;
  const base = createMockProvider([{ content: 'noop' }]);
  const provider: Provider = {
    ...withTier(base, 'strong'),
    async *chat(model, messages, tools) {
      observedToolDefs = (tools ?? []).map(t => ({ name: t.function.name }));
      yield* base.chat(model, messages, tools);
    },
  };

  await collectEvents('hi', provider);

  const names = (observedToolDefs ?? []).map(t => t.name);
  assert.ok(
    !names.includes(TOOL_NAMES.Respond),
    `Respond should be filtered out for strong-tier, got: ${names.join(',')}`,
  );
});

test('Respond handler is registered in the default registry', () => {
  const handler = defaultRegistry.get(TOOL_NAMES.Respond);
  assert.ok(handler, 'Respond handler should be present in defaultRegistry');
  assert.equal(handler!.name, TOOL_NAMES.Respond);
});

test('Respond.execute echoes the message', async () => {
  const handler = defaultRegistry.get(TOOL_NAMES.Respond)!;
  const result = await handler.execute({ message: 'echo me' });
  assert.equal(result.success, true);
  assert.equal(result.output, 'echo me');
});

test('Respond.execute fails without a message', async () => {
  const handler = defaultRegistry.get(TOOL_NAMES.Respond)!;
  const result = await handler.execute({});
  assert.equal(result.success, false);
});

test('weak-tier: mixed batch (Respond + other tool) falls through normal path', async () => {
  // Mixed batches do NOT short-circuit. The Respond call goes through the
  // tool executor (echoes), the other call runs, the model presumably calls
  // Respond again on the next turn. We assert the short-circuit didn't fire.
  _resetActivationLogForTests();
  const provider = withTier(
    createMockProvider([
      {
        tool_calls: [
          { function: { name: TOOL_NAMES.Respond, arguments: { message: 'wait' } } },
          { function: { name: TOOL_NAMES.Glob, arguments: { pattern: '*.md' } } },
        ],
      },
      { content: 'done' },
    ]),
    'weak',
  );

  const events = await collectEvents('hi', provider);
  const stripped = findEvents(events, 'respond-stripped');
  assert.equal(stripped.length, 0, 'mixed batch should NOT trigger short-circuit');
});
