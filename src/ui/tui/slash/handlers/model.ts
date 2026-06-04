import type { SlashCommandContext } from '../types.js';

export async function handleModel(arg: string, ctx: SlashCommandContext): Promise<void> {
  if (arg) {
    // Power user syntax: /model <provider>:<model>
    await ctx.agent.setModelByName(arg);
    return;
  }
  // No argument: open the picker
  if (ctx.openPicker) ctx.openPicker();
  else ctx.agent.addNotice('warn', 'Picker not available in this context.');
}

export async function handleCompactionModel(arg: string, ctx: SlashCommandContext): Promise<void> {
  const refs = ctx.agent.refs.current;
  if (!refs) return;
  const trimmed = arg.trim().toLowerCase();
  if (trimmed === 'show') {
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
  if (trimmed === 'clear') {
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
