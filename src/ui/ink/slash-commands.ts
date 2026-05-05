import { formatArgValue } from './format.js';
import type { AgentLoopApi } from './use-agent-loop.js';
import type { TabsContextValue } from './tabs/TabsContext.js';
import { EXPERIMENTAL_FLAG_KEYS, type ExperimentalFlagKey } from '../../core/config-types.js';

export interface SlashCommandContext {
  agent: AgentLoopApi;
  exit: () => void;
  tabs?: TabsContextValue;
  openPicker?: () => void;
}

export async function dispatchSlashCommand(
  cmd: string,
  arg: string,
  ctx: SlashCommandContext,
): Promise<boolean> {
  const { agent, exit, tabs } = ctx;
  const refs = agent.refs;
  if (!refs.current) return false;

  switch (cmd) {
    case '/exit':
    case '/quit':
    case '/q':
      // With multiple tabs open, /exit closes the active one; only the last
      // tab triggers a process exit. Without tabs context (legacy callers),
      // fall through to the original exit-process behavior.
      if (tabs && tabs.tabs.length > 1) {
        agent.abort();
        tabs.closeTab(tabs.activeId);
        return true;
      }
      // Abort any in-flight model stream first — without this, Ink unmounts
      // but Node sits waiting for the open HTTP socket to drain before
      // actually exiting, which looks like /q is hung.
      agent.abort();
      exit();
      // If anything (an unflushed stream, a stubborn provider HTTP request,
      // a still-running tool subprocess) keeps the event loop alive past a
      // grace period, force the exit. The abort above should have done the
      // job, but this ensures the user always gets out promptly.
      setTimeout(() => process.exit(0), 1000).unref();
      return true;
    case '/new': {
      if (!tabs) {
        agent.addNotice('warn', 'Tabs not available.');
        return true;
      }
      const label = arg.trim() || undefined;
      tabs.openTab(label);
      return true;
    }
    case '/close': {
      if (!tabs) {
        agent.addNotice('warn', 'Tabs not available.');
        return true;
      }
      if (tabs.tabs.length === 1) {
        agent.addNotice('info', 'Last tab — use /exit to quit.');
        return true;
      }
      agent.abort();
      tabs.closeTab(tabs.activeId);
      return true;
    }
    case '/tabs': {
      if (!tabs) {
        agent.addNotice('warn', 'Tabs not available.');
        return true;
      }
      const lines: { level: 'cyan' | 'info'; text: string; bold?: boolean }[] = [
        { level: 'cyan', text: `Open tabs (${tabs.tabs.length}):` },
      ];
      tabs.tabs.forEach((tab, i) => {
        lines.push({
          level: 'info',
          text: `  ${i + 1}: ${tab.label}`,
          bold: tab.id === tabs.activeId,
        });
      });
      lines.push({ level: 'info', text: 'Switch with /switch <n|label>, Ctrl+N (next), Ctrl+P (prev). Open with /new or Ctrl+T.' });
      agent.addNoticeBlock(lines);
      return true;
    }
    case '/switch': {
      if (!tabs) {
        agent.addNotice('warn', 'Tabs not available.');
        return true;
      }
      const a = arg.trim();
      if (!a) {
        agent.addNotice('warn', `Usage: /switch <n|label>  (1..${tabs.tabs.length}, or tab label / prefix)`);
        return true;
      }
      // Pure integer → index switch.
      if (/^\d+$/.test(a)) {
        const n = Number.parseInt(a, 10);
        if (n < 1 || n > tabs.tabs.length) {
          agent.addNotice('warn', `Tab ${n} doesn't exist (1..${tabs.tabs.length})`);
          return true;
        }
        tabs.switchToIndex(n - 1);
        return true;
      }
      // Exact label match — preferred when labels alone disambiguate.
      const exact = tabs.tabs.filter(t => t.label === a);
      if (exact.length === 1) {
        tabs.switchTo(exact[0]!.id);
        return true;
      }
      if (exact.length > 1) {
        agent.addNotice('warn', `Multiple tabs labelled "${a}" — switch by index instead.`);
        return true;
      }
      // Unique prefix match. Allows `/switch sa` for a tab labelled "sandbox".
      const prefix = tabs.tabs.filter(t => t.label.startsWith(a));
      if (prefix.length === 1) {
        tabs.switchTo(prefix[0]!.id);
        return true;
      }
      if (prefix.length > 1) {
        const labels = prefix.map(t => t.label).join(', ');
        agent.addNotice('warn', `Ambiguous "${a}": matches ${labels}`);
        return true;
      }
      agent.addNotice('warn', `No tab matches "${a}".`);
      return true;
    }
    case '/clear':
      agent.clearConversation();
      return true;
    case '/help':
      printHelp(agent);
      return true;
    case '/permissions':
      agent.resetPermissions();
      agent.addNotice('info', 'Permissions reset.');
      return true;
    case '/plan':
      if (agent.plannedCalls.length > 0) {
        printPlanQueue(agent);
      } else {
        agent.togglePlanMode();
      }
      return true;
    case '/queue':
      printPlanQueue(agent);
      return true;
    case '/approve':
      if (!refs.current.planMode || agent.plannedCalls.length === 0) {
        agent.addNotice('info', 'No plan to approve.');
        return true;
      }
      await agent.approvePlan();
      return true;
    case '/cancel':
      if (refs.current.planMode && agent.plannedCalls.length > 0) {
        agent.cancelPlan();
        agent.addNotice('info', 'Plan dropped.');
      } else {
        agent.addNotice('info', 'No plan to cancel.');
      }
      return true;
    case '/log':
      if (refs.current.sessionLogger) {
        agent.addNotice('info', `Session log: ${refs.current.sessionLogger.filePath}`);
      } else {
        agent.addNotice('info', 'Session logging is disabled.');
      }
      return true;
    case '/correct': {
      let next: boolean;
      if (arg === 'on') next = true;
      else if (arg === 'off') next = false;
      else if (!arg) next = !refs.current.enableCorrector;
      else {
        agent.addNotice('info', 'Usage: /correct on|off');
        return true;
      }
      agent.setCorrector(next);
      return true;
    }
    case '/model':
      if (arg) {
        await agent.setModelByName(arg);
      } else {
        agent.addNoticeBlock([
          { level: 'info', text: `Current: ${refs.current.provider.name} / ${refs.current.model}` },
          { level: 'info', text: 'Switch with /pick (or Ctrl+K). Power users: /model <provider>:<model>.' },
        ]);
      }
      return true;
    case '/cwd':
      agent.setCwd(arg);
      return true;
    case '/exp':
      handleExpCommand(agent, arg);
      return true;
    case '/pick':
      if (ctx.openPicker) {
        ctx.openPicker();
      } else {
        agent.addNotice('warn', 'Picker not available in this context.');
      }
      return true;
  }

  agent.addNotice('info', `Unknown command: ${cmd}. Type /help for available commands.`);
  return true;
}

