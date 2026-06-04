import type { SlashCommandContext } from './types.js';
import { HANDLERS } from './dispatch-map.js';

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
