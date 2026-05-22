import { formatArgValue } from '../format.js';
import type { AgentLoopApi } from '../agent-loop/use-agent-loop.js';
import type { TabsContextValue } from '../tabs/TabsContext.js';
import { EXPERIMENTAL_FLAG_KEYS, type ExperimentalFlagKey } from '../../../core/config/types.js';
import { dispatchRotate } from './rotate.js';
import { dispatchKeys } from './keys.js';
import { dispatchStats } from './stats.js';
import { dispatchHooks } from './hooks.js';

interface SlashCommandContext {
  agent: AgentLoopApi;
  exit: () => void;
  tabs?: TabsContextValue;
  openPicker?: () => void;
  toggleFullOutput?: () => boolean;
  /** Opens the provider/model picker in compaction-target mode and resolves
   *  with the chosen tuple (or null on cancel). Wired by the TUI; absent in
   *  headless/test contexts that don't host the picker. */
  openCompactionPicker?: () => Promise<{ providerName: string; model: string } | null>;
}

type SlashHandler = (arg: string, ctx: SlashCommandContext) => void | Promise<void>;

function handleExit(_arg: string, ctx: SlashCommandContext): void {
  const { agent, exit, tabs } = ctx;
  // With multiple tabs open, /exit closes the active one; only the last
  // tab triggers a process exit. Without tabs context, exit the process.
  if (tabs && tabs.tabs.length > 1) {
    agent.abort();
    tabs.closeTab(tabs.activeId);
    return;
  }
  // Abort any in-flight model stream first — without this, Ink unmounts but
  // Node sits waiting for the open HTTP socket to drain before exiting.
  agent.abort();
  exit();
  // If anything (an unflushed stream, a stubborn provider HTTP request, a
  // still-running tool subprocess) keeps the event loop alive past a grace
  // period, force the exit.
  setTimeout(() => process.exit(0), 1000).unref();
}

function handleNew(arg: string, { agent, tabs }: SlashCommandContext): void {
  if (!tabs) return agent.addNotice('warn', 'Tabs not available.');
  const label = arg.trim() || undefined;
  tabs.openTab(label);
}

function handleClose(_arg: string, { agent, tabs }: SlashCommandContext): void {
  if (!tabs) return agent.addNotice('warn', 'Tabs not available.');
  if (tabs.tabs.length === 1) return agent.addNotice('info', 'Last tab — use /exit to quit.');
  agent.abort();
  tabs.closeTab(tabs.activeId);
}

function handleTabs(_arg: string, { agent, tabs }: SlashCommandContext): void {
  if (!tabs) return agent.addNotice('warn', 'Tabs not available.');
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
  lines.push({
    level: 'info',
    text: 'Switch with /switch <n|label>, Ctrl+N (next), Ctrl+P (prev). Open with /new or Ctrl+T.',
  });
  agent.addNoticeBlock(lines);
}

function handleSwitch(arg: string, { agent, tabs }: SlashCommandContext): void {
  if (!tabs) return agent.addNotice('warn', 'Tabs not available.');
  const a = arg.trim();
  if (!a) {
    return agent.addNotice(
      'warn',
      `Usage: /switch <n|label>  (1..${tabs.tabs.length}, or tab label / prefix)`,
    );
  }
  // Pure integer → index switch.
  if (/^\d+$/.test(a)) {
    const n = Number.parseInt(a, 10);
    if (n < 1 || n > tabs.tabs.length) {
      return agent.addNotice('warn', `Tab ${n} doesn't exist (1..${tabs.tabs.length})`);
    }
    tabs.switchToIndex(n - 1);
    return;
  }
  // Exact label match — preferred when labels alone disambiguate.
  const exact = tabs.tabs.filter(t => t.label === a);
  if (exact.length === 1) {
    tabs.switchTo(exact[0]!.id);
    return;
  }
  if (exact.length > 1) {
    return agent.addNotice('warn', `Multiple tabs labelled "${a}" — switch by index instead.`);
  }
  // Unique prefix match.
  const prefix = tabs.tabs.filter(t => t.label.startsWith(a));
  if (prefix.length === 1) {
    tabs.switchTo(prefix[0]!.id);
    return;
  }
  if (prefix.length > 1) {
    const labels = prefix.map(t => t.label).join(', ');
    return agent.addNotice('warn', `Ambiguous "${a}": matches ${labels}`);
  }
  agent.addNotice('warn', `No tab matches "${a}".`);
}

function handlePlan({ agent }: SlashCommandContext): void {
  if (agent.plannedCalls.length > 0) printPlanQueue(agent);
  else agent.togglePlanMode();
}

async function handleApprove(_arg: string, { agent }: SlashCommandContext): Promise<void> {
  const refs = agent.refs.current;
  if (!refs?.planMode || agent.plannedCalls.length === 0) {
    agent.addNotice('info', 'No plan to approve.');
    return;
  }
  await agent.approvePlan();
}

