import chalk from 'chalk';
import { DEFAULT_LOGO_FRAME_MS } from './constants.js';

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
