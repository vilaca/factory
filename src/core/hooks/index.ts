import { spawn } from 'child_process';
import { discoverHookScripts, discoverAllHooks, type HookEvent } from './discovery.js';

export type { HookEvent };
export { discoverAllHooks };

/**
 * Result of running one or more hook scripts for a single event.
 *
 * - `cancel`: at least one hook returned `cancel: true`. For PreToolUse this
 *   denies the tool call. For other events it is informational.
 * - `errorMessage`: the most recent non-empty errorMessage seen across hooks
 *   (used as the user-facing reason when `cancel` is true).
 * - `contextModification`: the most recent non-empty contextModification
 *   string returned by any hook. Only PreCompact acts on this.
 * - `notice`: the most recent non-empty notice string returned by any hook.
 *   Surfaced as a user-visible info message at the call site so a hook can
 *   say "Welcome back" or "policy v3 active" without abusing errorMessage.
 * - `firedScripts`: scripts that actually ran end-to-end (spawned, parsed,
 *   no timeout). Errored scripts are not included — they're already
 *   represented in `errors`. Used by call sites to emit one notice per
 *   successful fire so the user knows hooks executed.
 * - `errors`: per-hook execution errors (timeouts, malformed JSON, non-zero
 *   exits, spawn failures). Logged to the session log; never thrown.
 */
export interface HookResult {
  cancel: boolean;
  errorMessage?: string;
  contextModification?: string;
  notice?: string;
  firedScripts: string[];
  errors: string[];
}

export interface RunHookOptions {
  /** Working directory used both as cwd for the spawned hook and to find
   *  project-local hooks under `<cwd>/.factory/hooks/`. */
  cwd: string;
  /** Hard timeout per hook script. Defaults to 5000 ms. */
  timeoutMs?: number;
  /** Optional sink for stderr lines emitted by hook scripts. */
  onStderr?: (hookPath: string, chunk: string) => void;
  /** Override hook discovery (test seam). When provided, `cwd`-based
   *  discovery is skipped and these scripts are used verbatim. */
  scripts?: string[];
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Run every hook registered for `event`, piping the JSON payload to stdin
 * and parsing the JSON object the hook prints to stdout. Hooks that don't
 * exist are a silent no-op. Spawn failures, non-zero exits, malformed
 * stdout, and timeouts are captured as `errors` rather than thrown — the
 * agent must never crash because a user wrote a flaky shell script.
 *
 * Multiple hooks for the same event are run sequentially in discovery
 * order (global before project). The aggregate result merges `cancel` (any
 * `true` wins) and keeps the last non-empty `errorMessage` /
 * `contextModification`, so the project-local hook can override the
 * global one if both fire.
 */
export async function runHook(
  event: HookEvent,
  payload: unknown,
  opts: RunHookOptions,
): Promise<HookResult> {
  const scripts = opts.scripts ?? discoverHookScripts(event, opts.cwd);
  const aggregate: HookResult = { cancel: false, firedScripts: [], errors: [] };
  if (scripts.length === 0) return aggregate;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stdinJson = JSON.stringify({ event, payload });

  for (const script of scripts) {
    const single = await runSingleHook(script, stdinJson, timeoutMs, opts);
    if (single.error) {
      aggregate.errors.push(`${script}: ${single.error}`);
    } else {
      aggregate.firedScripts.push(script);
    }
    if (single.parsed) {
      if (single.parsed.cancel) aggregate.cancel = true;
      if (typeof single.parsed.errorMessage === 'string' && single.parsed.errorMessage) {
        aggregate.errorMessage = single.parsed.errorMessage;
      }
      if (typeof single.parsed.contextModification === 'string' && single.parsed.contextModification) {
        aggregate.contextModification = single.parsed.contextModification;
      }
      if (typeof single.parsed.notice === 'string' && single.parsed.notice) {
        aggregate.notice = single.parsed.notice;
      }
    }
    if (single.stderr && opts.onStderr) opts.onStderr(script, single.stderr);
  }

  return aggregate;
}

interface SingleHookOutcome {
  parsed?: {
    cancel?: boolean;
    errorMessage?: string;
    contextModification?: string;
    notice?: string;
  };
  stderr?: string;
  error?: string;
}

function runSingleHook(
  script: string,
  stdinJson: string,
  timeoutMs: number,
  opts: RunHookOptions,
): Promise<SingleHookOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('sh', [script], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err: any) {
      resolve({ error: `spawn failed: ${err?.message ?? String(err)}` });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.stdin?.destroy(); } catch { /* ignore */ }
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      // Resolve immediately on timeout — don't wait for the child's `close`
      // event, which may be delayed by orphaned descendants (e.g. `sleep` in
      // the script outliving the parent `sh`).
      if (!settled) {
        settled = true;
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        resolve({ error: `timed out after ${timeoutMs}ms`, stderr });
      }
    }, timeoutMs);

    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error: `process error: ${err.message}` });
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();

      if (timedOut) {
        resolve({ error: `timed out after ${timeoutMs}ms`, stderr });
        return;
      }
      if (code !== 0 && code !== null) {
        // Non-zero exit: still try to parse stdout (a hook might exit 1 to
        // signal cancel). If stdout is empty/garbage, surface the exit code.
        const parsed = tryParseHookStdout(stdout);
        if (parsed) {
          resolve({ parsed, stderr });
          return;
        }
        resolve({ error: `exited with code ${code}`, stderr });
        return;
      }
      if (!stdout) {
        resolve({ stderr });
        return;
      }
      const parsed = tryParseHookStdout(stdout);
      if (!parsed) {
        resolve({ error: `malformed JSON on stdout`, stderr });
        return;
      }
      resolve({ parsed, stderr });
    });

    try {
      child.stdin?.end(stdinJson);
    } catch {
      // stdin may already be closed if the hook exited fast; ignore.
    }
  });
}

function tryParseHookStdout(stdout: string): SingleHookOutcome['parsed'] | null {
  if (!stdout) return null;
  try {
    const obj = JSON.parse(stdout);
    if (obj && typeof obj === 'object') {
      return obj as SingleHookOutcome['parsed'];
    }
    return null;
  } catch {
    return null;
  }
}
