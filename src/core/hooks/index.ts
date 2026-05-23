import { spawn } from 'child_process';
import type { HookEntry, HooksConfig } from '../config/types.js';
import { resolveHooks, type HookEvent } from './discovery.js';
import { sanitizeEnv } from '../../security/env.js';
import type { EnvPolicy } from '../../security/env.js';
import { checkForbidden } from '../../security/bash-rules.js';
import { errorMessage } from '../../utils/errors.js';

// Cache of the scrubbed env keyed on the policy object identity. The caller
// passes in the policy (typically captured once at session start), so
// re-running sanitizeEnv on every fire is wasted work — and hook chains can
// fire dozens of times per turn (PreToolUse + PostToolUse on every Bash
// call, plus Pre/PostTurn).
let sanitizedEnvCache: { policy: EnvPolicy; env: NodeJS.ProcessEnv } | null = null;
function getSanitizedEnv(policy: EnvPolicy): NodeJS.ProcessEnv {
  if (sanitizedEnvCache && sanitizedEnvCache.policy === policy) {
    return sanitizedEnvCache.env;
  }
  const { env } = sanitizeEnv(process.env, policy);
  sanitizedEnvCache = { policy, env };
  return env;
}

/**
 * Result of running one or more hooks for a single event.
 *
 * - `cancel`: at least one hook returned `cancel: true`. For PreToolUse this
 *   denies the tool call. For other events it is informational.
 * - `errorMessage`: the most recent non-empty errorMessage seen across hooks
 *   (used as the user-facing reason when `cancel` is true).
 * - `additionalContext`: the most recent non-empty additionalContext string
 *   returned by any hook. Per-event semantics:
 *     - PreCompact:        replaces the compaction summary text.
 *     - SessionStart:      appended to the conversation as a user message
 *                          before the next model call.
 *     - UserPromptSubmit:  appended to the conversation right after the
 *                          user's prompt, before the model is called.
 *     - Other events:      ignored (no defined injection point yet).
 * - `notice`: the most recent non-empty notice string returned by any hook.
 *   Surfaced as a user-visible info message at the call site so a hook can
 *   say "Welcome back" or "policy v3 active" without abusing errorMessage.
 *   Plain-text stdout (not JSON) is also captured as a notice automatically.
 * - `firedCommands`: commands that ran end-to-end without spawn/timeout/
 *   parse error. Errored runs aren't included — they're already in `errors`.
 *   Used by call sites to emit one notice per successful fire.
 * - `errors`: per-hook execution errors (timeouts, malformed JSON, non-zero
 *   exits, spawn failures). Logged to the session log; never thrown.
 */
interface HookResult {
  cancel: boolean;
  errorMessage?: string;
  additionalContext?: string;
  notice?: string;
  firedCommands: string[];
  errors: string[];
}

