/**
 * Harness to spawn the factory CLI in a real PTY so Ink-rendered pickers
 * (which require `setRawMode` on stdin) work the same way they do in a
 * user's terminal. Output is buffered with ANSI sequences stripped so
 * tests can assert on plain text.
 */

import { spawn } from 'child_process';
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
  /** Send a Ctrl+<letter> chord. Letter is case-insensitive. */
  sendCtrl(letter: string): void;
  /** Send an arrow key. */
  sendArrow(dir: 'up' | 'down' | 'left' | 'right'): void;
  /** Send a function key F1..F12. */
  sendF(n: number): void;
  /** Send the Esc key. */
  sendEsc(): void;
  waitForOutput(match: string | RegExp, timeoutMs?: number): Promise<string>;
  waitForPrompt(timeoutMs?: number): Promise<string>;
  getOutput(): string;
  kill(): void;
}

export function spawnCli(
  args: string[],
  env?: Record<string, string>,
  opts?: { cwd?: string },
): CliHarness {
  let output = '';

  // Isolate HOME and XDG_CONFIG_HOME so the user's real ~/.factory and
  // ~/.config/factory don't leak in (saved providers/sessions would skip
  // the picker; saved tokens would skip auth prompts). Tests can override
  // either by passing the env field explicitly.
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-e2e-home-'));

  const proc = pty.spawn('node', [CLI_PATH, ...args], {
    name: 'xterm-256color',
    // Big screen so Ink's <Static> region never scrolls notice blocks /
    // panels off the visible viewport before they're emitted. Test
    // assertions hit the cumulative output buffer, but Ink itself
    // suppresses rendering of content that wouldn't fit on screen — so we
    // need the viewport to fit everything for slash help / plan panels /
    // picker stages to actually be written to the stream.
    cols: 200,
    rows: 200,
    cwd: opts?.cwd ?? process.cwd(),
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

    sendCtrl(letter: string): void {
      const code = letter.toUpperCase().charCodeAt(0) - 64;
      if (code < 1 || code > 26) {
        throw new Error(`sendCtrl: '${letter}' is not a Ctrl-able letter`);
      }
      proc.write(String.fromCharCode(code));
    },

    sendArrow(dir: 'up' | 'down' | 'left' | 'right'): void {
      const map = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' } as const;
      proc.write(map[dir]);
    },

    sendF(n: number): void {
      // xterm sequences. F1..F4 use SS3, F5..F12 use CSI ~ with numeric IDs.
      const ss3 = ['P', 'Q', 'R', 'S'];
      const csi: Record<number, string> = {
        5: '15',
        6: '17',
        7: '18',
        8: '19',
        9: '20',
        10: '21',
        11: '23',
        12: '24',
      };
      if (n >= 1 && n <= 4) {
        proc.write('\x1bO' + ss3[n - 1]);
      } else if (n >= 5 && n <= 12) {
        proc.write(`\x1b[${csi[n]}~`);
      } else {
        throw new Error(`sendF: F${n} out of range`);
      }
    },

    sendEsc(): void {
      proc.write('\x1b');
    },

    waitForOutput(match: string | RegExp, timeoutMs = 10000): Promise<string> {
      return new Promise((resolve, reject) => {
        const start = Date.now();

        const check = (): void => {
          const current = output;
          const isMatch = typeof match === 'string' ? current.includes(match) : match.test(current);

          if (isMatch) {
            resolve(current);
            return;
          }

          if (Date.now() - start > timeoutMs) {
            reject(
              new Error(
                `Timed out waiting for ${match}.\nOutput so far (${current.length} chars):\n${current.slice(-2000)}`,
              ),
            );
            return;
          }

          setTimeout(check, 50);
        };

        check();
      });
    },

    waitForPrompt(timeoutMs = 10000): Promise<string> {
      // The TUI's bottom prompt renders the project label + `]>` (e.g.
      // `[main]>`). The status bar appears just after the prompt is ready
      // for input, so either marker is a safe ready signal. `> ` alone is
      // unreliable — Ink may render the `>` and the trailing space in
      // separate frames after the ANSI strip.
      return this.waitForOutput(/\]>|· (main|HEAD)/, timeoutMs);
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

export interface HeadlessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface HeadlessOptions {
  env?: Record<string, string>;
  stdin?: string;
  /** Hard kill the child after this many ms; resolves with the partial buffers
   *  and signal set to SIGKILL. Use for tests that expect the CLI to *not*
   *  exit on its own (e.g. waiting for SIGINT delivery). */
  timeoutMs?: number;
  cwd?: string;
  /** When set, a SIGINT is delivered after this delay; the CLI's own shutdown
   *  is then awaited for up to timeoutMs (or 5s if unset). Used to assert
   *  exitCode 130 behavior without races. */
  sigintAfterMs?: number;
  /** Re-use a specific HOME directory (e.g. one a previous spawn populated).
   *  When omitted a fresh tmp HOME is created, matching spawnCli's isolation. */
  home?: string;
}

/**
 * Headless (non-PTY) spawn of the factory CLI. Pipes stdin/stdout/stderr so
 * exit codes and stream separation are observable, the way a CI / `echo |
 * factory` invocation sees them. Mirrors spawnCli's HOME / XDG isolation so
 * the user's real ~/.factory never leaks in.
 */
export function spawnCliHeadless(
  args: string[],
  opts: HeadlessOptions = {},
): Promise<HeadlessResult> {
  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'factory-headless-'));
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_PATH, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        GITHUB_COPILOT_API_KEY: '',
        COPILOT_API_KEY: '',
        ...opts.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        TERM: 'dumb',
      } as Record<string, string>,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();

    let killTimer: NodeJS.Timeout | undefined;
    let sigintTimer: NodeJS.Timeout | undefined;
    if (opts.sigintAfterMs !== undefined) {
      sigintTimer = setTimeout(() => {
        child.kill('SIGINT');
      }, opts.sigintAfterMs);
    }
    if (opts.timeoutMs !== undefined) {
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, opts.timeoutMs);
    }

    child.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (sigintTimer) clearTimeout(sigintTimer);
      resolve({
        stdout,
        stderr,
        // signal-killed children report code === null; surface 128+signum so
        // tests can assert `result.exitCode === 130` for SIGINT directly.
        exitCode: code ?? (signal ? 128 + signalNumber(signal) : -1),
        signal,
        durationMs: Date.now() - start,
      });
    });
  });
}

function signalNumber(sig: NodeJS.Signals): number {
  // Minimal map — only the signals tests actually assert on.
  const m: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 };
  return m[sig] ?? 0;
}
