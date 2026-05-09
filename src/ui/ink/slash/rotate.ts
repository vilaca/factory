import type { AgentLoopApi } from '../agent-loop/use-agent-loop.js';
import type { RotationEntry } from '../../../core/config/types.js';
import { parseRotationEntry } from '../../../cli/parse-rotation.js';
import { descriptorByAlias } from '../../../providers/descriptors.js';
import { loadGlobalConfig, saveGlobalConfig } from '../../../core/config/index.js';
import { listKeys } from '../../../core/credentials.js';

/**
 * Format `<provider>:<model>` exactly. Used as the override key in the
 * rotation config and as a render token in /rotate output.
 */
function tupleKey(entry: RotationEntry): string {
  return `${entry.provider}:${entry.model}`;
}

function activeScope(agent: AgentLoopApi): { provider: string; model: string; key: string } | null {
  const refs = agent.refs.current;
  if (!refs) return null;
  return {
    provider: refs.provider.name,
    model: refs.model,
    key: `${refs.provider.name}:${refs.model}`,
  };
}

interface FlagParse {
  /** Targets the global default chain when true. */
  forDefault: boolean;
  /** Explicit `--for <p:m>` scope, overrides activeScope when set. */
  forScope?: string;
  /** The remaining positional args after consuming flags. */
  rest: string[];
}