function handleCancel({ agent }: SlashCommandContext): void {
  const refs = agent.refs.current;
  if (refs?.planMode && agent.plannedCalls.length > 0) {
    agent.cancelPlan();
    agent.addNotice('info', 'Plan dropped.');
  } else {
    agent.addNotice('info', 'No plan to cancel.');
  }
}

function handleLog({ agent }: SlashCommandContext): void {
  const refs = agent.refs.current!;
  if (refs.sessionLogger) {
    agent.addNotice('info', `Session log: ${refs.sessionLogger.filePath}`);
  } else {
    agent.addNotice('info', 'Session logging is disabled.');
  }
}

function handleCorrect(arg: string, { agent }: SlashCommandContext): void {
  const refs = agent.refs.current!;
  let next: boolean;
  if (arg === 'on') next = true;
  else if (arg === 'off') next = false;
  else if (!arg) next = !refs.enableCorrector;
  else return agent.addNotice('info', 'Usage: /correct on|off');
  agent.setCorrector(next);
}

async function handleModel(arg: string, { agent }: SlashCommandContext): Promise<void> {
  const refs = agent.refs.current!;
  if (arg) {
    await agent.setModelByName(arg);
    return;
  }
  agent.addNoticeBlock([
    { level: 'info', text: `Current: ${refs.provider.name} / ${refs.model}` },
    {
      level: 'info',
      text: 'Switch with /pick (or Ctrl+K). Power users: /model <provider>:<model>.',
    },
  ]);
}

function handlePick(_arg: string, ctx: SlashCommandContext): void {
  if (ctx.openPicker) ctx.openPicker();
  else ctx.agent.addNotice('warn', 'Picker not available in this context.');
}

async function handleCompactionModel(arg: string, ctx: SlashCommandContext): Promise<void> {
  const refs = ctx.agent.refs.current;
  if (!refs) return;
  const trimmed = arg.trim().toLowerCase();
  if (trimmed === 'show' || trimmed === 'status') {
    if (refs.compactionTarget) {
      ctx.agent.addNotice(
        'info',
        `Compaction model: ${refs.compactionTarget.providerName} / ${refs.compactionTarget.model}`,
      );
    } else {
      ctx.agent.addNotice(
        'info',
        `Compaction model: primary (${refs.provider.name} / ${refs.model})`,
      );
    }
    return;
  }
  if (trimmed === 'clear' || trimmed === 'reset' || trimmed === 'default') {
    refs.compactionTarget = undefined;
    ctx.agent.addNotice(
      'info',
      `Compaction will use the primary model (${refs.provider.name} / ${refs.model}).`,
    );
    return;
  }
  if (!ctx.openCompactionPicker) {
    ctx.agent.addNotice('warn', 'Compaction picker not available in this context.');
    return;
  }
  const pick = await ctx.openCompactionPicker();
  if (!pick) return;
  refs.compactionTarget = pick;
  ctx.agent.addNotice('info', `Compaction model set to ${pick.providerName} / ${pick.model}.`);
}

async function handleHooks(_arg: string, { agent }: SlashCommandContext): Promise<void> {
  const refs = agent.refs.current!;
  await dispatchHooks(agent, refs.hooksConfig);
}

function handleFull(_arg: string, ctx: SlashCommandContext): void {
  if (!ctx.toggleFullOutput) {
    return ctx.agent.addNotice('warn', 'Full-output toggle not available in this context.');
  }
  const next = ctx.toggleFullOutput();
  ctx.agent.addNotice(
    'info',
    next
      ? 'Full tool output enabled (going forward).'
      : 'Full tool output disabled — back to preview.',
  );
}

function handleEmoji(arg: string, { agent }: SlashCommandContext): void {
  const trimmed = arg.trim();
  if (trimmed) agent.setUserEmoji(trimmed);
  else agent.toggleEmojiMode();
}

const HANDLERS: Record<string, SlashHandler> = {
  '/exit': handleExit,
  '/quit': handleExit,
  '/q': handleExit,
  '/new': handleNew,
  '/close': handleClose,
  '/tabs': handleTabs,
  '/switch': handleSwitch,
  '/clear': (_arg, { agent }) => agent.clearConversation(),
  '/help': (_arg, { agent }) => printHelp(agent),
  '/permissions': (_arg, { agent }) => {
    agent.resetPermissions();
    agent.addNotice('info', 'Permissions reset.');
  },
  '/plan': (_arg, ctx) => handlePlan(ctx),
  '/queue': (_arg, { agent }) => printPlanQueue(agent),
  '/approve': handleApprove,
  '/cancel': (_arg, ctx) => handleCancel(ctx),
  '/log': (_arg, ctx) => handleLog(ctx),
  '/correct': handleCorrect,
  '/model': handleModel,
  '/cwd': (arg, { agent }) => agent.setCwd(arg),
  '/exp': (arg, { agent }) => handleExpCommand(agent, arg),
  '/pick': handlePick,
  '/compaction-model': handleCompactionModel,
  '/rotate': (arg, { agent }) => dispatchRotate(arg, agent),
  '/keys': (arg, { agent }) => dispatchKeys(arg, agent),
  '/stats': (arg, { agent }) => dispatchStats(arg, agent),
  '/hooks': handleHooks,
  '/full': handleFull,
  '/skills': (_arg, { agent }) => handleSkillsList(agent),
  '/skill': (arg, { agent }) => handleSkillShow(agent, arg),
  // Easter egg — intentionally omitted from /help. `/emoji` toggles emoji
  // mode; `/emoji <glyph>` overrides the user prompt icon. Do not document.
  '/emoji': handleEmoji,
};

