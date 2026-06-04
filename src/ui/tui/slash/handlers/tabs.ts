import { EXIT_GRACE_MS } from '../../constants.js';
import type { SlashCommandContext } from '../types.js';

export function handleExit(_arg: string, ctx: SlashCommandContext): void {
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
  setTimeout(() => process.exit(0), EXIT_GRACE_MS).unref();
}

export function handleNew(arg: string, { agent, tabs }: SlashCommandContext): void {
  if (!tabs) return agent.addNotice('warn', 'Tabs not available.');
  const label = arg.trim() || undefined;
  tabs.openTab(label);
}

export function handleClose(_arg: string, { agent, tabs }: SlashCommandContext): void {
  if (!tabs) return agent.addNotice('warn', 'Tabs not available.');
  if (tabs.tabs.length === 1) return agent.addNotice('info', 'Last tab — use /exit to quit.');
  agent.abort();
  tabs.closeTab(tabs.activeId);
}

export function handleTabs(_arg: string, { agent, tabs }: SlashCommandContext): void {
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

export function handleSwitch(arg: string, { agent, tabs }: SlashCommandContext): void {
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
