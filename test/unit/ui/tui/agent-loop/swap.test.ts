import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import {
  swapModel,
  swapProvider,
  type SwapProviderDeps,
} from '../../../../../src/ui/tui/agent-loop/swap.js';
import type { RunRefs } from '../../../../../src/ui/tui/agent-loop/agent-loop-types.js';
import type { Provider, ProviderCapabilities } from '../../../../../src/providers/types.js';
import type { ProviderDescriptor } from '../../../../../src/providers/registry.js';

// Regression tests for cf880ed — "fix(swap): prime listModels() before
// getCapabilities() on provider swap". The bug: swapProvider() only called
// listModels() when no model was supplied; with an explicit `requestedModel`,
// listModels() was skipped, leaving the freshly-created provider's model-info
// cache empty. The very next step (rebuildContextManager → getCapabilities)
// then hit the Anthropic guard with an unhandled rejection. These tests pin
// the invariant: after a fresh createProvider(), listModels() runs before
// any getCapabilities() call, regardless of whether a model was requested.

interface CallLog {
  order: string[];
}

function fakeCapabilities(): ProviderCapabilities {
  return {
    contextWindow: 100_000,
    maxOutputTokens: 4_096,
    toolSupport: 'native',
    parallelToolCalls: true,
    streaming: true,
    tokenCounting: 'estimated',
    modelTier: 'medium',
  };
}

/** Build a fake Provider that records the order in which its methods are
 *  called. listModels resolves with a fixed list; getCapabilities returns a
 *  stub. */
function fakeProvider(
  name: string,
  log: CallLog,
  opts: { models?: string[]; listModelsThrows?: Error } = {},
): Provider {
  const models = opts.models ?? ['default-model', 'other-model'];
  return {
    name,
    async listModels() {
      log.order.push(`${name}:listModels`);
      if (opts.listModelsThrows) throw opts.listModelsThrows;
      return models;
    },
    getCapabilities(_model: string) {
      log.order.push(`${name}:getCapabilities`);
      return fakeCapabilities();
    },
    async getModelInfo(_model: string) {
      log.order.push(`${name}:getModelInfo`);
      return { supportsTools: true };
    },
    // Required by Provider but not exercised here.
    async *chat() {
      // no-op
    },
  } as unknown as Provider;
}

/** Minimum RunRefs shape exercised by swapProvider's happy path. Cast through
 *  unknown to satisfy the wide type without standing up every dependency. */
function fakeRefs(initialProvider: Provider): RunRefs {
  return {
    provider: initialProvider,
    model: 'initial-model',
    primary: { provider: initialProvider.name, model: 'initial-model' },
    useTextToolFallback: false,
    nativeToolSupport: true,
    conversation: {
      // ContextManager only reads from conversation lazily; an empty shell
      // suffices for the constructor.
    },
    sessionLogger: {
      logModelChange: mock.fn(),
      logSystemPromptChange: mock.fn(),
      logSystemPrompt: mock.fn(),
    },
    keyFailureLog: new Map(),
    rotationPromptDeclined: false,
    replayCounts: new Map(),
    tokenLimitReplayCounts: new Map(),
    inputQueue: [],
    historyIndex: 0,
    historyDraft: '',
    pastHistory: [],
    enableCorrector: false,
    planMode: false,
    experimental: {},
    rotation: { keysEnabled: false, modelsEnabled: false, default: [], overrides: {} },
    gitBranch: undefined,
    gitDirty: null,
    cwd: '/tmp',
    lastSubstantivePrompt: null,
    baseSystemPrompt: '',
    pathPolicy: { deny: [] },
    envPolicy: { allow: [], allowPrefixes: [], deny: [], denyPrefixes: [] },
  } as unknown as RunRefs;
}

function fakeDescriptor(name: string): ProviderDescriptor {
  return {
    name,
    aliases: [name.toLowerCase()],
    label: name,
    needsAccountId: false,
  } as unknown as ProviderDescriptor;
}

interface Harness {
  ctx: Parameters<typeof swapProvider>[3];
  deps: SwapProviderDeps;
  log: CallLog;
  notices: { level: string; text: string }[];
  nextProvider: Provider;
  refs: RunRefs;
}

