import { formatArgValue } from '../../format.js';
import type { AgentLoopApi } from '../../agent-loop/use-agent-loop.js';
import type { SlashCommandContext } from '../types.js';

export function handlePlan({ agent }: SlashCommandContext): void {
  if (agent.plannedCalls.length > 0) printPlanQueue(agent);
  else agent.togglePlanMode();
}

export async function handleApprove(_arg: string, { agent }: SlashCommandContext): Promise<void> {
  const refs = agent.refs.current;
  if (!refs?.planMode || agent.plannedCalls.length === 0) {
    agent.addNotice('info', 'No plan to approve.');
    return;
  }
  await agent.approvePlan();
}

export function handleCancel({ agent }: SlashCommandContext): void {
  const refs = agent.refs.current;
  if (refs?.planMode && agent.plannedCalls.length > 0) {
    agent.cancelPlan();
    agent.addNotice('info', 'Plan dropped.');
  } else {
    agent.addNotice('info', 'No plan to cancel.');
  }
}

export function printPlanQueue(agent: AgentLoopApi): void {
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
