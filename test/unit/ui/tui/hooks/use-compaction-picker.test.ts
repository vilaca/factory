import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import {
  makeOpenCompactionPicker,
  type CompactionPick,
  type CompactionResolver,
} from '../../../../../src/ui/tui/hooks/use-compaction-picker.js';

// Regression tests for the prevBox double-invocation bug:
// when `/compaction-model` is typed while a prior picker is still open,
// the old implementation called the previous public resolver to cancel
// it. That resolver's setCompactionPickerResolver(null) / setPickerOpen(false)
// cleanup got batched with the new invocation's writes and clobbered them
// — the picker closed and the new promise leaked. makeOpenCompactionPicker
// splits the cancel hook (resolves the prior promise, no setState) from
// the public resolver (does setState cleanup), so the batched writes never
// collide.

interface Harness {
  open: () => Promise<CompactionPick>;
  resolverCalls: (CompactionResolver | null)[];
  pickerOpenCalls: boolean[];
  currentResolver: () => CompactionResolver | null;
}

function makeHarness(): Harness {
  let resolver: CompactionResolver | null = null;
  const resolverCalls: (CompactionResolver | null)[] = [];
  const pickerOpenCalls: boolean[] = [];
  const setCompactionPickerResolver = (r: CompactionResolver | null) => {
    resolver = r;
    resolverCalls.push(r);
  };
  const setPickerOpen = (open: boolean) => {
    pickerOpenCalls.push(open);
  };
  const pendingCancelRef: { current: (() => void) | null } = { current: null };
  const open = makeOpenCompactionPicker(
    setCompactionPickerResolver,
    setPickerOpen,
    pendingCancelRef,
  );
  return {
    open,
    resolverCalls,
    pickerOpenCalls,
    currentResolver: () => resolver,
  };
}

describe('makeOpenCompactionPicker', () => {
  it('installs a resolver and opens the picker on a single call', () => {
    const h = makeHarness();
    const p = h.open();
    void p; // suppress unhandled-rejection lint; resolution tested below

    assert.equal(h.resolverCalls.length, 1);
    assert.equal(typeof h.resolverCalls[0], 'function');
    assert.deepEqual(h.pickerOpenCalls, [true]);
  });

  it('resolves the promise and clears state when the user picks', async () => {
    const h = makeHarness();
    const p = h.open();
    const pick = { providerName: 'anthropic', model: 'claude-opus-4-7' };
    h.currentResolver()!(pick);

    assert.deepEqual(await p, pick);
    // Two resolver writes: install + clear. Two picker writes: open + close.
    assert.deepEqual(
      h.resolverCalls.map(r => (r === null ? 'null' : 'fn')),
      ['fn', 'null'],
    );
    assert.deepEqual(h.pickerOpenCalls, [true, false]);
  });

  it('on a second call: cancels the first promise WITHOUT closing the picker', async () => {
    const h = makeHarness();
    const p1 = h.open();

    // Second invocation while the first is still in flight.
    const p2 = h.open();
    void p2; // resolved below via the new resolver

    // The first promise must settle with null (cancel path) so the
    // awaiting `/compaction-model` slash handler can unwind.
    assert.equal(await p1, null);

    // Critical invariant: setPickerOpen(false) must NOT have been called
    // between the two invocations. The old prevBox implementation called
    // the previous resolver, which closed the picker. The picker is
    // shared with the rotation-fallback flow and live across slash calls.
    assert.deepEqual(
      h.pickerOpenCalls,
      [true, true],
      'picker must stay open across a back-to-back /compaction-model',
    );

    // The currently-installed resolver must be the NEW one, not null.
    // Old buggy code would have null here (the previous resolver's cleanup
    // ran AFTER the new resolver was installed, batched-and-overwrote it).
    assert.equal(typeof h.currentResolver(), 'function');

    // Resolver writes in order: install R1, install R2. No null between.
    assert.deepEqual(
      h.resolverCalls.map(r => (r === null ? 'null' : 'fn')),
      ['fn', 'fn'],
    );
  });

  it('the second promise still resolves on a pick after a back-to-back open', async () => {
    const h = makeHarness();
    const p1 = h.open();
    const p2 = h.open();

    const pick = { providerName: 'openai', model: 'gpt-5' };
    h.currentResolver()!(pick);

    assert.equal(await p1, null);
    assert.deepEqual(await p2, pick);
  });

  it('a third invocation cancels the second pending promise too', async () => {
    const h = makeHarness();
    const p1 = h.open();
    const p2 = h.open();
    const p3 = h.open();
    void p3;

    assert.equal(await p1, null);
    assert.equal(await p2, null);

    // Still only one open=true sequence (no spurious close).
    assert.ok(
      h.pickerOpenCalls.every(o => o === true),
      'no false (close) call should fire during cascading cancels',
    );
  });
});

describe('useCompactionPicker wiring (smoke)', () => {
  it('exports the factory used by the hook with the documented signature', () => {
    // Light smoke test: ensure the factory still produces a `() => Promise`.
    // Pin the contract so the React hook can keep depending on it.
    const setResolver = mock.fn();
    const setPickerOpen = mock.fn();
    const open = makeOpenCompactionPicker(setResolver, setPickerOpen, { current: null });
    assert.equal(typeof open, 'function');
    const r = open();
    assert.ok(r instanceof Promise);
    // Settle the promise so node:test doesn't warn about unhandled rejections.
    const installedResolver = setResolver.mock.calls[0]!.arguments[0] as CompactionResolver;
    installedResolver(null);
    return r.then(v => assert.equal(v, null));
  });
});