function makeHarness(
  opts: {
    nextProviderName?: string;
    nextProviderModels?: string[];
    createProviderThrows?: Error;
    listModelsThrows?: Error;
    validation?:
      | { mode: 'native' }
      | { mode: 'fallback'; warning: string }
      | { mode: 'unreachable'; reason: string };
  } = {},
): Harness {
  const log: CallLog = { order: [] };
  const notices: { level: string; text: string }[] = [];
  const initial = fakeProvider('initial', log);
  const refs = fakeRefs(initial);
  const nextName = opts.nextProviderName ?? 'fakeprov';
  const nextProvider = fakeProvider(nextName, log, {
    models: opts.nextProviderModels,
    listModelsThrows: opts.listModelsThrows,
  });

  const ctx = {
    refs: { current: refs },
    opts: {},
    addNotice: (level: string, text: string) => {
      notices.push({ level, text });
    },
    setModel: mock.fn(),
    setProviderName: mock.fn(),
    setContextWindow: mock.fn(),
    refreshTokenEstimate: mock.fn(),
    composeSystemPrompt: mock.fn(() => 'sp'),
  } as unknown as Parameters<typeof swapProvider>[3];

  const deps: SwapProviderDeps = {
    createProvider: mock.fn((name: string) => {
      log.order.push(`createProvider:${name}`);
      if (opts.createProviderThrows) throw opts.createProviderThrows;
      return nextProvider;
    }) as unknown as SwapProviderDeps['createProvider'],
    descriptorByAlias: mock.fn((alias: string) =>
      fakeDescriptor(alias),
    ) as unknown as SwapProviderDeps['descriptorByAlias'],
    loadGlobalConfig: mock.fn(
      async () => ({}) as unknown as Awaited<ReturnType<SwapProviderDeps['loadGlobalConfig']>>,
    ),
    getKey: mock.fn(() => undefined) as unknown as SwapProviderDeps['getKey'],
    validateModelToolSupport: mock.fn(async () => opts.validation ?? { mode: 'native' }),
  };
  return { ctx, deps, log, notices, nextProvider, refs };
}

describe('swapProvider — listModels priming invariant (cf880ed)', () => {
  it('calls listModels before getCapabilities when an explicit model is supplied', async () => {
    const h = makeHarness();
    await swapProvider('fakeprov', 'explicit-model', undefined, h.ctx, h.deps);

    const listIdx = h.log.order.indexOf('fakeprov:listModels');
    const capsIdx = h.log.order.indexOf('fakeprov:getCapabilities');
    assert.notEqual(listIdx, -1, 'listModels must run on the new provider');
    assert.notEqual(capsIdx, -1, 'getCapabilities must run during context rebuild');
    assert.ok(
      listIdx < capsIdx,
      `listModels (idx ${listIdx}) must precede getCapabilities (idx ${capsIdx}). order=${JSON.stringify(h.log.order)}`,
    );
  });

  it('calls listModels before getCapabilities when no model is supplied (picks default)', async () => {
    const h = makeHarness({ nextProviderModels: ['picked-default', 'other'] });
    await swapProvider('fakeprov', undefined, undefined, h.ctx, h.deps);

    const listIdx = h.log.order.indexOf('fakeprov:listModels');
    const capsIdx = h.log.order.indexOf('fakeprov:getCapabilities');
    assert.ok(listIdx >= 0 && capsIdx > listIdx);
    // Sanity: when no model is supplied, the first listed model wins.
    assert.equal(h.refs.model, 'picked-default');
  });

  it('uses the requested model (not the listModels result) when both are present', async () => {
    const h = makeHarness({ nextProviderModels: ['would-be-default'] });
    await swapProvider('fakeprov', 'explicit-model', undefined, h.ctx, h.deps);
    assert.equal(h.refs.model, 'explicit-model');
  });

  it('listModels runs exactly once per swap', async () => {
    const h = makeHarness();
    await swapProvider('fakeprov', 'explicit-model', undefined, h.ctx, h.deps);
    const count = h.log.order.filter(o => o === 'fakeprov:listModels').length;
    assert.equal(count, 1);
  });
});

describe('swapProvider — error paths', () => {
  it('surfaces a "Cannot list models" notice and does NOT call getCapabilities when listModels throws', async () => {
    const h = makeHarness({ listModelsThrows: new Error('network down') });
    await swapProvider('fakeprov', 'explicit-model', undefined, h.ctx, h.deps);

    assert.ok(
      !h.log.order.includes('fakeprov:getCapabilities'),
      'getCapabilities must not run when listModels failed',
    );
    const danger = h.notices.find(n => n.level === 'danger');
    assert.ok(danger, 'expected a danger notice');
    assert.match(danger!.text, /Cannot list models for fakeprov/);
    assert.match(danger!.text, /network down/);
  });

  it('does not call listModels when createProvider itself throws', async () => {
    const h = makeHarness({ createProviderThrows: new Error('no token') });
    await swapProvider('fakeprov', 'explicit-model', undefined, h.ctx, h.deps);

    assert.ok(!h.log.order.includes('fakeprov:listModels'));
    assert.ok(!h.log.order.includes('fakeprov:getCapabilities'));
    const danger = h.notices.find(n => n.level === 'danger');
    assert.ok(danger);
    assert.match(danger!.text, /Cannot switch to fakeprov/);
  });

  it('emits a warning and skips the swap when the new provider lists no models and none was requested', async () => {
    const h = makeHarness({ nextProviderModels: [] });
    await swapProvider('fakeprov', undefined, undefined, h.ctx, h.deps);

    // listModels ran (priming attempt), but the empty result aborts before
    // getCapabilities.
    assert.ok(h.log.order.includes('fakeprov:listModels'));
    assert.ok(!h.log.order.includes('fakeprov:getCapabilities'));
    const warn = h.notices.find(n => n.level === 'warn');
    assert.ok(warn);
    assert.match(warn!.text, /returned no models/);
  });
});

