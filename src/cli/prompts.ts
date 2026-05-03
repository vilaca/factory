import readline from 'readline';
import chalk from 'chalk';

export function isExitSelection(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '0' || normalized === 'q' || normalized === 'quit' || normalized === 'exit';
}

export function exitStartupSelection(): never {
  console.log(chalk.dim('  Exiting.'));
  process.exit(0);
}

export async function promptText(message: string, opts?: { secret?: boolean }): Promise<string> {
  return new Promise((resolve) => {
    const output = process.stdout;
    const rl = readline.createInterface({ input: process.stdin, output });
    const masked = rl as readline.Interface & { _writeToOutput?: (value: string) => void };
    const originalWrite = masked._writeToOutput?.bind(masked);
    if (opts?.secret) {
      masked._writeToOutput = function (value: string): void {
        if (value.startsWith(message)) {
          output.write(value);
          return;
        }
        if (value === '\r\n' || value === '\n') {
          output.write(value);
          return;
        }
        output.write('*');
      };
    }

    rl.question(message, (answer) => {
      masked._writeToOutput = originalWrite;
      rl.close();
      resolve(answer.trim());
    });
  });
}
