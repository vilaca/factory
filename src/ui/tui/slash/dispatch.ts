import type { SlashCommandContext } from './types.js';
import { HANDLERS } from './dispatch-map.js';
import { invokeSkill } from '../../../core/skills/invoke.js';

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

  // Skill catch-all: unknown /foo → try registry.find('foo').
  const refs = ctx.agent.refs.current;
  const registry = refs.skills;
  if (registry) {
    const skillName = cmd.replace(/^\//, '');
    const skill = registry.find(skillName);
    if (skill && skill.userInvocable) {
      const invokeCtx = {
        registry,
        permissions: refs.permissions,
        cwd: refs.cwd,
        shellInjectionEnabled: refs.experimental.skills !== false,
        injectSystemMessage: (text: string) => {
          refs.conversation.addUser(`[System: ${text}]`);
        },
      };
      const result = await invokeSkill(skillName, arg, invokeCtx);
      if (result.kind === 'not-found') {
        ctx.agent.addNotice('warn', `No skill named "${skillName}". Use /skills to list skills.`);
      } else if (result.kind === 'path-restricted') {
        ctx.agent.addNotice(
          'warn',
          `Skill "${skillName}" is not available in the current directory.`,
        );
      } else if (result.kind === 'model-invocation-disabled') {
        ctx.agent.addNotice('warn', `Skill "${skillName}" is not available.`);
      } else {
        ctx.agent.addNotice('info', `Skill "${skillName}" injected.`);
      }
      return true;
    }
  }

  ctx.agent.addNotice('info', `Unknown command: ${cmd}. Type /help for available commands.`);
  return true;
}
