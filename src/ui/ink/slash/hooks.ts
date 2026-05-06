import os from 'os';
import type { AgentLoopApi } from '../use-agent-loop.js';
import { discoverAllHooks } from '../../../core/hooks/discovery.js';

export async function dispatchHooks(agent: AgentLoopApi, cwd: string): Promise<void> {
  try {
    const hooks = discoverAllHooks(cwd);
    if (hooks.length === 0) {
      agent.addNotice('info', 'No hooks found. Create hook scripts in .factory/hooks/ or ~/.factory/hooks/');
      return;
    }

    // Resolve once, not per-hook. `os.homedir()` is canonical; falling back
    // to '' would tag every path as global, which is the opposite of safe.
    const home = os.homedir();
    const lines: { level: 'info' | 'cyan'; text: string }[] = [
      { level: 'cyan', text: `Discovered hooks (${hooks.length}):` },
    ];

    for (const hookPath of hooks) {
      const eventMatch = hookPath.match(/(\w+)\.sh$/);
      const event = eventMatch ? eventMatch[1] : 'unknown';
      const isGlobal = home !== '' && hookPath.startsWith(home + '/');
      const location = isGlobal ? '(global)' : '(project)';
      lines.push({ level: 'info', text: `  ${event.padEnd(18)} ${location}` });
      lines.push({ level: 'info', text: `    ${hookPath}` });
    }

    lines.push({
      level: 'info',
      text: 'Hooks can cancel tool calls, modify context before compaction, or audit operations.',
    });

    agent.addNoticeBlock(lines);
  } catch (err: any) {
    agent.addNotice('warn', `Failed to discover hooks: ${err?.message ?? String(err)}`);
  }
}
