import type { AgentLoopApi } from '../agent-loop/use-agent-loop.js';
import { descriptorByAlias } from '../../../providers/descriptors.js';
import { loadGlobalConfig } from '../../../core/config/index.js';
import { listKeys } from '../../../core/auth/credentials.js';
import {
  activeScope,
  describeTarget,
  parseFlags,
  parseIndex,
  persist,
  readChain,
  resolveEntry,
  resolveTargetChain,
  validateEntry,
  writeChain,
} from './rotate-helpers.js';

export async function handleRefresh(agent: AgentLoopApi): Promise<void> {
  const refs = agent.refs.current;
  if (!refs) return;
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
  } else {
    agent.addNotice(
      'info',
      `Rotation refreshed — failure log cleared (already on ${primary.provider} / ${primary.model}).`,
    );
  }
}

export async function handleClear(agent: AgentLoopApi, rest: string[]): Promise<void> {
  const flags = parseFlags(rest);
  const target = resolveTargetChain(agent, flags);
  if (!target) {
    agent.addNotice('warn', 'Cannot resolve target chain.');
    return;
  }
  writeChain(agent, target, []);
  await persist(agent);
  agent.addNotice('info', `Cleared rotation chain (${describeTarget(target)}).`);
}

export async function handleAdd(agent: AgentLoopApi, rest: string[]): Promise<void> {
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
}

export async function handleInsert(agent: AgentLoopApi, rest: string[]): Promise<void> {
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
}

export async function handleRemove(agent: AgentLoopApi, rest: string[]): Promise<void> {
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
}

export async function handleMove(agent: AgentLoopApi, rest: string[]): Promise<void> {
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
}
