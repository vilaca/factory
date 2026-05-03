import chalk from 'chalk';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  return `${minutes}m${remSec.toString().padStart(2, '0')}s`;
}

export class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private message: string;
  private startedAt = 0;

  constructor(message = 'Thinking') {
    this.message = message;
  }

  start(message?: string): void {
    if (message) this.message = message;
    if (this.interval) return;

    this.frameIndex = 0;
    this.startedAt = Date.now();
    this.interval = setInterval(() => {
      const frame = FRAMES[this.frameIndex % FRAMES.length];
      const elapsedMs = Date.now() - this.startedAt;
      const elapsedStr = elapsedMs >= 1000 ? ` ${formatElapsed(elapsedMs)}` : '';
      process.stderr.write(`\r${chalk.cyan(frame)} ${chalk.dim(this.message + elapsedStr)}   `);
      this.frameIndex++;
    }, 80);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      process.stderr.write('\r' + ' '.repeat(this.message.length + 20) + '\r');
    }
  }

  update(message: string): void {
    this.message = message;
  }
}
