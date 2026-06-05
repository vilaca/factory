import chalk from 'chalk';
import { EXPERIMENTAL_FLAG_KEYS, type ExperimentalFlags } from '../core/config/types.js';
import { getBuildInfo } from '../utils/build-info.js';
import { DEFAULT_TERMINAL_COLS, MIN_WRAP_AVAILABLE_WIDTH } from './constants.js';

function formatExperimentalFlags(flags: ExperimentalFlags | undefined): string {
  return EXPERIMENTAL_FLAG_KEYS.map(key => `${key}=${flags?.[key] ? 'on' : 'off'}`).join(', ');
}

// Wrap a comma-separated value to fit `terminalWidth`, indenting continuation
// lines by `labelWidth` spaces so they align under the value column. Tokens
// longer than the available width are kept whole and allowed to overflow
// rather than being split mid-name.
function wrapCommaList(value: string, labelWidth: number, terminalWidth: number): string {
  const tokens = value.split(', ');
  if (tokens.length <= 1) return value;
  const sep = ', ';
  const available = Math.max(MIN_WRAP_AVAILABLE_WIDTH, terminalWidth - labelWidth);
  const indent = ' '.repeat(labelWidth);
  const lines: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (!current) {
      current = token;
    } else if (current.length + sep.length + token.length <= available) {
      current += sep + token;
    } else {
      lines.push(current + ',');
      current = token;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n' + indent);
}

export function renderWelcome(
  model: string,
  cwd: string,
  experimental?: ExperimentalFlags,
  sessionLogDestination?: string,
  gitBranch?: string,
  tools: string[] = [],
): string {
  const branch = gitBranch ? chalk.dim(' (') + chalk.cyan(gitBranch) + chalk.dim(')') : '';
  // Both "Exp:" and "Tools:" produce comma-separated lists that can easily
  // overflow narrow terminals; wrap them so continuation lines align under
  // the value column instead of the left margin.
  const labelWidth = '  Tools: '.length;
  const cols = process.stdout.columns ?? DEFAULT_TERMINAL_COLS;
  const expValue = wrapCommaList(formatExperimentalFlags(experimental), labelWidth, cols);
  const toolsValue = wrapCommaList(tools.join(', '), labelWidth, cols);
  const lines = [
    '',
    chalk.dim('  v' + getBuildInfo().version),
    '',
    chalk.dim('  Model: ') + chalk.white(model),
    chalk.dim('  Tools: ') + chalk.white(toolsValue),
    chalk.dim('  Flags: ') + chalk.white(expValue),
    chalk.dim('  Logs:  ') + chalk.white(sessionLogDestination ?? 'disabled'),
    chalk.dim('  Cwd:   ') + chalk.white(cwd) + branch,
    '',
    chalk.dim('  Type /help for commands, /exit to quit'),
    '',
    chalk.dim('─'.repeat(DEFAULT_TERMINAL_COLS)),
    '',
  ];
  return lines.join('\n');
}
