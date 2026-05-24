import { spawn } from 'child_process';
import type { HookEntry, HooksConfig } from '../config/types.js';
import { resolveHooks, type HookEvent } from './discovery.js';
import { sanitizeEnv, extendSanitizedEnv, type SanitizedEnv } from '../../security/env.js';
import type { EnvPolicy } from '../../security/env.js';
import { checkForbidden } from '../../security/bash-rules.js';
import { errorMessage } from '../../utils/errors.js';

// Cache of the scrubbed env keyed on the policy object identity. The caller
// passes in the policy (typically captured once at session start), so
// re-running sanitizeEnv on every fire is wasted work — and hook chains can
// fire dozens of times per turn (PreToolUse + PostToolUse on every Bash
// call, plus Pre/PostTurn).
let sanitizedEnvCache: { policy: EnvPolicy; env: SanitizedEnv } | null = null;
function getSanitizedEnv(policy: EnvPolicy): SanitizedEnv {
  if (sanitizedEnvCache && sanitizedEnvCache.policy === policy) {
    return sanitizedEnvCache.env;
  }
  const { env } = sanitizeEnv(process.env, policy);
  sanitizedEnvCache = { policy, env };
  return env;
}

/** Fields every event surfaces — bookkeeping the caller always wants to
 *  emit observability for. Per-event docs at the top of `HookResultMap`.
 *
 *  Not currently exported — consumers reach this type through
 *  `HookResultFor<E>` for the relevant event (e.g. observability-only
 *  events like `Stop` / `PostToolUse` resolve directly to this tier).
 *  Flip to `export` when a helper needs to operate on the lowest
 *  common denominator across events. */
interface HookResultBase {
  /** Plain-text notice captured from a hook's stdout when the hook
   *  didn't return structured JSON. Capped at ~200 chars so a runaway
   *  hook can't flood the UI. Surfaced as an info-level user notice at
   *  the call site. */
  notice?: string;
  /** Commands that ran end-to-end without spawn / timeout / parse
   *  error. Errored runs aren't included (they're in `errors`). Used by
   *  call sites to emit one observability event per successful fire. */
  firedCommands: string[];
  /** Per-hook execution errors (timeouts, malformed JSON, non-zero
   *  exits, spawn failures, forbidden-pattern denials). Logged to the
   *  session log and surfaced as `hook-error` agent events; never
   *  thrown. */
  errors: string[];
}

/** Result shape for events that may inject context back into the
 *  conversation / next model call. `additionalContext` is the most
 *  recent non-empty string returned across all hooks for the event
 *  (later entries override earlier ones).
 *
 *  Per-event injection semantics — see `HookResultMap` for the
 *  canonical mapping:
 *  - `SessionStart`     → appended to conversation as a user message.
 *  - `UserPromptSubmit` → appended right after the user prompt.
 *  - `PreCompact`       → replaces the compaction summary text.
 *
 *  Not currently exported — consumers reach this type through
 *  `HookResultFor<E>` for the relevant event. Flip to `export` if you
 *  need to write a helper whose parameter is the tier itself rather
 *  than a specific event's result. */
interface HookResultWithContext extends HookResultBase {
  additionalContext?: string;
}

/** Result shape for events that may veto an action. Today this is
 *  exclusively `PreToolUse`. `cancel: true` from any entry wins; the
 *  most recent non-empty `errorMessage` is what the caller surfaces to
 *  the user as the denial reason.
 *
 *  Not currently exported — see note on `HookResultWithContext`. */
interface HookResultWithVeto extends HookResultBase {
  cancel: boolean;
  errorMessage?: string;
}

/** Per-event result surface — the **single source of truth** for what
 *  fields a given event's caller may consume. `runHook<E>` returns
 *  `HookResultMap[E]`, so a `Stop` caller writing `result.cancel` is a
 *  compile error rather than a silent no-op.
 *
 *  When adding a new entry to `HOOK_EVENTS`, the exhaustiveness check
 *  below (`_HookResultMapBijection`) will fail to compile until a
 *  matching row is added here. Removing an event without removing its
 *  row also fails. Pick the tier deliberately:
 *  - inert / observability-only         → `HookResultBase`
 *  - may inject context into a turn     → `HookResultWithContext`
 *  - may veto an action                 → `HookResultWithVeto`
 *
 *  An event that one day needs BOTH inject + veto semantics should be
 *  modelled as a new combined interface `HookResultWithContextAndVeto
 *  extends HookResultWithContext, HookResultWithVeto` rather than
 *  loosening any of the existing tiers.
 *
 *  Not exported — the map is an implementation detail behind
 *  `HookResultFor<E>`, which is what callers should reach for. */
