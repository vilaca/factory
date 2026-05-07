import chalk from 'chalk';
import { supportsLanguage } from 'cli-highlight';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { EXPERIMENTAL_FLAG_KEYS, type ExperimentalFlags } from '../core/config-types.js';
import { getBuildInfo } from '../utils/build-info.js';

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

// highlight.js writes "Could not find the language '…'" to stderr (and throws,
// which marked-terminal catches) when the fence tag isn't a registered hljs
// language — common with LLM output like ```plain / ```plaintext / ```output.
// Strip unsupported langs so cli-highlight takes the auto-detect path instead.
const origCode = ext.renderer.code;
ext.renderer.code = function (token: any): string {
  if (token && typeof token === 'object' && token.lang && !supportsLanguage(String(token.lang))) {
    token = { ...token, lang: '' };
  }
  return origCode.call(this, token);
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

export const LOGO_LETTERS_LEET: ReadonlyArray<{ color: string; rows: string[] }> = [
  {
    color: '#FFD93D',
    rows: [
      '███████╗',
      '██╔════╝',
      '█████╗  ',
      '██╔══╝  ',
      '██║     ',
      '╚═╝     ',
    ],
  },
  {
    color: '#FF6BD0',
    rows: [
      '██╗  ██╗',
      '██║  ██║',
      '███████║',
      '╚════██║',
      '     ██║',
      '     ╚═╝',
    ],
  },
  {
    color: '#00E0FF',
    rows: [
      '██╗  ██╗',
      '██║ ██╔╝',
      '█████╔╝ ',
      '██╔═██╗ ',
      '██║  ██╗',
      '╚═╝  ╚═╝',
    ],
  },
  {
    color: '#7CFF6B',
    rows: [
      '███████╗ ',
      '╚════██║ ',
      '    ██╔╝ ',
      '   ██╔╝  ',
      '   ██║   ',
      '   ╚═╝   ',
    ],
  },
  {
    color: '#FFA94D',
    rows: [
      ' ██████╗ ',
      '██╔═████╗',
      '██║██╔██║',
      '████╔╝██║',
      '╚██████╔╝',
      ' ╚═════╝ ',
    ],
  },
  {
    color: '#FF5C5C',
    rows: [
      '██████╗ ',
      '██╔══██╗',
      '██████╔╝',
      '██╔══██╗',
      '██║  ██║',
      '╚═╝  ╚═╝',
    ],
  },
  {
    color: '#B266FF',
    rows: [
      '██╗   ██╗',
      '╚██╗ ██╔╝',
      ' ╚████╔╝ ',
      '  ╚██╔╝  ',
      '   ██║   ',
      '   ╚═╝   ',
    ],
  },
];

export const LOGO_LETTERS: ReadonlyArray<{ color: string; rows: string[] }> = [
  {
    color: '#FFD93D',
    rows: [
      '███████╗',
      '██╔════╝',
      '█████╗  ',
      '██╔══╝  ',
      '██║     ',
      '╚═╝     ',
    ],
  },
  {
    color: '#FF6BD0',
    rows: [
      ' █████╗ ',
      '██╔══██╗',
      '███████║',
      '██╔══██║',
      '██║  ██║',
      '╚═╝  ╚═╝',
    ],
  },
  {
    color: '#00E0FF',
    rows: [
      ' ██████╗',
      '██╔════╝',
      '██║     ',
      '██║     ',
      '╚██████╗',
      ' ╚═════╝',
    ],
  },
  {
    color: '#7CFF6B',
    rows: [
      '████████╗',
      '╚══██╔══╝',
      '   ██║   ',
      '   ██║   ',
      '   ██║   ',
      '   ╚═╝   ',
    ],
  },
  {
    color: '#FFA94D',
    rows: [
      ' ██████╗ ',
      '██╔═══██╗',
      '██║   ██║',
      '██║   ██║',
      '╚██████╔╝',
      ' ╚═════╝ ',
    ],
  },
  {
    color: '#FF5C5C',
    rows: [
      '██████╗ ',
      '██╔══██╗',
      '██████╔╝',
      '██╔══██╗',
      '██║  ██║',
      '╚═╝  ╚═╝',
    ],
  },
  {
    color: '#B266FF',
    rows: [
      '██╗   ██╗',
      '╚██╗ ██╔╝',
      ' ╚████╔╝ ',
      '  ╚██╔╝  ',
      '   ██║   ',
      '   ╚═╝   ',
    ],
  },
];

function renderLogoFrame(shift: number): string {
  const palette = LOGO_LETTERS.map(l => l.color);
  const animating = shift < palette.length;
  const letters = animating ? LOGO_LETTERS_LEET : LOGO_LETTERS;
  const rowCount = letters[0].rows.length;
  const lines: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const segments = letters.map((letter, i) => {
      const color = palette[(i + shift) % palette.length];
      return chalk.hex(color)(letter.rows[r]);
    });
    lines.push('  ' + segments.join(''));
  }
  return lines.join('\n');
}

export function renderLogo(): string {
  return renderLogoFrame(LOGO_LETTERS.length);
}

export async function animateLogo(frameMs = 220): Promise<void> {
  const rowCount = LOGO_LETTERS[0].rows.length;
  if (!process.stdout.isTTY) {
    process.stdout.write(renderLogoFrame(LOGO_LETTERS.length) + '\n');
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
): string {
  const cwdLine = chalk.dim('  CWD:   ') + chalk.white(cwd) +
    (gitBranch ? chalk.dim('  (') + chalk.cyan(gitBranch) + chalk.dim(')') : '');
  const lines = [
    '',
    chalk.dim('  v' + getBuildInfo().version),
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
