import chalk from 'chalk';
import { supportsLanguage } from 'cli-highlight';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { EXPERIMENTAL_FLAG_KEYS, type ExperimentalFlags } from '../core/config/types.js';
import { getBuildInfo } from '../utils/build-info.js';
import {
  DEFAULT_LOGO_FRAME_MS,
  DEFAULT_TERMINAL_COLS,
  MIN_WRAP_AVAILABLE_WIDTH,
  WELCOME_RULE_WIDTH,
} from './constants.js';

/** Minimal shape of the marked-terminal extension we patch. The package's
 *  exported types don't expose the `renderer` object directly, so we declare
 *  a narrow surface covering exactly what we touch. */
interface MarkedTerminalExt {
  renderer: {
    text: (
      this: { parser: { parseInline: (tokens: unknown[]) => string } },
      token: unknown,
    ) => string;
    code: (token: unknown) => string;
  };
}

interface TextTokenLike {
  tokens?: unknown[];
}

interface CodeTokenLike {
  lang?: unknown;
}

// marked-terminal v7's `text` renderer ignores marked v15's `tokens` array on
// text tokens, so inline formatting (bold/italic/code/links) is dropped inside
// list items. Patch it to parse the inline tokens when present.
const ext = markedTerminal({
  reflowText: false,
  width: 0,
  showSectionPrefix: false,
  // marked-terminal supports `tab` (indent width), but its exported
  // `MarkedTerminalOptions` type doesn't currently include it.
  tab: 2,
} as unknown as Record<string, unknown>) as unknown as MarkedTerminalExt;
const origText = ext.renderer.text;
ext.renderer.text = function (token: unknown): string {
  if (token && typeof token === 'object') {
    const t = token as TextTokenLike;
    if (Array.isArray(t.tokens) && t.tokens.length > 0) {
      return this.parser.parseInline(t.tokens);
    }
  }
  return origText.call(this, token);
};

// highlight.js writes "Could not find the language '…'" to stderr (and throws,
// which marked-terminal catches) when the fence tag isn't a registered hljs
// language — common with LLM output like ```plain / ```plaintext / ```output.
// Strip unsupported langs so cli-highlight takes the auto-detect path instead.
const origCode = ext.renderer.code;
ext.renderer.code = function (token: unknown): string {
  if (token && typeof token === 'object') {
    const t = token as CodeTokenLike;
    if (t.lang && !supportsLanguage(String(t.lang))) {
      token = { ...t, lang: '' };
    }
  }
  return origCode.call(this, token);
};

const marked = new Marked(ext as unknown as Parameters<typeof Marked.prototype.use>[0]);

function listIndent(line: string): number | null {
  const match = line.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/);
  if (!match) return null;
  return match[1]?.length ?? 0;
}

