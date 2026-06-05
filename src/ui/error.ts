import chalk from 'chalk';

export function renderError(message: string): string {
  return chalk.red.bold('  Error: ') + chalk.red(message);
}
