import type { AgentLoopApi } from '../agent-loop/use-agent-loop.js';
import type { SlashCommandSpec } from './types.js';

/** Build the `synopsis` column shown in `/help` for one command:
 *  `name` + comma-joined aliases + (optional) argSpec separated by a
 *  space. Kept as a free function so the format is reusable if other
 *  contexts (e.g. a future `?` quick-help) want to render the same
 *  shape. */
function formatSynopsis(spec: SlashCommandSpec): string {
  const names = [spec.name, ...(spec.aliases ?? [])].join(', ');
  return spec.argSpec ? `${names} ${spec.argSpec}` : names;
}

export function printHelp(agent: AgentLoopApi, slashCommands: readonly SlashCommandSpec[]): void {
  const hotkeys: [string, string][] = [
    ['Ctrl+K', 'Open the provider/model picker (same as /model)'],
    ['Ctrl+T', 'New tab'],
    ['Ctrl+W', 'Close active tab (or exit if last tab)'],
    ['Ctrl+N / Ctrl+P', 'Cycle to next / previous tab'],
    ['F1–F12', 'Jump directly to tab N'],
    ['Ctrl+C', 'Abort running turn (or exit when idle)'],
    ['Esc', 'Abort running turn'],
    ['↑ / ↓', 'Recall previous / next prompt'],
  ];
  agent.addNoticeBlock([
    { level: 'cyan', text: 'Commands:' },
    ...slashCommands
      .filter(spec => spec.description !== undefined)
      .map(spec => ({
        level: 'info' as const,
        text: `  ${formatSynopsis(spec).padEnd(26)} ${spec.description!}`,
      })),
    { level: 'cyan', text: 'Hotkeys:' },
    ...hotkeys.map(([k, desc]) => ({
      level: 'info' as const,
      text: `  ${k.padEnd(26)} ${desc}`,
    })),
  ]);
}