interface HookResultMap {
  SessionStart: HookResultWithContext;
  UserPromptSubmit: HookResultWithContext;
  PreToolUse: HookResultWithVeto;
  PostToolUse: HookResultBase;
  PostToolUseFailure: HookResultBase;
  PreCompact: HookResultWithContext;
  SessionEnd: HookResultBase;
  Stop: HookResultBase;
  StopFailure: HookResultBase;
}

/** Bidirectional compile-time bijection between `HookEvent` and the
 *  keys of `HookResultMap`. If a new event is added to `HOOK_EVENTS`
 *  without a matching `HookResultMap` row (or vice versa), the
 *  assignment of `true` below fails with a string-literal error message
 *  pointing at the missing or stale side.
 *
 *  The tuple pair-extends trick checks both directions in one
 *  expression:
 *   - `HookEvent extends keyof HookResultMap`  (forward)
 *   - `keyof HookResultMap extends HookEvent`  (backward)
 *  Both must hold for the result to be `true`; otherwise it's the
 *  diagnostic string, which `true` cannot be assigned to. */
type _HookResultMapBijection = [HookEvent, keyof HookResultMap] extends [
  keyof HookResultMap,
  HookEvent,
]
  ? true
  : 'HookResultMap and HOOK_EVENTS are out of sync — add or remove a HookResultMap entry to match HOOK_EVENTS';
const _hookResultMapBijection: _HookResultMapBijection = true;
void _hookResultMapBijection;

/** Public lookup: `HookResultFor<'PreToolUse'>` → `HookResultWithVeto`,
 *  `HookResultFor<'SessionStart'>` → `HookResultWithContext`, etc. */
export type HookResultFor<E extends HookEvent> = HookResultMap[E];

/** Internal aggregate type — the runtime body collects every field a
 *  hook might return (cancel, errorMessage, additionalContext, notice)
 *  regardless of which event fired. The public `runHook<E>` return
 *  narrows this to `HookResultFor<E>` via a structural-subset cast,
 *  giving callers only the fields whose semantics are defined for
 *  their event.
 *
 *  Aggregation stays full-fidelity at runtime so a future per-event
 *  shape change is purely additive (extend `HookResultMap`, not the
 *  parser). */
interface HookAggregateResult extends HookResultBase {
  cancel: boolean;
  errorMessage?: string;
  additionalContext?: string;
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
export async function runHook<E extends HookEvent>(
  event: E,
  payload: unknown,
  opts: RunHookOptions,
): Promise<HookResultFor<E>> {
  const entries = opts.entries ?? resolveHooks(event, opts.config, opts.matchValue);
  const aggregate: HookAggregateResult = { cancel: false, firedCommands: [], errors: [] };
  // Early return: no entries means no fields aggregated; the cast is
  // safe because `HookResultFor<E>` for every event is a structural
  // subset of `HookAggregateResult` (every event's surface fields
  // exist on the aggregate; the aggregate adds fields that some events
  // don't surface, which the cast drops at the type level).
  if (entries.length === 0) return aggregate as HookResultFor<E>;

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

  return aggregate as HookResultFor<E>;
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
      // AWS_* on the very first session-start.
      //
      // Inject hook-context vars via `extendSanitizedEnv` so the brand
      // survives the addition. Plain spread (`{ ...sanitized, FACTORY_X }`)
      // would type-erase to `ProcessEnv` and let a future agent mix
      // `process.env` keys back in without a type error. The sanitizer
      // denies the FACTORY_ prefix on the way IN (process.env → child); we
      // add them OUT-of-band, after sanitize, so the deny doesn't apply.
      const env = extendSanitizedEnv(getSanitizedEnv(opts.envPolicy ?? {}), {
        FACTORY_PROJECT_DIR: opts.cwd,
        FACTORY_EVENT: event,
        ...(opts.matchValue !== undefined ? { FACTORY_TOOL_NAME: opts.matchValue } : {}),
      });
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
