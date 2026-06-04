import type { AgentLoopApi } from '../../agent-loop/use-agent-loop.js';
import { EXPERIMENTAL_FLAG_KEYS, type ExperimentalFlagKey } from '../../../../core/config/types.js';
import { dispatchHooks } from '../hooks.js';
import type { SlashCommandContext } from '../types.js';

export function handleLog({ agent }: SlashCommandContext): void {
  const refs = agent.refs.current!;
  if (refs.sessionLogger) {
    agent.addNotice('info', `Session log: ${refs.sessionLogger.filePath}`);
  } else {
    agent.addNotice('info', 'Session logging is disabled.');
  }
}

export function handleCorrect(arg: string, { agent }: SlashCommandContext): void {
  const refs = agent.refs.current!;
  let next: boolean;
  if (arg === 'on') next = true;
  else if (arg === 'off') next = false;
  else if (!arg) next = !refs.enableCorrector;
  else return agent.addNotice('info', 'Usage: /correct on|off');
  agent.setCorrector(next);
}

export async function handleHooks(_arg: string, { agent }: SlashCommandContext): Promise<void> {
  const refs = agent.refs.current!;
  await dispatchHooks(agent, refs.hooksConfig);
}

export function handleFull(_arg: string, ctx: SlashCommandContext): void {
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

export function handleExpCommand(agent: AgentLoopApi, arg: string): void {
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

export function handleSkillsList(agent: AgentLoopApi): void {
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

export function handleSkillShow(agent: AgentLoopApi, arg: string): void {
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

export function handleEmoji(arg: string, { agent }: SlashCommandContext): void {
  const trimmed = arg.trim();
  if (trimmed) agent.setUserEmoji(trimmed);
  else agent.toggleEmojiMode();
}