/** Parses `--default` and `--for <p:m>` flags out of the arg list. */
function parseFlags(parts: string[]): FlagParse {
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
function resolveEntry(spec: string, agent: AgentLoopApi): RotationEntry | null {
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

/**
 * Picks the chain identified by the user's flags. Returns `{ kind, key, list }`
 * where `kind === 'default'` means the global default array, and `'override'`
 * means a specific scope key in `overrides`.
 */
function resolveTargetChain(
  agent: AgentLoopApi,
  flags: FlagParse,
): { kind: 'default' } | { kind: 'override'; key: string } | null {
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

function readChain(
  agent: AgentLoopApi,
  target: { kind: 'default' } | { kind: 'override'; key: string },
): RotationEntry[] {
  const refs = agent.refs.current!;
  if (target.kind === 'default') return refs.rotation.default;
  return refs.rotation.overrides[target.key] ?? [];
}

function writeChain(
  agent: AgentLoopApi,
  target: { kind: 'default' } | { kind: 'override'; key: string },
  next: RotationEntry[],
): void {
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

async function persist(agent: AgentLoopApi): Promise<void> {
  const refs = agent.refs.current;
  if (!refs) return;
  const global = await loadGlobalConfig();
  const nextRotation = {
    ...global.agent?.rotation,
    keys: refs.rotation.keysEnabled,
    models: refs.rotation.modelsEnabled,
    default: refs.rotation.default,
    overrides: refs.rotation.overrides,
  };
  await saveGlobalConfig({
    agent: { ...global.agent, rotation: nextRotation },
  });
}

function describeTarget(target: { kind: 'default' } | { kind: 'override'; key: string }): string {
  return target.kind === 'default' ? 'default' : target.key;
}

/** No-arg `/rotate` — show the chain that would fire for the active selection. */
function showChain(agent: AgentLoopApi): void {
  const scope = activeScope(agent);
  const refs = agent.refs.current;
  if (!refs) return;
  const lines: { level: 'cyan' | 'info' | 'warn'; text: string; bold?: boolean }[] = [];

  const overrideHit = scope ? refs.rotation.overrides[scope.key] : undefined;
  const effective = overrideHit ?? refs.rotation.default;
  const source = overrideHit ? `override for ${scope!.key}` : 'using default';

  if (scope) {
    lines.push({ level: 'cyan', text: `Rotation chain for ${scope.key} (${source}):`, bold: true });
  } else {
    lines.push({ level: 'cyan', text: `Rotation chain (default):`, bold: true });
  }

  if (effective.length === 0) {
    lines.push({ level: 'info', text: '  (empty — no rotation will fire)' });
  } else {
    effective.forEach((e, i) => {
      lines.push({ level: 'info', text: `  ${i + 1}. ${e.provider} / ${e.model}` });
    });
  }

  // Other configured chains (not active for this selection).
  const otherKeys = Object.keys(refs.rotation.overrides).filter(k => k !== (scope?.key ?? ''));
  const hasOtherDefault = !overrideHit ? false : refs.rotation.default.length > 0;
  if (otherKeys.length > 0 || hasOtherDefault) {
    lines.push({ level: 'info', text: '' });
    lines.push({ level: 'info', text: 'Other configured chains:' });
    if (hasOtherDefault) {
      lines.push({
        level: 'info',
        text: `  default                                 (${refs.rotation.default.length} entr${refs.rotation.default.length === 1 ? 'y' : 'ies'})`,
      });
    }
    for (const k of otherKeys.sort()) {
      const list = refs.rotation.overrides[k] ?? [];
      lines.push({
        level: 'info',
        text: `  ${k.padEnd(40)} (${list.length} entr${list.length === 1 ? 'y' : 'ies'})`,
      });
    }
  }

  lines.push({ level: 'info', text: '' });
  if (!refs.rotation.keysEnabled && !refs.rotation.modelsEnabled) {
    lines.push({ level: 'warn', text: '  Rotation is fully disabled (--no-rotate).' });
  } else {
    if (!refs.rotation.keysEnabled)
      lines.push({ level: 'warn', text: '  Key rotation disabled (--no-rotate-keys).' });
    if (!refs.rotation.modelsEnabled)
      lines.push({ level: 'warn', text: '  Model rotation disabled (--no-rotate-models).' });
  }
  lines.push({
    level: 'info',
    text: '  Add: /rotate add <provider:model> · Remove: /rotate remove <n>',
  });
  lines.push({
    level: 'info',
    text: '  Edit default: /rotate add --default ... · Edit other scope: /rotate add --for <p:m> ...',
  });
  lines.push({ level: 'info', text: '  Reset to the head of the chain: /rotate refresh' });

  agent.addNoticeBlock(lines);
}

function parseIndex(arg: string): number | null {
  if (!/^\d+$/.test(arg)) return null;
  const n = Number.parseInt(arg, 10);
  if (n < 1) return null;
  return n;
}

/** Quick provider-name validation. Doesn't probe models — that's deferred to the runtime. */
function validateEntry(entry: RotationEntry): string | null {
  if (!descriptorByAlias(entry.provider)) {
    return `Unknown provider "${entry.provider}". Try /pick to see options.`;
  }
  return null;
}

// eslint-disable-next-line max-statements, complexity, sonarjs/cognitive-complexity -- TODO(complexity): split sub-commands (status, add, remove, replace) into handlers.
export async function dispatchRotate(arg: string, agent: AgentLoopApi): Promise<void> {
  const refs = agent.refs.current;
  if (!refs) return;

  const trimmed = arg.trim();
  if (!trimmed) {
    showChain(agent);
    return;
  }

  const tokens = trimmed.split(/\s+/);
  const sub = tokens[0]!.toLowerCase();
  const rest = tokens.slice(1);

  switch (sub) {
    case 'refresh': {
      // Reset in-memory rotation state and return the tab to the head of the
      // chain — i.e. the (provider, model) the user originally homed on for
      // this tab, with its first saved key. Useful after rotation has drifted
      // the tab to a fallback and the original is healthy again.
      refs.keyFailureLog.clear();
      refs.rotationPromptDeclined = false;
      const { primary } = refs;
      let firstKeyId: string | undefined;
      try {
        const cfg = await loadGlobalConfig();
        const descriptor = descriptorByAlias(primary.provider);
        if (descriptor) {
          firstKeyId = listKeys(cfg, descriptor.name)[0]?.id;
        }
      } catch {
        // No keys loadable — refresh stays on whatever credential the
        // runtime resolves at the next call.
      }
      const drifted = refs.provider.name !== primary.provider || refs.model !== primary.model;
      const keyChanged = firstKeyId !== undefined && firstKeyId !== refs.activeKeyId;
      if (drifted || keyChanged) {
        await agent.setProviderByName(primary.provider, primary.model, firstKeyId);
        // setProviderByName re-set primary to the same tuple; the explicit
        // assignment above (and any future user swaps) keep it accurate.
      } else {
        agent.addNotice(
          'info',
          `Rotation refreshed — failure log cleared (already on ${primary.provider} / ${primary.model}).`,
        );
      }
      return;
    }

    case 'clear': {
      const flags = parseFlags(rest);
      const target = resolveTargetChain(agent, flags);
      if (!target) {
        agent.addNotice('warn', 'Cannot resolve target chain.');
        return;
      }
      writeChain(agent, target, []);
      await persist(agent);
      agent.addNotice('info', `Cleared rotation chain (${describeTarget(target)}).`);
      return;
    }

    case 'add': {
      const flags = parseFlags(rest);
      if (flags.rest.length !== 1) {
        agent.addNotice('warn', 'Usage: /rotate add [--default | --for <p:m>] <provider:model>');
        return;
      }
      const entry = resolveEntry(flags.rest[0]!, agent);
      if (!entry) {
        agent.addNotice(
          'warn',
          `Could not parse "${flags.rest[0]}". Expected <provider>:<model> or a bare model when a primary is active.`,
        );
        return;
      }
      const err = validateEntry(entry);
      if (err) {
        agent.addNotice('warn', err);
        return;
      }
      const target = resolveTargetChain(agent, flags);
      if (!target) {
        agent.addNotice('warn', 'Cannot resolve target chain.');
        return;
      }
      const current = readChain(agent, target);
      const dupIndex = current.findIndex(
        e => e.provider === entry.provider && e.model === entry.model,
      );
      if (dupIndex >= 0) {
        agent.addNotice('warn', `Already in chain at position ${dupIndex + 1}.`);
        return;
      }
      writeChain(agent, target, [...current, entry]);
      await persist(agent);
      // Self-reference note when the user adds their active selection to the chain.
      const scope = activeScope(agent);
      const isSelfRef = scope && entry.provider === scope.provider && entry.model === scope.model;
      const lines: { level: 'info' | 'warn'; text: string }[] = [
        {
          level: 'info',
          text: `Added ${entry.provider} / ${entry.model} to ${describeTarget(target)} chain.`,
        },
      ];
      if (isSelfRef) {
        lines.push({
          level: 'warn',
          text: '  Note: this is your active selection; rotation only fires when it fails.',
        });
      }
      agent.addNoticeBlock(lines);
      return;
    }

    case 'insert': {
      const flags = parseFlags(rest);
      if (flags.rest.length !== 2) {
        agent.addNotice(
          'warn',
          'Usage: /rotate insert [--default | --for <p:m>] <n> <provider:model>',
        );
        return;
      }
      const n = parseIndex(flags.rest[0]!);
      if (n === null) {
        agent.addNotice('warn', `Index must be a positive integer.`);
        return;
      }
      const entry = resolveEntry(flags.rest[1]!, agent);
      if (!entry) {
        agent.addNotice('warn', `Could not parse "${flags.rest[1]}".`);
        return;
      }
      const err = validateEntry(entry);
      if (err) {
        agent.addNotice('warn', err);
        return;
      }
      const target = resolveTargetChain(agent, flags);
      if (!target) {
        agent.addNotice('warn', 'Cannot resolve target chain.');
        return;
      }
      const current = readChain(agent, target);
      if (current.findIndex(e => e.provider === entry.provider && e.model === entry.model) >= 0) {
        agent.addNotice('warn', 'Already in chain.');
        return;
      }
      const idx = Math.max(0, Math.min(current.length, n - 1));
      const next = [...current.slice(0, idx), entry, ...current.slice(idx)];
      writeChain(agent, target, next);
      await persist(agent);
      agent.addNotice(
        'info',
        `Inserted ${entry.provider} / ${entry.model} at position ${idx + 1} (${describeTarget(target)}).`,
      );
      return;
    }

    case 'remove': {
      const flags = parseFlags(rest);
      if (flags.rest.length !== 1) {
        agent.addNotice('warn', 'Usage: /rotate remove [--default | --for <p:m>] <n>');
        return;
      }
      const target = resolveTargetChain(agent, flags);
      if (!target) {
        agent.addNotice('warn', 'Cannot resolve target chain.');
        return;
      }
      const current = readChain(agent, target);
      const n = parseIndex(flags.rest[0]!);
      if (n === null || n > current.length) {
        agent.addNotice('warn', `Index must be 1..${current.length}.`);
        return;
      }
      const removed = current[n - 1]!;
      writeChain(agent, target, [...current.slice(0, n - 1), ...current.slice(n)]);
      await persist(agent);
      agent.addNotice(
        'info',
        `Removed ${removed.provider} / ${removed.model} from ${describeTarget(target)} chain.`,
      );
      return;
    }

    case 'move': {
      const flags = parseFlags(rest);
      if (flags.rest.length !== 2) {
        agent.addNotice('warn', 'Usage: /rotate move [--default | --for <p:m>] <from> <to>');
        return;
      }
      const target = resolveTargetChain(agent, flags);
      if (!target) {
        agent.addNotice('warn', 'Cannot resolve target chain.');
        return;
      }
      const current = readChain(agent, target);
      const from = parseIndex(flags.rest[0]!);
      const to = parseIndex(flags.rest[1]!);
      if (from === null || to === null || from > current.length || to > current.length) {
        agent.addNotice('warn', `Indices must be 1..${current.length}.`);
        return;
      }
      const next = [...current];
      const [picked] = next.splice(from - 1, 1);
      next.splice(to - 1, 0, picked!);
      writeChain(agent, target, next);
      await persist(agent);
      agent.addNotice('info', `Moved entry ${from} → ${to} in ${describeTarget(target)} chain.`);
      return;
    }

    default:
      agent.addNotice(
        'warn',
        `Unknown /rotate subcommand "${sub}". Try: add, insert, remove, move, clear, refresh (or no args to view).`,
      );
  }
}
