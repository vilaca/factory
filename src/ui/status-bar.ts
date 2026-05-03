import chalk from 'chalk';

export interface StatusInfo {
  model: string;
  provider: string;
  tokensUsed?: number;
  contextWindow?: number;
  sessionTurns?: number;
  sessionToolCalls?: number;
  planMode?: boolean;
}

export function renderStatusLine(info: StatusInfo): string {
  const parts: string[] = [];

  if (info.planMode) {
    parts.push(chalk.cyan.bold('PLAN'));
  }

  parts.push(chalk.dim(`${info.provider}/${info.model}`));

  if (info.tokensUsed !== undefined && info.contextWindow) {
    const pct = Math.round((info.tokensUsed / info.contextWindow) * 100);
    const color = pct > 75 ? chalk.red : pct > 50 ? chalk.yellow : chalk.green;
    parts.push(color(`${info.tokensUsed.toLocaleString()}/${info.contextWindow.toLocaleString()} tokens (${pct}%)`));
  }

  if (info.sessionTurns !== undefined) {
    parts.push(chalk.dim(`${info.sessionTurns} ${info.sessionTurns === 1 ? 'turn' : 'turns'}`));
  }

  if (info.sessionToolCalls !== undefined) {
    parts.push(chalk.dim(`${info.sessionToolCalls} ${info.sessionToolCalls === 1 ? 'tool' : 'tools'}`));
  }

  return chalk.dim('[') + parts.join(chalk.dim(' | ')) + chalk.dim(']');
}
