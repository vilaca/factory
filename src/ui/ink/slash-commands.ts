import { formatArgValue } from './format.js';
import type { AgentLoopApi } from './use-agent-loop.js';
import { EXPERIMENTAL_FLAG_KEYS, type ExperimentalFlagKey } from '../../core/config-types.js';

export interface SlashCommandContext {
  agent: AgentLoopApi;
  exit: () => void;
}

export async function dispatchSlashCommand(
  cmd: string,
  arg: string,
  ctx: SlashCommandContext,
): Promise<boolean> {
  const { agent, exit } = ctx;
  const refs = agent.refs;
  if (!refs.current) return false;

  switch (cmd) {
    case '/exit':
    case '/quit':
    case '/q':
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
        agent.addNotice('info', `Current model: ${refs.current.model}`);
      }
      return true;
    case '/exp':
      handleExpCommand(agent, arg);
      return true;
  }

  agent.addNotice('info', `Unknown command: ${cmd}. Type /help for available commands.`);
  return true;
}

function printHelp(agent: AgentLoopApi): void {
  const lines: [string, string][] = [
    ['/exit, /quit, /q', 'Exit factory'],
    ['/clear', 'Clear conversation history'],
    ['/model <name>', 'Switch model (or show current)'],
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
  agent.addNoticeBlock([
    { level: 'cyan', text: 'Commands:' },
    ...lines.map(([c, desc]) => ({
      level: 'info' as const,
      text: `  ${c.padEnd(18)} ${desc}`,
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