describe('swapProvider — short-circuit paths', () => {
  it('returns silently when refs.current is null', async () => {
    const h = makeHarness();
    (h.ctx as { refs: { current: RunRefs | null } }).refs.current = null;
    await swapProvider('fakeprov', 'explicit-model', undefined, h.ctx, h.deps);
    // Nothing touched the new provider.
    assert.deepEqual(h.log.order, []);
  });

  it('emits the "current provider" info notice when name is blank', async () => {
    const h = makeHarness();
    await swapProvider('   ', 'explicit-model', undefined, h.ctx, h.deps);
    const info = h.notices.find(n => n.level === 'info');
    assert.ok(info);
    assert.match(info!.text, /Current provider: initial/);
    assert.deepEqual(h.log.order, []);
  });

  it('emits "Already on X" when swapping to the same provider with no model and no keyId', async () => {
    const h = makeHarness();
    await swapProvider('initial', undefined, undefined, h.ctx, h.deps);
    const info = h.notices.find(n => n.level === 'info' && /Already on/.test(n.text));
    assert.ok(info);
    // No new-provider activity.
    assert.ok(!h.log.order.some(s => s.startsWith('createProvider:')));
  });
});

// Regression tests for the `/model <name>` colon-handling bug. Before the
// fix in swap.ts, any `name` containing a colon was split on the *first*
// colon and the left side was treated as a provider alias. That broke
// Ollama-style tagged model names like `deepseek-coder:33b-instruct` —
// the harness called createProvider("deepseek-coder") and threw
// "Unknown provider: deepseek-coder" even though the user just wanted to
// swap models on the *current* (ollama) provider.
describe('swapModel — colon-in-model handling', () => {
  it('treats `<unknown>:<tag>` as a bare model on the current provider', async () => {
    const h = makeHarness();
    // No alias is a known provider — Ollama tag names fall in this bucket.
    h.deps.descriptorByAlias = ((_: string) =>
      undefined) as unknown as SwapProviderDeps['descriptorByAlias'];

    await swapModel('deepseek-coder:33b-instruct', h.ctx, h.deps);

    // No new provider was created — the colon-form did NOT trigger swapProvider.
    assert.ok(
      !h.log.order.some(s => s.startsWith('createProvider:')),
      `createProvider must not run when prefix is not a known alias; order=${JSON.stringify(h.log.order)}`,
    );
    // The model was applied verbatim, colon-tag and all.
    assert.equal(h.refs.model, 'deepseek-coder:33b-instruct');
    // No danger notice — the swap succeeded.
    assert.ok(!h.notices.some(n => n.level === 'danger'));
  });

  it('routes `<known-alias>:<model>` through swapProvider', async () => {
    const h = makeHarness({ nextProviderName: 'ollama' });
    h.deps.descriptorByAlias = ((alias: string) =>
      alias === 'ollama'
        ? fakeDescriptor('ollama')
        : undefined) as unknown as SwapProviderDeps['descriptorByAlias'];

    await swapModel('ollama:llama3.1:8b', h.ctx, h.deps);

    // swapProvider path: createProvider must have run for the resolved provider.
    assert.ok(
      h.log.order.some(s => s === 'createProvider:ollama'),
      `createProvider:ollama expected; order=${JSON.stringify(h.log.order)}`,
    );
    // The model carries the remaining colons intact (Ollama tag preserved).
    assert.equal(h.refs.model, 'llama3.1:8b');
  });

  it('treats `:<tag>` (empty prefix) as a bare model on the current provider', async () => {
    const h = makeHarness();
    h.deps.descriptorByAlias = ((_: string) =>
      undefined) as unknown as SwapProviderDeps['descriptorByAlias'];

    await swapModel(':33b-instruct', h.ctx, h.deps);

    assert.ok(!h.log.order.some(s => s.startsWith('createProvider:')));
    assert.equal(h.refs.model, ':33b-instruct');
  });
});