function printHelp(agent: AgentLoopApi): void {
  const lines: [string, string][] = [
    ['/exit, /quit, /q', 'Exit (or close active tab if multiple open)'],
    ['/new [label]', 'Open a new tab'],
    ['/close', 'Close the active tab'],
    ['/tabs', 'List open tabs'],
    ['/switch <n|label>', 'Switch to tab by index, label, or unique prefix'],
    ['/clear', 'Clear conversation history'],
    ['/model [<name>]', 'Show current provider/model, or switch model. Accepts <provider>:<model>.'],
    ['/pick', 'Open the provider/model picker (also Ctrl+K)'],
    ['/cwd [dir]', 'Show or change this tab\'s working directory'],
    ['/permissions', 'Reset tool permissions'],
    ['/plan', 'Toggle plan mode (or show queue if one exists)'],
    ['/queue', 'Show the queued plan'],
    ['/approve, y', 'Execute the queued plan'],
    ['/cancel, n', 'Drop the queued plan'],
    ['/log', 'Show the current session log path'],
    ['/correct on|off', 'Toggle the LLM tool-call corrector'],
    ['/exp [name on|off]', 'List or toggle experimental flags'],
    ['/help', 'Show this help'],
  ];
  const hotkeys: [string, string][] = [
    ['Ctrl+K', 'Open the provider/model picker'],
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
    ...lines.map(([c, desc]) => ({
      level: 'info' as const,
      text: `  ${c.padEnd(26)} ${desc}`,
    })),
    { level: 'cyan', text: 'Hotkeys:' },
    ...hotkeys.map(([k, desc]) => ({
      level: 'info' as const,
      text: `  ${k.padEnd(26)} ${desc}`,
    })),
  ]);
}

function handleExpCommand(agent: AgentLoopApi, arg: string): void {
  const refs = agent.refs;
  if (!refs.current) return;
  const exp = refs.current.experimental;

  if (!arg) {
    agent.addNoticeBlock([
      { level: 'cyan', text: 'Experimental flags:' },
      ...EXPERIMENTAL_FLAG_KEYS.map((key) => ({
        level: 'info' as const,
        text: `  ${key.padEnd(18)} ${exp[key] ? 'on' : 'off'}`,
      })),
      { level: 'info', text: 'Toggle: /exp <name> on|off' },
    ]);
    return;
  }

  const parts = arg.split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) {
    agent.addNotice('warn', 'Usage: /exp [<name> on|off]');
    return;
  }
  const name = parts[0] as ExperimentalFlagKey;
  if (!EXPERIMENTAL_FLAG_KEYS.includes(name)) {
    agent.addNotice('warn', `Unknown flag "${name}". Known: ${EXPERIMENTAL_FLAG_KEYS.join(', ')}`);
    return;
  }
  let next: boolean;
  if (parts.length === 1) next = !exp[name];
  else if (parts[1] === 'on') next = true;
  else if (parts[1] === 'off') next = false;
  else {
    agent.addNotice('warn', `Invalid value "${parts[1]}". Use on or off.`);
    return;
  }
  agent.setExperimentalFlag(name, next);
}

function printPlanQueue(agent: AgentLoopApi): void {
  if (agent.plannedCalls.length === 0) {
    agent.addNotice('info', 'No queued plan.');
    return;
  }
  const lines: { level: 'info' | 'cyan'; text: string }[] = [
    {
      level: 'cyan',
      text: `Queued plan (${agent.plannedCalls.length} call${agent.plannedCalls.length === 1 ? '' : 's'}):`,
    },
  ];
  agent.plannedCalls.forEach((p, i) => {
    lines.push({ level: 'cyan', text: `  #${i + 1} ${p.toolName}` });
    for (const [k, v] of Object.entries(p.args)) {
      lines.push({ level: 'info', text: `     ${k}: ${formatArgValue(v)}` });
    }
  });
  lines.push({ level: 'info', text: '  Type y to approve, n to drop, or describe revisions.' });
  agent.addNoticeBlock(lines);
}