export async function dispatchSlashCommand(
  cmd: string,
  arg: string,
  ctx: SlashCommandContext,
): Promise<boolean> {
  if (!ctx.agent.refs.current) return false;

  const handler = HANDLERS[cmd];
  if (handler) {
    await handler(arg, ctx);
    return true;
  }

  ctx.agent.addNotice('info', `Unknown command: ${cmd}. Type /help for available commands.`);
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
    [
      '/model [<name>]',
      'Show current provider/model, or switch model. Accepts <provider>:<model>.',
    ],
    ['/pick', 'Open the provider/model picker (also Ctrl+K)'],
    [
      '/compaction-model [show|clear]',
      'Open the picker to choose a provider/model for context compaction (defaults to primary). `show` prints current; `clear` resets to primary.',
    ],
    ['/rotate', 'Manage the rotation chain (provider/model fallbacks)'],
    ['/keys [<provider>]', 'Show saved keys with usage / rate-limit / cache-hit counters'],
    ['/stats', 'Cache hit rate, compaction events, largest tool results for the current session'],
    ['/hooks', 'List configured hooks from agent.hooks config'],
    ['/full', 'Toggle full vs preview tool output (going forward)'],
    ['/cwd [dir]', "Show or change this tab's working directory"],
    ['/permissions', 'Reset tool permissions'],
    ['/plan', 'Toggle plan mode (or show queue if one exists)'],
    ['/queue', 'Show the queued plan'],
    ['/approve, y', 'Execute the queued plan'],
    ['/cancel, n', 'Drop the queued plan'],
    ['/log', 'Show the current session log path'],
    ['/correct on|off', 'Toggle the LLM tool-call corrector'],
    ['/exp [name on|off]', 'List or toggle experimental flags'],
    ['/skills', 'List loaded skills (when experimental.skills is on)'],
    ['/skill <name>', 'Print the body of a loaded skill'],
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
      ...EXPERIMENTAL_FLAG_KEYS.map(key => ({
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

function handleSkillsList(agent: AgentLoopApi): void {
  const refs = agent.refs;
  if (!refs.current) return;
  const reg = refs.current.skills;
  if (!reg) {
    agent.addNotice('info', 'Skills are not enabled. Toggle with /exp skills on.');
    return;
  }
  const skills = reg.list();
  if (skills.length === 0) {
    agent.addNotice(
      'info',
      'No skills loaded. Drop .md files into .factory/skills/ (project) or ~/.factory/skills/ (global).',
    );
    return;
  }
  const lines: { level: 'info' | 'cyan'; text: string }[] = [
    { level: 'cyan', text: `Loaded skills (${skills.length}):` },
  ];
  for (const s of skills) {
    const flags = [
      s.alwaysOn ? 'always-on' : null,
      s.triggers.length > 0
        ? `${s.triggers.length} trigger${s.triggers.length === 1 ? '' : 's'}`
        : null,
      s.tools.length > 0 ? `tools=[${s.tools.join(',')}]` : null,
      s.scope,
    ]
      .filter(Boolean)
      .join(', ');
    lines.push({ level: 'cyan', text: `  ${s.name}` });
    lines.push({ level: 'info', text: `    ${s.description}` });
    lines.push({ level: 'info', text: `    [${flags}]` });
  }
  agent.addNoticeBlock(lines);
}

function handleSkillShow(agent: AgentLoopApi, arg: string): void {
  const refs = agent.refs;
  if (!refs.current) return;
  const reg = refs.current.skills;
  if (!reg) {
    agent.addNotice('info', 'Skills are not enabled. Toggle with /exp skills on.');
    return;
  }
  const name = arg.trim();
  if (!name) {
    agent.addNotice('info', 'Usage: /skill <name>');
    return;
  }
  const skill = reg.find(name);
  if (!skill) {
    agent.addNotice('warn', `No skill named "${name}". Use /skills to list loaded skills.`);
    return;
  }
  const lines: { level: 'info' | 'cyan'; text: string }[] = [
    { level: 'cyan', text: `${skill.name} — ${skill.description}` },
    {
      level: 'info',
      text: `(source: ${skill.sourcePath}, scope: ${skill.scope}, alwaysOn: ${skill.alwaysOn})`,
    },
  ];
  for (const line of skill.body.split('\n')) {
    lines.push({ level: 'info', text: line });
  }
  agent.addNoticeBlock(lines);
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
