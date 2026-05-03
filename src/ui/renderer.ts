import chalk from 'chalk';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { EXPERIMENTAL_FLAG_KEYS, type ExperimentalFlags } from '../core/config-types.js';

// marked-terminal v7's `text` renderer ignores marked v15's `tokens` array on
// text tokens, so inline formatting (bold/italic/code/links) is dropped inside
// list items. Patch it to parse the inline tokens when present.
const ext = markedTerminal({ reflowText: false, width: 0, showSectionPrefix: false }) as any;
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
