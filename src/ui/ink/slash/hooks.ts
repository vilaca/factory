import type { AgentLoopApi } from '../use-agent-loop.js';
import type { HooksConfig } from '../../../core/config-types.js';
import { listAllHooks } from '../../../core/hooks/discovery.js';

export async function dispatchHooks(agent: AgentLoopApi, hooksConfig: HooksConfig | undefined): Promise<void> {
  const all = listAllHooks(hooksConfig);
  if (all.length === 0) {
    agent.addNotice('info', 'No hooks configured. Add an `agent.hooks.<EventName>` block to ~/.factory/config.json or .factory/config.json.');
    return;
  }

  const lines: { level: 'info' | 'cyan'; text: string }[] = [
    { level: 'cyan', text: `Configured hooks (${all.length}):` },
  ];

  for (const { event, entry } of all) {
    const matcher = entry.matcher ? ` matcher=${entry.matcher}` : '';
    const timeout = entry.timeoutMs ? ` timeout=${entry.timeoutMs}ms` : '';
    lines.push({ level: 'info', text: `  ${event.padEnd(18)}${matcher}${timeout}` });
    lines.push({ level: 'info', text: `    ${entry.command}` });
  }

  lines.push({
    level: 'info',
    text: 'Hooks can cancel tool calls, modify context before compaction, or audit operations.',
  });

  agent.addNoticeBlock(lines);
}
