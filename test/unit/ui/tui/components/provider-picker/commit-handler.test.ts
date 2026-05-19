import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { makePickerCommitHandler } from '../../../../../../src/ui/tui/components/provider-picker/commit-handler.js';

// Regression tests for 42853ba — "fix(picker): close provider picker only
// after swap resolves". The bug: setPickerOpen(false) was called *before*
// awaiting setProviderByName(...). Because the parent <Session> gates
// TextInput on !pickerOpen, closing first un-gated input, letting a
// fast-typing user submit a prompt while refs.current.{provider,model}
// were still pointing at the old tuple — so the first post-pick turn went
// to the wrong provider. The fix chains setPickerOpen(false) onto
// setProviderByName's `.finally`. These tests pin the ordering and the
// compaction/fallback short-circuits that must NOT trigger a swap.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('makePickerCommitHandler — swap path (fix 42853ba)', () => {
  it('does NOT close the picker before setProviderByName resolves', async () => {
    const swap = defer<void>();
    const setProviderByName = mock.fn(() => swap.promise);
    const setPickerOpen = mock.fn();

    const handler = makePickerCommitHandler({
      setProviderByName,
      setPickerOpen,
    });

    handler('anthropic', 'claude-opus-4-7', 'key-1');

    // setProviderByName was invoked immediately.
    assert.equal(setProviderByName.mock.callCount(), 1);
    assert.deepEqual(setProviderByName.mock.calls[0]!.arguments, [
      'anthropic',
      'claude-opus-4-7',
      'key-1',
    ]);

    // Critical invariant: the picker is still open. If we close here, the
    // TextInput un-gates and the user can submit against stale refs.
    assert.equal(
      setPickerOpen.mock.callCount(),
      0,
      'setPickerOpen must not be called until setProviderByName resolves',
    );

    // Microtask flush — the bug-fix code uses `.finally`, so even after
    // queued microtasks but *before* the swap resolves, the picker stays
    // open.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(setPickerOpen.mock.callCount(), 0);

    // Now resolve the swap; the picker should close.
    swap.resolve();
    await swap.promise;
    // Let the `.finally` callback run.
    await Promise.resolve();
    assert.equal(setPickerOpen.mock.callCount(), 1);
    assert.deepEqual(setPickerOpen.mock.calls[0]!.arguments, [false]);
  });

  it('closes the picker after the swap settles, even on a slow resolution', async () => {
    // The production setProviderByName never rejects — swapProvider catches
    // every failure path internally and surfaces it via addNotice. The
    // invariant under test is purely temporal: setPickerOpen(false) must
    // not fire until the returned promise settles, no matter how delayed.
    const swap = defer<void>();
    const setProviderByName = mock.fn(() => swap.promise);
    const setPickerOpen = mock.fn();

    const handler = makePickerCommitHandler({
      setProviderByName,
      setPickerOpen,
    });
    handler('groq', 'gpt-oss-120b');

    // Drain several microtask + macrotask boundaries. setPickerOpen must
    // stay un-called the whole time.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(setPickerOpen.mock.callCount(), 0);

    swap.resolve();
    await swap.promise;
    await Promise.resolve();
    assert.equal(setPickerOpen.mock.callCount(), 1);
    assert.deepEqual(setPickerOpen.mock.calls[0]!.arguments, [false]);
  });

  it('forwards provider, model, and keyId to setProviderByName verbatim', async () => {
    const swap = defer<void>();
    const setProviderByName = mock.fn(() => swap.promise);
    const setPickerOpen = mock.fn();
    const handler = makePickerCommitHandler({ setProviderByName, setPickerOpen });

    handler('cerebras', 'qwen3-coder-480b', 'work-account');

    assert.deepEqual(setProviderByName.mock.calls[0]!.arguments, [
      'cerebras',
      'qwen3-coder-480b',
      'work-account',
    ]);
    swap.resolve();
    await swap.promise;
  });
});

describe('makePickerCommitHandler — short-circuit resolvers', () => {
  it('routes the choice to the compaction resolver and does NOT call setProviderByName or setPickerOpen', () => {
    const compactionPickerResolver = mock.fn();
    const setProviderByName = mock.fn(() => Promise.resolve());
    const setPickerOpen = mock.fn();

    const handler = makePickerCommitHandler({
      compactionPickerResolver,
      setProviderByName,
      setPickerOpen,
    });
    handler('anthropic', 'haiku', 'k');

    assert.equal(compactionPickerResolver.mock.callCount(), 1);
    assert.deepEqual(compactionPickerResolver.mock.calls[0]!.arguments[0], {
      providerName: 'anthropic',
      model: 'haiku',
    });
    assert.equal(setProviderByName.mock.callCount(), 0);
    assert.equal(setPickerOpen.mock.callCount(), 0);
  });

  it('routes the choice to the fallback resolver when no compaction resolver is set', () => {
    const fallbackPickerResolver = mock.fn();
    const setProviderByName = mock.fn(() => Promise.resolve());
    const setPickerOpen = mock.fn();

    const handler = makePickerCommitHandler({
      fallbackPickerResolver,
      setProviderByName,
      setPickerOpen,
    });
    handler('groq', 'gpt-oss-120b');

    assert.equal(fallbackPickerResolver.mock.callCount(), 1);
    assert.deepEqual(fallbackPickerResolver.mock.calls[0]!.arguments[0], {
      provider: 'groq',
      model: 'gpt-oss-120b',
    });
    assert.equal(setProviderByName.mock.callCount(), 0);
    assert.equal(setPickerOpen.mock.callCount(), 0);
  });

  it('compaction resolver takes precedence over fallback resolver', () => {
    const compactionPickerResolver = mock.fn();
    const fallbackPickerResolver = mock.fn();
    const setProviderByName = mock.fn(() => Promise.resolve());
    const setPickerOpen = mock.fn();

    const handler = makePickerCommitHandler({
      compactionPickerResolver,
      fallbackPickerResolver,
      setProviderByName,
      setPickerOpen,
    });
    handler('anthropic', 'sonnet');

    assert.equal(compactionPickerResolver.mock.callCount(), 1);
    assert.equal(fallbackPickerResolver.mock.callCount(), 0);
  });
});
