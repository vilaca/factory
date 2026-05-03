/**
 * Harness to spawn the factory CLI as a child process,
 * send input via stdin, and capture output from stdout/stderr.
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// From dist-test/test/ -> ../../dist/index.js (project root's dist)
const CLI_PATH = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

export interface CliHarness {
  process: ChildProcess;
  send(input: string): void;
  waitForOutput(match: string | RegExp, timeoutMs?: number): Promise<string>;
  waitForPrompt(timeoutMs?: number): Promise<string>;
  getOutput(): string;
  kill(): void;
}

export function spawnCli(args: string[], env?: Record<string, string>): CliHarness {
  let output = '';

  const proc = spawn('node', [CLI_PATH, ...args], {
    env: {
      ...process.env,
      GITHUB_COPILOT_API_KEY: '',
      COPILOT_API_KEY: '',
      ...env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });

  proc.stdout!.on('data', (data: Buffer) => {
    output += data.toString();
  });

  proc.stderr!.on('data', (data: Buffer) => {
    output += data.toString();
  });

  return {
    process: proc,

    send(input: string): void {
      proc.stdin!.write(input + '\n');
    },

    waitForOutput(match: string | RegExp, timeoutMs = 10000): Promise<string> {
      return new Promise((resolve, reject) => {
        const startLen = output.length;
        const start = Date.now();

        const check = (): void => {
          const current = output;
          const isMatch = typeof match === 'string'
            ? current.includes(match)
            : match.test(current);

          if (isMatch) {
            resolve(current);
            return;
          }

          if (Date.now() - start > timeoutMs) {
            reject(new Error(
              `Timed out waiting for ${match}.\nOutput so far (${current.length} chars):\n${current.slice(-2000)}`
            ));
            return;
          }

          setTimeout(check, 50);
        };

        check();
      });
    },

    waitForPrompt(timeoutMs = 10000): Promise<string> {
      // Wait for the green "> " prompt
      return this.waitForOutput('> ', timeoutMs);
    },

    getOutput(): string {
      return output;
    },

    kill(): void {
      proc.kill('SIGTERM');
    },
  };
}
