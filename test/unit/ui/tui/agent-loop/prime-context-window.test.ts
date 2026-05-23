import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import type { MutableRefObject } from 'react';
import { primeContextWindowFromActiveProvider } from '../../../../../src/ui/tui/agent-loop/prime-context-window.js';
import type { RunRefs } from '../../../../../src/ui/tui/agent-loop/agent-loop-types.js';
import type { Provider, ProviderCapabilities } from '../../../../../src/providers/types.js';

// Pinned-behavior tests for the prime helper that backs both mount-time
// (setup.ts) and post-swap (swap.ts) priming of the active provider's
// context window. The helper is fire-and-forget; tests await the resolved
// prime via the returned promise on the fake to assert ordering.

function caps(contextWindow: number): ProviderCapabilities {
  return {
    contextWindow,
    maxOutputTokens: 4_096,
    toolSupport: 'native',
    parallelToolCalls: true,
    streaming: true,
    tokenCounting: 'estimated',
    modelTier: 'medium',
  };
}

interface FakeProvider extends Provider {
  resolvePrime: () => void;
  primePromise: Promise<void>;
}

/** Build a fake Provider whose `primeModelCache` returns a promise the
 *  test controls. After `resolvePrime()`, `getCapabilities` returns the
 *  primed contextWindow instead of the initial estimate. */
function fakeProviderWithPrime(name: string, estimate: number, primed: number): FakeProvider {
  let resolved = false;
  let resolveFn: (() => void) | undefined;
  const primePromise = new Promise<void>(r => {
    resolveFn = r;
  });
  const provider: FakeProvider = {
    name,
    async listModels() {
      return [];
    },
    getCapabilities() {
      return caps(resolved ? primed : estimate);
    },
    async *chat() {},
    async primeModelCache() {
      await primePromise;
      resolved = true;
    },
    resolvePrime: () => resolveFn!(),
    primePromise,
  } as unknown as FakeProvider;
  return provider;
}

/** Build a fake Provider without `primeModelCache`. */
function fakeProviderNoPrime(name: string): Provider {
  return {
    name,
    async listModels() {
      return [];
    },
    getCapabilities() {
      return caps(200_000);
    },
    async *chat() {},
  } as unknown as Provider;
}

function fakeRefs(provider: Provider, model = 'm'): RunRefs {
  return {
    provider,
    model,
    contextManager: {
      setContextWindow: mock.fn(),
    },
  } as unknown as RunRefs;
}

/** Drain microtasks so a fire-and-forget `void promise.then(...)` settles. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('primeContextWindowFromActiveProvider', () => {
  it('no-ops when refs.current is null', () => {
    const refs: MutableRefObject<RunRefs | null> = { current: null };
    const setContextWindow = mock.fn();
    primeContextWindowFromActiveProvider(refs, setContextWindow);
    assert.equal(setContextWindow.mock.callCount(), 0);
  });

  it('no-ops when the provider has no primeModelCache hook', async () => {
    const provider = fakeProviderNoPrime('anthropic');
    const refs: MutableRefObject<RunRefs | null> = { current: fakeRefs(provider) };
    const setContextWindow = mock.fn();
    primeContextWindowFromActiveProvider(refs, setContextWindow);
    await flush();
    assert.equal(setContextWindow.mock.callCount(), 0);
    assert.equal(
      (
        refs.current!.contextManager.setContextWindow as unknown as ReturnType<typeof mock.fn>
      ).mock.callCount(),
      0,
    );
  });

  it('after prime resolves, pushes the new contextWindow into refs and React state', async () => {
    const provider = fakeProviderWithPrime('ollama', 16_384, 131_072);
    const refs: MutableRefObject<RunRefs | null> = { current: fakeRefs(provider, 'deepseek') };
    const setContextWindow = mock.fn();
    primeContextWindowFromActiveProvider(refs, setContextWindow);

    // Nothing yet — prime is still pending.
    await flush();
    assert.equal(setContextWindow.mock.callCount(), 0);

    provider.resolvePrime();
    await flush();

    assert.deepEqual(
      setContextWindow.mock.calls.map(c => c.arguments),
      [[131_072]],
    );
    const cmCalls = (
      refs.current!.contextManager.setContextWindow as unknown as ReturnType<typeof mock.fn>
    ).mock.calls;
    assert.deepEqual(
      cmCalls.map(c => c.arguments),
      [[131_072]],
      'ContextManager.setContextWindow must receive the primed value',
    );
  });

  it('discards the prime result if the model changed mid-flight', async () => {
    const provider = fakeProviderWithPrime('ollama', 16_384, 131_072);
    const refs: MutableRefObject<RunRefs | null> = { current: fakeRefs(provider, 'deepseek') };
    const setContextWindow = mock.fn();
    primeContextWindowFromActiveProvider(refs, setContextWindow);

    // Simulate a /model swap before the prime resolves.
    refs.current!.model = 'qwen';

    provider.resolvePrime();
    await flush();

    assert.equal(setContextWindow.mock.callCount(), 0, 'stale prime must not update React state');
    assert.equal(
      (
        refs.current!.contextManager.setContextWindow as unknown as ReturnType<typeof mock.fn>
      ).mock.callCount(),
      0,
      'stale prime must not update ContextManager',
    );
  });

  it('discards the prime result if the provider was swapped mid-flight', async () => {
    const provider = fakeProviderWithPrime('ollama', 16_384, 131_072);
    const refs: MutableRefObject<RunRefs | null> = { current: fakeRefs(provider, 'deepseek') };
    const setContextWindow = mock.fn();
    primeContextWindowFromActiveProvider(refs, setContextWindow);

    // Simulate a /provider swap before the prime resolves.
    refs.current!.provider = fakeProviderNoPrime('anthropic');

    provider.resolvePrime();
    await flush();

    assert.equal(setContextWindow.mock.callCount(), 0);
    assert.equal(
      (
        refs.current!.contextManager.setContextWindow as unknown as ReturnType<typeof mock.fn>
      ).mock.callCount(),
      0,
    );
  });

  it('discards the prime result if refs.current became null mid-flight (unmount)', async () => {
    const provider = fakeProviderWithPrime('ollama', 16_384, 131_072);
    const refs: MutableRefObject<RunRefs | null> = { current: fakeRefs(provider, 'deepseek') };
    const setContextWindow = mock.fn();
    primeContextWindowFromActiveProvider(refs, setContextWindow);

    refs.current = null;

    provider.resolvePrime();
    await flush();

    assert.equal(setContextWindow.mock.callCount(), 0);
  });
});
