import type { AgentLoopApi } from '../agent-loop/use-agent-loop.js';
import type { RotationEntry } from '../../../core/config/types.js';
import { tupleKey } from '../../../core/config/types.js';
import { parseRotationEntry } from '../../../cli/startup/parse-rotation.js';
import { descriptorByAlias } from '../../../providers/registry.js';
import { updateGlobalConfig } from '../../../core/config/index.js';

export function activeScope(
  agent: AgentLoopApi,
): { provider: string; model: string; key: string } | null {
  const refs = agent.refs.current;
  if (!refs) return null;
  return {
    provider: refs.provider.name,
    model: refs.model,
    key: tupleKey({ provider: refs.provider.name, model: refs.model }),
  };
}

export interface FlagParse {
  /** Targets the global default chain when true. */
  forDefault: boolean;
  /** Explicit `--for <p:m>` scope, overrides activeScope when set. */
  forScope?: string;
  /** The remaining positional args after consuming flags. */
  rest: string[];
}

/** Parses `--default` and `--for <p:m>` flags out of the arg list. */
export function parseFlags(parts: string[]): FlagParse {
  const out: FlagParse = { forDefault: false, rest: [] };
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i]!;
    if (a === '--default') {
      out.forDefault = true;
    } else if (a === '--for') {
      const next = parts[++i];
      if (next !== undefined) out.forScope = next;
    } else {
      out.rest.push(a);
    }
  }
  return out;
}

/**
 * Resolves the `(provider, model)` an `add` / `insert` arg refers to.
 * Accepts `<provider>:<model>` or a bare `<model>` (which infers provider
 * from the active selection).
 */
export function resolveEntry(spec: string, agent: AgentLoopApi): RotationEntry | null {
  const colon = spec.indexOf(':');
  if (colon > 0) {
    return parseRotationEntry(spec);
  }
  // Bare model — infer provider from active selection.
  const scope = activeScope(agent);
  if (!scope) return null;
  const trimmed = spec.trim();
  if (!trimmed) return null;
  return { provider: scope.provider, model: trimmed };
}

export type ChainTarget = { kind: 'default' } | { kind: 'override'; key: string };

/**
 * Picks the chain identified by the user's flags. Returns `{ kind, key, list }`
 * where `kind === 'default'` means the global default array, and `'override'`
 * means a specific scope key in `overrides`.
 */
export function resolveTargetChain(agent: AgentLoopApi, flags: FlagParse): ChainTarget | null {
  if (flags.forDefault) return { kind: 'default' };
  if (flags.forScope !== undefined) {
    const e = parseRotationEntry(flags.forScope);
    if (!e) return null;
    return { kind: 'override', key: tupleKey(e) };
  }
  const scope = activeScope(agent);
  if (!scope) return null;
  return { kind: 'override', key: scope.key };
}

export function readChain(agent: AgentLoopApi, target: ChainTarget): RotationEntry[] {
  const refs = agent.refs.current!;
  if (target.kind === 'default') return refs.rotation.default;
  return refs.rotation.overrides[target.key] ?? [];
}

export function writeChain(agent: AgentLoopApi, target: ChainTarget, next: RotationEntry[]): void {
  const refs = agent.refs.current!;
  if (target.kind === 'default') {
    refs.rotation.default = next;
  } else {
    if (next.length === 0) {
      delete refs.rotation.overrides[target.key];
    } else {
      refs.rotation.overrides[target.key] = next;
    }
  }
}

export async function persist(agent: AgentLoopApi): Promise<void> {
  const refs = agent.refs.current;
  if (!refs) return;
  // RMW under the config mutex via updateGlobalConfig. The earlier
  // load-then-save shape would lose data on concurrent writers
  // (e.g. another tab toggling rotation at the same time) — same
  // bug class as f848472. updateGlobalConfig holds the in-process
  // lock across the read, transform, and write.
  await updateGlobalConfig(current => ({
    agent: {
      ...current.agent,
      rotation: {
        ...current.agent?.rotation,
        keys: refs.rotation.keysEnabled,
        models: refs.rotation.modelsEnabled,
        default: refs.rotation.default,
        overrides: refs.rotation.overrides,
      },
    },
  }));
}

export function describeTarget(target: ChainTarget): string {
  return target.kind === 'default' ? 'default' : target.key;
}

export function parseIndex(arg: string): number | null {
  if (!/^\d+$/.test(arg)) return null;
  const n = Number.parseInt(arg, 10);
  if (n < 1) return null;
  return n;
}

/** Quick provider-name validation. Doesn't probe models — that's deferred to the runtime. */
export function validateEntry(entry: RotationEntry): string | null {
  if (!descriptorByAlias(entry.provider)) {
    return `Unknown provider "${entry.provider}". Try /pick to see options.`;
  }
  return null;
}
