import type { Provider, TokenUsage, ToolCallMessage } from '../../../providers/types.js';
import type { AgentEvent, RotationOptions } from '../types.js';
import type { ProviderKey } from '../../config/types.js';
import { tupleKey } from '../../config/types.js';
import { keyFingerprint, selectNextKey } from '../../auth/credentials.js';
import { classifyForRotation } from './provider-errors.js';

type RotationReason = 'rate-limit' | 'auth';

/**
 * Mutable bundle of state that rotates between provider/model/key swaps.
 * Carrying it as one object keeps the rotation helpers callable without
 * juggling six out-params; the helpers reset accumulators on a successful
 * swap so the retry loop reads as if it were a fresh attempt.
 */
export interface RotationState {
  provider: Provider;
  model: string;
  activeKeyId: string | undefined;
  activeKeys: ProviderKey[];
  triedKeyIds: Set<string>;
  triedTuples: Set<string>;
  tupleRotated: boolean;
  fullContent: string;
  toolCalls: ToolCallMessage[];
  lastUsage: TokenUsage | undefined;
  doneReason: string | undefined;
  /** Set true on the first chunk that lands. Read by the catch handler to
   *  decide whether rotation is meaningful (rotating mid-stream would
   *  duplicate tokens already committed to the caller's scrollback). */
  streamedAnything: boolean;
}

interface TierResult {
  /** True when state was advanced and the caller should retry the chat call. */
  rotated: boolean;
  /** Events to yield to the agent loop in order. */
  events: AgentEvent[];
  /** Set when the helper decides the original error must propagate (e.g.
   *  withTuple threw). The caller rethrows verbatim. */
  rethrow?: unknown;
}

interface RotationOutcome {
  /** True when state advanced and the caller should retry the chat. */
  rotated: boolean;
  /** Set when the caller should rethrow the original error verbatim. */
  rethrow?: unknown;
}

export type RotationDecision =
  | { kind: 'rotated' }
  | { kind: 'rethrow'; err: unknown }
  | { kind: 'noop' };

function resetAccumulators(state: RotationState): void {
  state.fullContent = '';
  state.toolCalls = [];
  state.lastUsage = undefined;
  state.doneReason = undefined;
}

/**
 * Walk the rotation chain looking for the next entry that hasn't been tried
 * yet AND whose provider has at least one saved key. Skips entries with
 * unknown providers (caller's `loadKeysForProvider` returns empty) and
 * already-tried tuples. Returns null when the chain is exhausted.
 */
async function advanceTuple(
  rotation: RotationOptions,
  tried: ReadonlySet<string>,
): Promise<{
  entry: { provider: string; model: string };
  provider: Provider;
  keys: ProviderKey[];
  firstKey: ProviderKey;
} | null> {
  if (!rotation.chain || !rotation.loadKeysForProvider || !rotation.withTuple) return null;
  for (const entry of rotation.chain) {
    const key = tupleKey(entry);
    if (tried.has(key)) continue;
    let keys: ProviderKey[];
    try {
      keys = await rotation.loadKeysForProvider(entry.provider);
    } catch {
      continue;
    }
    if (keys.length === 0) continue;
    const firstKey = keys[0]!;
    let nextProvider: Provider;
    try {
      nextProvider = rotation.withTuple(entry.provider, firstKey);
    } catch {
      continue;
    }
    return { entry, provider: nextProvider, keys, firstKey };
  }
  return null;
}

/**
 * Tier 1: rotate to the next saved key for the current (provider, model).
 * Stamps a failure for the outgoing key, picks the next available, swaps the
 * provider via `rotation.withKey`, and resets accumulators so the retry loop
 * starts clean.
 */
async function tryRotateKey(
  state: RotationState,
  rotation: RotationOptions,
  reason: RotationReason,
): Promise<TierResult> {
  if (!rotation.activeKeyId || state.activeKeys.length === 0) {
    return { rotated: false, events: [] };
  }
  if (rotation.failureLog && state.activeKeyId) {
    rotation.failureLog.set(state.activeKeyId, Date.now());
  }
  const warmthLog = await rotation.getWarmthLog?.();
  const next = selectNextKey(state.activeKeys, state.triedKeyIds, {
    failureLog: rotation.failureLog,
    warmthLog,
  });
  if (!next) {
    return {
      rotated: false,
      events: [{ type: 'key-rotation-exhausted', provider: state.provider.name, reason }],
    };
  }
  const fromKey = state.activeKeyId
    ? state.activeKeys.find(k => k.id === state.activeKeyId)
    : undefined;
  const event: AgentEvent = {
    type: 'key-rotation',
    provider: state.provider.name,
    from: fromKey
      ? {
          keyId: fromKey.id,
          fingerprint: keyFingerprint(fromKey.token),
          ...(fromKey.label ? { label: fromKey.label } : {}),
        }
      : null,
    to: {
      keyId: next.id,
      fingerprint: keyFingerprint(next.token),
      ...(next.label ? { label: next.label } : {}),
    },
    reason,
  };
  state.triedKeyIds.add(next.id);
  state.activeKeyId = next.id;
  rotation.activeKeyId = next.id;
  rotation.onActiveKeyChange?.(next.id);
  state.provider = rotation.withKey(next);
  resetAccumulators(state);
  return { rotated: true, events: [event] };
}

/**
 * Tier 2: advance to the next entry in the rotation chain, swapping the
 * (provider, model) tuple. Resets the tier-1 tried-set and active-keys for
 * the new tuple — each tuple has its own pool to walk.
 */
