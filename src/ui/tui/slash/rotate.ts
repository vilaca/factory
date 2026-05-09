import type { AgentLoopApi } from '../agent-loop/use-agent-loop.js';
import { activeScope } from './rotate-helpers.js';
import {
  handleAdd,
  handleClear,
  handleInsert,
  handleMove,
  handleRefresh,
  handleRemove,
} from './rotate-subcommands.js';

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

export async function dispatchRotate(arg: string, agent: AgentLoopApi): Promise<void> {
  if (!agent.refs.current) return;

  const trimmed = arg.trim();
  if (!trimmed) {
    showChain(agent);
    return;
  }

  const tokens = trimmed.split(/\s+/);
  const sub = tokens[0]!.toLowerCase();
  const rest = tokens.slice(1);

  switch (sub) {
    case 'refresh':
      return handleRefresh(agent);
    case 'clear':
      return handleClear(agent, rest);
    case 'add':
      return handleAdd(agent, rest);
    case 'insert':
      return handleInsert(agent, rest);
    case 'remove':
      return handleRemove(agent, rest);
    case 'move':
      return handleMove(agent, rest);
    default:
      agent.addNotice(
        'warn',
        `Unknown /rotate subcommand "${sub}". Try: add, insert, remove, move, clear, refresh (or no args to view).`,
      );
  }
}
