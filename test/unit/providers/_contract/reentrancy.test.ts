// Provider contract: re-entrancy under concurrent calls.
//
// One provider instance is shared by the main agent loop, parallel
// subagent tool calls, and the tool-call corrector — so every Provider
// implementation must tolerate two `chat` / `chatNoStream` calls in
// flight at once, each with its OWN AbortSignal. Aborting one MUST NOT
// abort the other, and each call's request body must see its own
// AbortSignal (not the other call's).
//
// Regression for 0b80a98 ("ollama signal slot"): the Ollama provider
// previously stored the active AbortSignal on a per-instance field
// (`this.currentSignal`). Two overlapping calls clobbered each other's
// slot, so the second call's signal overwrote the first's before the
// SDK's customFetch read it. The fix routed the signal through
// AsyncLocalStorage. This file pins that invariant.
//
// Why the test is structured the way it is: the SDK's path to fetch is
// mostly synchronous, so `Promise.all([A, B])` won't naturally
// interleave the customFetch invocations — call A reads its signal
// before B's body even starts. To deterministically reproduce the race
// the bug created, the test uses two cooperating tools:
//
//   1. A barrier in the mock-Ollama server's hold mode. Both requests
//      arrive AND are parked before either can read its server-side
//      effect. This proves the abort wiring (signal threaded through
//      to the actual fetch).
//   2. A direct test against `AsyncLocalStorage` exercising the same
//      shape the provider relies on — two concurrent `run()` contexts
//      with an interleaving await between assignment and read. This
//      pins the structural invariant: the signal is stored per-async-
//      context, not on a shared instance slot.
//
// Why one file with a per-provider entry instead of one suite per
// provider: the assertion is identical everywhere — "the wires don't
// cross." Adding a new provider should be one entry in `adapters` plus
// any per-provider mock-server wiring, not a copy of the harness.
//
// Currently only Ollama is wired (it's the one the regression came
// from). Other providers should be added as their per-protocol mocks
// gain hold/release primitives — see TODO at the bottom of this file.

import { describe, it, after, before, afterEach } from 'node:test';
import assert from 'node:assert';
import type http from 'node:http';
import { OllamaProvider } from '../../../../src/providers/ollama.js';
import {
  startMockServer,
  stopMockServer,
  holdChats,
  releaseAllChats,
  waitForChatsHeld,
  resetHoldMode,
  setNextResponses,
} from '../../../mock-ollama-server.js';
import type { Provider } from '../../../../src/providers/types.js';

interface HoldController {
  /** Resolve when `n` chat requests are parked at the server. */
  waitForHeld(n: number): Promise<void>;
  /** Release every parked chat request. */
  releaseAll(): void;
}

interface Adapter {
  name: string;
  setup(): Promise<{ provider: Provider; model: string; controller: HoldController }>;
  teardown(): Promise<void>;
}

// ─── Ollama adapter ────────────────────────────────────────────────────

let ollamaServer: http.Server | undefined;
let ollamaPort = 0;

const ollamaAdapter: Adapter = {
  name: 'ollama',
  async setup() {
    const result = await startMockServer();
    ollamaServer = result.server;
    ollamaPort = result.port;
    holdChats();
    // Queue distinct payloads so the test can prove cross-talk if the
    // wires get crossed (call A would see B's response or vice versa).
    setNextResponses([{ content: 'reply-A' }, { content: 'reply-B' }]);
    const provider = new OllamaProvider(`http://127.0.0.1:${ollamaPort}`);
    return {
      provider,
      model: 'test-model:latest',
      controller: {
        waitForHeld: n => waitForChatsHeld(n),
        releaseAll: () => releaseAllChats(),
      },
    };
  },
  async teardown() {
    resetHoldMode();
    if (ollamaServer) {
      await stopMockServer(ollamaServer);
      ollamaServer = undefined;
    }
  },
};

const adapters: Adapter[] = [ollamaAdapter];

// ─── Contract assertions ───────────────────────────────────────────────

