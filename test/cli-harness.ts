/**
 * Harness to spawn the factory CLI in a real PTY so Ink-rendered pickers
 * (which require `setRawMode` on stdin) work the same way they do in a
 * user's terminal. Output is buffered with ANSI sequences stripped so
 * tests can assert on plain text.
 */

import * as pty from '@lydell/node-pty';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// From dist-test/test/ -> ../../dist/index.js (project root's dist)
const CLI_PATH = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

// Strip ANSI escape sequences. Ink+chalk wrap output in colour and
// cursor-movement codes that would otherwise break substring matches.
const ANSI = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export interface CliHarness {
  process: pty.IPty;
  /** Write raw input — no newline appended. Use for Ink picker shortcuts
   * ('1', 'B', etc.) and arrow keys. */
  send(input: string): void;
  /** Write input followed by Enter. Use for readline prompts (token input). */
  sendLine(input: string): void;
  /** Send the Enter key alone. */
  sendEnter(): void;
  waitForOutput(match: string | RegExp, timeoutMs?: number): Promise<string>;
  waitForPrompt(timeoutMs?: number): Promise<string>;
  getOutput(): string;
  kill(): void;
}

export function spawnCli(args: string[], env?: Record<string, string>): CliHarness {
  let output = '';

  // Isolate HOME and XDG_CONFIG_HOME so the user's real ~/.factory and
  // ~/.config/factory don't leak in (saved providers/sessions would skip
  // the picker; saved tokens would skip auth prompts). Tests can override
  // either by passing the env field explicitly.
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-home-'));

  const proc = pty.spawn('node', [CLI_PATH, ...args], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
      GITHUB_COPILOT_API_KEY: '',
      COPILOT_API_KEY: '',
      ...env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      TERM: 'xterm-256color',
    } as Record<string, string>,
  });

  // /tmp is OS-cleaned; skipping rmSync avoids racing test code that may
  // read files inside the override dirs after cli.kill() returns.

  proc.onData(data => {
    output += data.replace(ANSI, '');
  });

  return {
    process: proc,

    send(input: string): void {
      proc.write(input);
    },

    sendLine(input: string): void {
      // PTYs are line-disciplined; '\r' is the canonical Enter key.
      proc.write(input + '\r');
    },

    sendEnter(): void {
      proc.write('\r');
    },

    waitForOutput(match: string | RegExp, timeoutMs = 10000): Promise<string> {
      return new Promise((resolve, reject) => {
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
      return this.waitForOutput('> ', timeoutMs);
    },

    getOutput(): string {
      return output;
    },

    kill(): void {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Already exited.
      }
    },
  };
}
