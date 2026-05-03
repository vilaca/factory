import chalk from 'chalk';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { EXPERIMENTAL_FLAG_KEYS, type ExperimentalFlags } from '../core/config-types.js';

const marked = new Marked(markedTerminal() as any);

export function renderMarkdown(text: string): string {
  if (!text.trim()) return '';
  const rendered = marked.parse(text);
  if (typeof rendered === 'string') {
    // Remove trailing newlines that marked adds
    return rendered.replace(/\n+$/, '');
  }
  return text;
}

export function renderToolCall(toolName: string, args: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(chalk.cyan.bold(`  ▶ ${toolName}`));

  for (const [key, value] of Object.entries(args)) {
    const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
    const truncated = valueStr.length > 200 ? valueStr.slice(0, 200) + '...' : valueStr;
    lines.push(chalk.dim(`    ${key}: `) + truncated);
  }

  return lines.join('\n');
}

export function renderToolResult(result: string, success: boolean, empty?: boolean): string {
  const icon = !success ? chalk.red('  ✗') : empty ? chalk.yellow('  ○') : chalk.green('  ✓');
  const preview = result.length > 500 ? result.slice(0, 500) + '\n    ...(truncated)' : result;
  const indented = preview.split('\n').map(l => '    ' + l).join('\n');
  return `${icon}\n${chalk.dim(indented)}`;
}

export function renderPermissionPrompt(toolName: string): string {
  return chalk.yellow(`  Allow ${chalk.bold(toolName)}? `) +
    chalk.dim('[y]es / [n]o / [a]llow all: ');
}

function formatExperimentalFlags(flags: ExperimentalFlags | undefined): string {
  return EXPERIMENTAL_FLAG_KEYS
    .map(key => `${key}=${flags?.[key] ? 'on' : 'off'}`)
    .join(', ');
}

export function renderWelcome(
  model: string,
  cwd: string,
  experimental?: ExperimentalFlags,
  sessionLogDestination?: string,
  gitBranch?: string,
): string {
  const cwdLine = chalk.dim('  CWD:   ') + chalk.white(cwd) +
    (gitBranch ? chalk.dim('  (') + chalk.cyan(gitBranch) + chalk.dim(')') : '');
  const lines = [
    '',
    chalk.bold.cyan('  factory') + chalk.dim(` v0.1.0`),
    '',
    chalk.dim('  Model: ') + chalk.white(model),
    cwdLine,
    chalk.dim('  Logs:  ') + chalk.white(sessionLogDestination ?? 'disabled'),
    chalk.dim('  Exp:   ') + chalk.white(formatExperimentalFlags(experimental)),
    '',
    chalk.dim('  Tools: Read, Write, Edit, Bash, Glob, Grep'),
    chalk.dim('  Type /help for commands, /exit to quit'),
    '',
    chalk.dim('─'.repeat(60)),
    '',
  ];
  return lines.join('\n');
}

export function renderError(message: string): string {
  return chalk.red.bold('  Error: ') + chalk.red(message);
}

export interface ModelListItem {
  value: string;
  label?: string;
  detail?: string;
  warning?: string;
}

function formatModelLabel(label: string, selected: boolean): string {
  const freeSuffix = ' (free)';
  const legacySuffix = ' (legacy)';
  const isFree = label.endsWith(freeSuffix);
  const isLegacy = label.endsWith(legacySuffix);
  const suffix = isFree ? freeSuffix : isLegacy ? legacySuffix : '';
  const base = suffix ? label.slice(0, -suffix.length) : label;

  const baseText = selected ? chalk.cyan.bold(base) : base;
  if (!suffix) return baseText;

  const suffixText = isFree
    ? (selected ? chalk.green.bold(freeSuffix) : chalk.green(freeSuffix))
    : (selected ? chalk.yellow.bold(legacySuffix) : chalk.yellow(legacySuffix));
  return `${baseText}${suffixText}`;
}

export function renderModelList(models: Array<string | ModelListItem>, selected?: number): string {
  const lines = [
    '',
    chalk.bold('  Select a model:'),
    '',
  ];
  models.forEach((model, i) => {
    const item = typeof model === 'string' ? { value: model, label: model } : model;
    const label = item.label ?? item.value;
    const prefix = i === selected ? chalk.cyan('  ▸ ') : '    ';
    const text = formatModelLabel(label, i === selected);
    lines.push(`${prefix}${i + 1}. ${text}`);
    if (item.detail) {
      lines.push(chalk.dim(`       ${item.detail}`));
    }
    if (item.warning) {
      lines.push(chalk.yellow(`       ${item.warning}`));
    }
  });
  lines.push('');
  return lines.join('\n');
}