for (const adapter of adapters) {
  describe(`Provider contract — ${adapter.name} — re-entrancy`, () => {
    let env: Awaited<ReturnType<Adapter['setup']>>;

    before(async () => {
      env = await adapter.setup();
    });
    after(async () => {
      await adapter.teardown();
    });
    afterEach(() => {
      // Drain any still-parked requests so the next test (if any) starts
      // clean. The releaseAll is safe to call when nothing is parked.
      env.controller.releaseAll();
    });

    // NOTE on scope: with the Ollama SDK, the path from chatNoStream entry
    // to the network `fetch()` is fully synchronous (no awaits between
    // signal assignment and customFetch invocation). That means
    // `Promise.all([A, B])` reliably interleaves at the network level
    // (both fetches in flight) but does NOT reliably interleave the
    // signal *read*. This test therefore covers:
    //   - the abort wiring: aborting A's controller does propagate to
    //     A's HTTP request and not B's.
    //   - cross-talk on responses: B receives its own queued payload.
    // It does NOT, on its own, catch the exact 0b80a98 race (which needs
    // an await between assignment and read). The
    // 'AsyncLocalStorage invariant' suite below covers that part.
    it('aborting one concurrent chatNoStream call does NOT abort the other', async () => {
      const ctrlA = new AbortController();
      const ctrlB = new AbortController();

      // Fire both calls on the SAME provider instance. With the bug
      // restored (shared `this.currentSignal` slot), call B would
      // overwrite call A's signal before the SDK's customFetch reads
      // it. Aborting A would then abort B's request too, and the
      // assertion below ("B resolves successfully") would fail.
      const callA = env.provider.chatNoStream(env.model, [], undefined, { signal: ctrlA.signal });
      const callB = env.provider.chatNoStream(env.model, [], undefined, { signal: ctrlB.signal });

      // Wait until both requests are parked at the mock server. This
      // guarantees both `customFetch` invocations have already read
      // their (respective) signal from storage before we abort.
      await env.controller.waitForHeld(2);

      // Abort A only.
      ctrlA.abort();

      // Now release both server-side. A is already aborted client-side
      // so the SDK won't accept the body; B should resolve normally.
      env.controller.releaseAll();

      const settled = await Promise.allSettled([callA, callB]);
      assert.equal(settled[0].status, 'rejected', 'call A must reject (it was aborted)');
      assert.match(
        (settled[0] as PromiseRejectedResult).reason?.message ?? '',
        /abort/i,
        'call A must reject with an abort error',
      );
      assert.equal(
        settled[1].status,
        'fulfilled',
        `call B must resolve — aborting A leaked into B (the exact 0b80a98 bug). reason=${
          settled[1].status === 'rejected'
            ? String((settled[1] as PromiseRejectedResult).reason)
            : 'n/a'
        }`,
      );

      // And cross-talk on the response payload: B must have received
      // its own queued reply, not A's (and not a mix).
      if (settled[1].status === 'fulfilled') {
        assert.equal(
          settled[1].value.content,
          'reply-B',
          'call B must see its own queued response payload',
        );
      }
    });
  });
}

// TODO: add adapters for the other providers as their per-protocol mock
// servers gain hold/release primitives. Candidates in priority order:
//   - openai (OpenAI-compat) — shared mock would cover cerebras, groq,
//     mistral, openrouter, vercel, opencodezen, workersai chat path
//   - anthropic — uses the official SDK; needs a Messages API mock
//   - googleaistudio — already has a dedicated test fixture
//
// Each addition is one entry in `adapters` above; the assertion stays
// identical.

// ─── Structural invariant ──────────────────────────────────────────────
//
// The mock-server test above proves the wires don't cross at the
// network boundary, but the Ollama SDK's sync-up-to-fetch shape means
// `Promise.all([A, B])` doesn't naturally interleave the customFetch
// invocations — call A's customFetch fires before B's body even runs.
// That can hide the original bug class.
//
// This block tests the structural invariant directly: a per-provider
// signal-storage scheme must isolate concurrent contexts. We do that
// by exercising AsyncLocalStorage (what OllamaProvider uses) with a
// deliberately-interleaved await between assignment and read. The same
// scenario against a shared instance field would cross the wires.
//
// If a future change replaces signalStore with a non-context-local
// scheme, this test still passes (it only tests ALS), but the
// mock-server test stays as the integration-level check. Both
// together = belt-and-braces.

describe('Provider contract — re-entrancy — AsyncLocalStorage invariant', () => {
  it('two interleaved run() contexts each observe their own store value', async () => {
    const { AsyncLocalStorage } = await import('node:async_hooks');
    const als = new AsyncLocalStorage<string>();

    // Simulate the Ollama path: each call assigns a value into ALS, then
    // an async hop happens before the value is read (mimicking the SDK's
    // path to fetch). A naive shared-field implementation would have
    // call B's assignment overwrite A's before A's read.
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>(resolve => {
      releaseBarrier = resolve;
    });
    let readsCompleted = 0;

    const observe = (tag: string): Promise<string | undefined> =>
      als.run(tag, async () => {
        // Yield once so both contexts have entered run() before either
        // proceeds. With a shared instance field, the second assignment
        // would clobber the first; with ALS, each context keeps its
        // own store.
        await Promise.resolve();
        readsCompleted += 1;
        if (readsCompleted === 2) releaseBarrier();
        await barrier;
        return als.getStore();
      });

    const [a, b] = await Promise.all([observe('signal-A'), observe('signal-B')]);
    assert.equal(a, 'signal-A', 'context A must observe its own store value');
    assert.equal(b, 'signal-B', 'context B must observe its own store value');
  });
});