async function tryRotateTuple(
  state: RotationState,
  rotation: RotationOptions,
  reason: RotationReason,
): Promise<TierResult> {
  if (
    rotation.modelsEnabled === false ||
    !rotation.chain ||
    rotation.chain.length === 0 ||
    !rotation.loadKeysForProvider ||
    !rotation.withTuple
  ) {
    return { rotated: false, events: [] };
  }
  const advance = await advanceTuple(rotation, state.triedTuples);
  if (!advance) {
    return { rotated: false, events: [{ type: 'tuple-rotation-exhausted', reason }] };
  }
  const event: AgentEvent = {
    type: 'tuple-rotation',
    from: { provider: state.provider.name, model: state.model },
    to: { provider: advance.entry.provider, model: advance.entry.model },
    reason,
  };
  state.provider = advance.provider;
  state.model = advance.entry.model;
  state.activeKeyId = advance.firstKey.id;
  rotation.activeKeyId = advance.firstKey.id;
  rotation.onActiveKeyChange?.(advance.firstKey.id);
  rotation.onModelChange?.(advance.entry.model);
  state.triedKeyIds = new Set<string>([advance.firstKey.id]);
  state.activeKeys = advance.keys;
  state.triedTuples.add(`${advance.entry.provider}:${advance.entry.model}`);
  state.tupleRotated = true;
  resetAccumulators(state);
  return { rotated: true, events: [event] };
}

/**
 * Last-chance fallback: ask the host for a brand-new chain entry. Treats the
 * host's reply as a virtual tier-2 advance. Returns rethrow=err when the
 * prompt yields a tuple but constructing the provider throws — the original
 * error is more useful than a generic "fallback failed".
 */
async function tryPromptedFallback(
  state: RotationState,
  rotation: RotationOptions,
  reason: RotationReason,
  err: unknown,
): Promise<TierResult> {
  if (!rotation.promptForFallback || !rotation.loadKeysForProvider || !rotation.withTuple) {
    return { rotated: false, events: [] };
  }
  const promptedEntry = await rotation.promptForFallback({
    provider: state.provider.name,
    model: state.model,
    reason,
  });
  if (!promptedEntry) return { rotated: false, events: [] };
  const promptedKey = `${promptedEntry.provider}:${promptedEntry.model}`;
  if (state.triedTuples.has(promptedKey)) return { rotated: false, events: [] };

  let promptedKeys: ProviderKey[] = [];
  try {
    promptedKeys = await rotation.loadKeysForProvider(promptedEntry.provider);
  } catch {
    // empty list — fall through to the no-keys exit.
  }
  if (promptedKeys.length === 0) return { rotated: false, events: [] };

  const firstKey = promptedKeys[0]!;
  let nextProvider: Provider;
  try {
    nextProvider = rotation.withTuple(promptedEntry.provider, firstKey);
  } catch {
    return { rotated: false, events: [], rethrow: err };
  }

  const event: AgentEvent = {
    type: 'tuple-rotation',
    from: { provider: state.provider.name, model: state.model },
    to: { provider: promptedEntry.provider, model: promptedEntry.model },
    reason,
  };
  state.provider = nextProvider;
  state.model = promptedEntry.model;
  state.activeKeyId = firstKey.id;
  rotation.activeKeyId = firstKey.id;
  rotation.onActiveKeyChange?.(firstKey.id);
  rotation.onModelChange?.(promptedEntry.model);
  state.triedKeyIds = new Set<string>([firstKey.id]);
  state.activeKeys = promptedKeys;
  state.triedTuples.add(promptedKey);
  state.tupleRotated = true;
  resetAccumulators(state);
  return { rotated: true, events: [event] };
}

/**
 * Walk tier-1 → tier-2 → prompted-fallback in order, yielding the events
 * each tier emits. Stops at the first tier that successfully advances state;
 * returns rotated=false when every tier exhausts. Caller decides whether to
 * retry (on rotated=true) or fall through (on rotated=false).
 */
async function* handleRotationFailure(
  state: RotationState,
  rotation: RotationOptions,
  err: unknown,
): AsyncGenerator<AgentEvent, RotationOutcome> {
  const reason = classifyForRotation(err);
  if (reason === 'other') return { rotated: false };

  const tier1 = await tryRotateKey(state, rotation, reason);
  for (const event of tier1.events) yield event;
  if (tier1.rotated) return { rotated: true };

  const tier2 = await tryRotateTuple(state, rotation, reason);
  for (const event of tier2.events) yield event;
  if (tier2.rotated) return { rotated: true };

  const fallback = await tryPromptedFallback(state, rotation, reason, err);
  for (const event of fallback.events) yield event;
  if (fallback.rotated) return { rotated: true };
  if (fallback.rethrow !== undefined) return { rotated: false, rethrow: fallback.rethrow };

  return { rotated: false };
}

/**
 * Drive the rotation tiers and translate the result into a flat
 * RotationDecision. Extracted from the main loop's catch block so
 * cognitive-complexity stays under the cap. The caller decides what to
 * do with the decision (continue / throw / fall through).
 */
export async function* tryRotation(
  state: RotationState,
  rotation: RotationOptions | undefined,
  err: unknown,
): AsyncGenerator<AgentEvent, RotationDecision> {
  if (!rotation || state.streamedAnything) return { kind: 'noop' };
  const outcome = yield* handleRotationFailure(state, rotation, err);
  if (outcome.rotated) return { kind: 'rotated' };
  if (outcome.rethrow !== undefined) return { kind: 'rethrow', err: outcome.rethrow };
  return { kind: 'noop' };
}
