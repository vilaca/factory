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
      let skillInject: string | undefined;
      const invokeCtx = {
        registry,
        permissions: refs.permissions,
        cwd: refs.cwd,
        // User-invoked skills pass !```bash blocks verbatim so the model
        // runs them via tool calls, matching claude.ai slash-command behaviour.
        shellInjectionEnabled: false,
        injectSystemMessage: (text: string) => {
          // Store rather than inject immediately so the message can be passed
          // as userInput to submitPrompt — harness reads (scoped project
          // instructions) then land in the conversation BEFORE this message,
          // matching the order used for normal prompts.
          //
          // Wrap with an imperative so the model executes the body instead of
          // merely acknowledging it as available context. Do not name the
          // `invoke_skill` tool — the skill is already loaded.
          const argSuffix = arg ? ` ${arg}` : '';
          skillInject = `[System: The user invoked /${skillName}${argSuffix}. Execute these skill instructions now (the skill is already loaded; do not call invoke_skill):\n\n${text}]`;
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
      } else if (result.kind === 'injected') {
        ctx.agent.addNotice('info', `Skill "${skillName}" invoked.`);
        // Trigger a model turn so the agent processes the injected skill body.
        // Pass the skill content as userInput so harness reads happen first.
        await ctx.agent.submitPrompt(skillInject ?? '');
      } else {
        // delegated — show the sub-agent summary.
        ctx.agent.addNotice('info', result.summary);
      }
      return true;
    }
  }

  ctx.agent.addNotice('info', `Unknown command: ${cmd}. Type /help for available commands.`);
  return true;
}