function isFenceDelimiter(line: string): boolean {
  return /^\s*(?:```|~~~)/.test(line);
}

function isDashRule(line: string): boolean {
  return /^\s*-{4,}\s*$/.test(line);
}

function collapseBlankRunsOutsideFences(lines: string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  let pendingBlank = false;

  for (const line of lines) {
    if (isFenceDelimiter(line)) {
      if (pendingBlank) {
        out.push('');
        pendingBlank = false;
      }
      out.push(line);
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    if (line.trim() === '') {
      pendingBlank = true;
      continue;
    }

    if (pendingBlank) {
      out.push('');
      pendingBlank = false;
    }
    out.push(line);
  }

  if (pendingBlank) out.push('');
  return out;
}

/**
 * Heuristic normalizer for occasionally malformed LLM list output:
 * - Removes blank lines between a list item and an immediate nested list.
 * - Removes blank lines between nested sibling list items.
 *
 * It intentionally leaves top-level loose lists untouched and skips fenced code
 * blocks entirely.
 */
export function normalizeMarkdownLists(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; ) {
    const line = lines[i] ?? '';
    out.push(line);

    if (isFenceDelimiter(line)) {
      inFence = !inFence;
      i += 1;
      continue;
    }

    if (inFence) {
      i += 1;
      continue;
    }

    const currentIndent = listIndent(line);
    if (currentIndent === null) {
      i += 1;
      continue;
    }

    let j = i + 1;
    while (j < lines.length && (lines[j] ?? '').trim() === '') j += 1;

    if (j === i + 1) {
      i += 1;
      continue;
    }

    const nextLine = lines[j] ?? '';
    const nextIndent = listIndent(nextLine);
    const shouldTighten =
      nextIndent !== null &&
      (nextIndent > currentIndent || (currentIndent > 0 && nextIndent === currentIndent));

    if (!shouldTighten) {
      for (let k = i + 1; k < j; k++) out.push(lines[k] ?? '');
      i = j;
      continue;
    }

    // Skip the blank run and continue from the next non-empty line.
    i = j;
  }

  return out.join('\n');
}

/**
 * Normalizes common formatting glitches in model markdown output:
 * - canonicalizes long dash-only separator lines to `---`
 * - guarantees a blank line before horizontal rules
 * - collapses repeated blank runs outside fenced code blocks
 * - tightens malformed nested list spacing (`normalizeMarkdownLists`)
 */
export function normalizeMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (isFenceDelimiter(line)) {
      out.push(line);
      inFence = !inFence;
      continue;
    }

    if (!inFence && isDashRule(line)) {
      if (out.length > 0 && (out[out.length - 1] ?? '').trim() !== '') {
        out.push('');
      }
      out.push('---');
      continue;
    }

    out.push(line);
  }

  const collapsed = collapseBlankRunsOutsideFences(out).join('\n');
  return normalizeMarkdownLists(collapsed);
}

export function renderMarkdown(text: string): string {
  if (!text.trim()) return text;
  const normalized = normalizeMarkdown(text);
  const rendered = marked.parse(normalized);
  if (typeof rendered === 'string') {
    return rendered.replace(/^\n+/, '').replace(/\n+$/, '');
  }
  return text;
}

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

const LOGO_LETTERS_LEET: ReadonlyArray<{ color: string; rows: string[] }> = [
  {
    color: '#FFD93D',
    rows: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '██║     ', '╚═╝     '],
  },
  {
    color: '#FF6BD0',
    rows: ['██╗  ██╗', '██║  ██║', '███████║', '╚════██║', '     ██║', '     ╚═╝'],
  },
  {
    color: '#00E0FF',
    rows: ['██╗  ██╗', '██║ ██╔╝', '█████╔╝ ', '██╔═██╗ ', '██║  ██╗', '╚═╝  ╚═╝'],
  },
  {
    color: '#7CFF6B',
    rows: ['███████╗ ', '╚════██║ ', '    ██╔╝ ', '   ██╔╝  ', '   ██║   ', '   ╚═╝   '],
  },
  {
    color: '#FFA94D',
    rows: [' ██████╗ ', '██╔═████╗', '██║██╔██║', '████╔╝██║', '╚██████╔╝', ' ╚═════╝ '],
  },
  {
    color: '#FF5C5C',
    rows: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
  },
  {
    color: '#B266FF',
    rows: ['██╗   ██╗', '╚██╗ ██╔╝', ' ╚████╔╝ ', '  ╚██╔╝  ', '   ██║   ', '   ╚═╝   '],
  },
];

const LOGO_LETTERS: ReadonlyArray<{ color: string; rows: string[] }> = [
  {
    color: '#FFD93D',
    rows: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '██║     ', '╚═╝     '],
  },
  {
    color: '#FF6BD0',
    rows: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  },
  {
    color: '#00E0FF',
    rows: [' ██████╗', '██╔════╝', '██║     ', '██║     ', '╚██████╗', ' ╚═════╝'],
  },
  {
    color: '#7CFF6B',
    rows: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
  },
  {
    color: '#FFA94D',
    rows: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
  },
  {
    color: '#FF5C5C',
    rows: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
  },
  {
    color: '#B266FF',
    rows: ['██╗   ██╗', '╚██╗ ██╔╝', ' ╚████╔╝ ', '  ╚██╔╝  ', '   ██║   ', '   ╚═╝   '],
  },
];

function renderLogoFrame(shift: number): string {
  const palette = LOGO_LETTERS.map(l => l.color);
  const animating = shift < palette.length;
  const letters = animating ? LOGO_LETTERS_LEET : LOGO_LETTERS;
  const rowCount = letters[0]!.rows.length;
  const lines: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const segments = letters.map((letter, i) => {
      const color = palette[(i + shift) % palette.length]!;
      return chalk.hex(color)(letter.rows[r]!);
    });
    lines.push('  ' + segments.join(''));
  }
  return lines.join('\n');
}

export async function animateLogo(frameMs = DEFAULT_LOGO_FRAME_MS): Promise<void> {
  const rowCount = LOGO_LETTERS[0]!.rows.length;
  const logoWidth = LOGO_LETTERS[0]!.rows.reduce((max, _, rowIndex) => {
    const rowWidth = LOGO_LETTERS.reduce((sum, letter) => sum + letter.rows[rowIndex]!.length, 2);
    return Math.max(max, rowWidth);
  }, 0);

  // Fallback for narrow terminals or non-TTY: print normal-size "Factory" with the same per-letter colors.
  if (!process.stdout.isTTY || (process.stdout.columns ?? 0) < logoWidth) {
    const palette = LOGO_LETTERS.map(l => l.color);
    const word = 'FACTORY';
    const colored = word
      .split('')
      .map((ch, i) => chalk.bold.hex(palette[i % palette.length]!)(ch))
      .join(' ');
    process.stdout.write('  ' + colored + '\n');
    return;
  }

  const totalFrames = LOGO_LETTERS.length + 1;
  for (let frame = 0; frame < totalFrames; frame++) {
    if (frame > 0) process.stdout.write(`\x1B[${rowCount}A`);
    process.stdout.write(renderLogoFrame(frame) + '\n');
    if (frame < totalFrames - 1) {
      await new Promise(resolve => setTimeout(resolve, frameMs));
    }
  }
}

export function renderWelcome(
  model: string,
  cwd: string,
  experimental?: ExperimentalFlags,
  sessionLogDestination?: string,
  gitBranch?: string,
  tools: string[] = [],
): string {
  const cwdLine =
    chalk.dim('  CWD:   ') +
    chalk.white(cwd) +
    (gitBranch ? chalk.dim('  (') + chalk.cyan(gitBranch) + chalk.dim(')') : '');
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
    cwdLine,
    chalk.dim('  Logs:  ') + chalk.white(sessionLogDestination ?? 'disabled'),
    chalk.dim('  Exp:   ') + chalk.white(expValue),
    '',
    chalk.dim('  Tools: ') + chalk.white(toolsValue),
    chalk.dim('  Type /help for commands, /exit to quit'),
    '',
    chalk.dim('─'.repeat(WELCOME_RULE_WIDTH)),
    '',
  ];
  return lines.join('\n');
}

export function renderError(message: string): string {
  return chalk.red.bold('  Error: ') + chalk.red(message);
}
