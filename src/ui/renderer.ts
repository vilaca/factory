import chalk from 'chalk';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { EXPERIMENTAL_FLAG_KEYS, type ExperimentalFlags } from '../core/config-types.js';

// marked-terminal v7's `text` renderer ignores marked v15's `tokens` array on
// text tokens, so inline formatting (bold/italic/code/links) is dropped inside
// list items. Patch it to parse the inline tokens when present.
const ext = markedTerminal({ reflowText: false, width: 0 }) as any;
const origText = ext.renderer.text;
ext.renderer.text = function (token: any): string {
  if (token && typeof token === 'object' && Array.isArray(token.tokens) && token.tokens.length > 0) {
    return this.parser.parseInline(token.tokens);
  }
  return origText.call(this, token);
};

const marked = new Marked(ext);

export function renderMarkdown(text: string): string {
  if (!text.trim()) return text;
  const rendered = marked.parse(text);
  if (typeof rendered === 'string') {
    return rendered.replace(/^\n+/, '').replace(/\n+$/, '');
  }
  return text;
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