interface RunHookOptions {
  /** Working directory used as cwd for the spawned hook. */
  cwd: string;
  /** Hook config to resolve entries from. Ignored when `entries` is supplied
   *  directly (test seam). */
  config?: HooksConfig;
  /** Pre-resolved entries (test seam). When provided, `config` and
   *  `matchValue` are ignored. */
  entries?: HookEntry[];
  /** Filter for matcher-bearing entries. Typically the tool name for
   *  Pre/PostToolUse. Events without a match value (SessionStart etc.)
   *  pass undefined; matcher-bearing entries are skipped in that case. */
  matchValue?: string;
  /** Default timeout per hook (ms). An entry's `timeoutMs` overrides.
   *  Defaults to 5000. */
  timeoutMs?: number;
  /** Env-allowlist policy applied to process.env before spawning. Threaded
   *  in by the caller so hooks behave the same regardless of where they
   *  run from (agent loop, headless, slash command). Omit for `{}` — the
   *  default deny-by-default behavior. */
  envPolicy?: EnvPolicy;
  /** Optional sink for stderr lines emitted by hook commands. */
  onStderr?: (command: string, chunk: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Run every hook configured for `event`, piping the JSON payload to stdin
 * and parsing the JSON object the hook prints to stdout. No-op if nothing
 * is configured. Spawn failures, non-zero exits, malformed JSON, and
 * timeouts are captured as `errors` rather than thrown — the agent must
 * never crash because a user wrote a flaky shell command.
 *
 * Multiple entries for the same event run sequentially in config order.
 * The aggregate merges `cancel` (any `true` wins) and keeps the last
 * non-empty `errorMessage` / `additionalContext` / `notice`, so a later
 * entry can override an earlier one.
 */
export async function runHook(
  event: HookEvent,
  payload: unknown,
  opts: RunHookOptions,
): Promise<HookResult> {
  const entries = opts.entries ?? resolveHooks(event, opts.config, opts.matchValue);
  const aggregate: HookResult = { cancel: false, firedCommands: [], errors: [] };
  if (entries.length === 0) return aggregate;

  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stdinJson = JSON.stringify({ event, payload });

  for (const entry of entries) {
    // Same hard-deny list the Bash tool enforces — applies regardless of who
    // wrote the hook. A hostile project's `.factory/config.json` shouldn't
    // get a free pass to `rm -rf /` or `curl | sh` just because a config
    // file said so. User rules from permissions.bashRules are NOT consulted
    // here: those are for model-issued commands, not user-owned hooks.
    const forbidden = checkForbidden(entry.command);
    if (forbidden) {
      aggregate.errors.push(
        `${entry.command}: blocked by built-in safety policy (${forbidden.reason})`,
      );
      continue;
    }
    const timeoutMs = entry.timeoutMs ?? defaultTimeoutMs;
    const single = await runSingleHook(event, entry.command, stdinJson, timeoutMs, opts);
    if (single.error) {
      aggregate.errors.push(`${entry.command}: ${single.error}`);
    } else {
      aggregate.firedCommands.push(entry.command);
    }
    if (single.parsed) {
      if (single.parsed.cancel) aggregate.cancel = true;
      if (typeof single.parsed.errorMessage === 'string' && single.parsed.errorMessage) {
        aggregate.errorMessage = single.parsed.errorMessage;
      }
      if (typeof single.parsed.additionalContext === 'string' && single.parsed.additionalContext) {
        aggregate.additionalContext = single.parsed.additionalContext;
      }
      if (typeof single.parsed.notice === 'string' && single.parsed.notice) {
        aggregate.notice = single.parsed.notice;
      }
    }
    if (single.stderr && opts.onStderr) opts.onStderr(entry.command, single.stderr);
  }

  return aggregate;
}

interface SingleHookOutcome {
  parsed?: {
    cancel?: boolean;
    errorMessage?: string;
    additionalContext?: string;
    notice?: string;
  };
  stderr?: string;
  error?: string;
}

function runSingleHook(
  event: HookEvent,
  command: string,
  stdinJson: string,
  timeoutMs: number,
  opts: RunHookOptions,
): Promise<SingleHookOutcome> {
  return new Promise(resolve => {
    let child;
    try {
      // Same env scrubbing the Bash tool uses (deny-by-default; see
      // src/security/env.ts). Hooks are typically project-owned config a
      // user may not have audited; passing the full process.env would let a
      // hostile `.factory/config.json` exfil ANTHROPIC_API_KEY / GH_TOKEN /
      // AWS_* on the very first session-start. Shallow-copy the cached env
      // so the per-call FACTORY_* injections don't leak across fires.
      const env = { ...getSanitizedEnv(opts.envPolicy ?? {}) };
      // Inject hook-context vars on top of the scrubbed allowlist so shell
      // scripts can read them without parsing the JSON payload. The
      // sanitizer denies the FACTORY_ prefix on the way IN (process.env
      // → child); we set them OUT-of-band, after sanitize, so the deny
      // doesn't apply.
      env.FACTORY_PROJECT_DIR = opts.cwd;
      env.FACTORY_EVENT = event;
      if (opts.matchValue !== undefined) {
        env.FACTORY_TOOL_NAME = opts.matchValue;
      }
      child = spawn('sh', ['-c', command], {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      resolve({ error: `spawn failed: ${errorMessage(err)}` });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      try {
        child.stdin?.destroy();
      } catch {
        /* ignore */
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      // Resolve immediately on timeout — don't wait for the child's `close`
      // event, which may be delayed by orphaned descendants (e.g. `sleep` in
      // the command outliving the parent `sh`).
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
      // Timeout path settles via the setTimeout handler above, so by the time
      // `close` fires here on a timed-out run, `settled` is already true and
      // we return early.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();

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
      if (parsed) {
        resolve({ parsed, stderr });
        return;
      }
      // Stdout looks like attempted JSON (starts with `{` or `[`) but failed
      // to parse → real error, surface it. Otherwise treat the raw stdout as
      // a plain-text `notice` so a hook can `echo "Welcome back"` without
      // having to construct JSON. Capped at 200 chars so a runaway hook
      // can't flood the UI.
      const looksLikeJson = stdout.startsWith('{') || stdout.startsWith('[');
      if (looksLikeJson) {
        resolve({ error: `malformed JSON on stdout`, stderr });
        return;
      }
      const NOTICE_CAP = 200;
      const notice = stdout.length > NOTICE_CAP ? stdout.slice(0, NOTICE_CAP) + '…' : stdout;
      resolve({ parsed: { notice }, stderr });
    });

    // Fast hooks (e.g. `touch <marker>`) can exit before we get here, so the
    // stdin pipe may already be closed. Both the sync .end() throw and the
    // async 'error' event need to be swallowed — without the listener, an
    // async EPIPE escalates to uncaughtException and exits the CLI with 1.
    child.stdin?.on('error', () => {});
    try {
      child.stdin?.end(stdinJson);
    } catch {
      /* ignore — see comment above */
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
