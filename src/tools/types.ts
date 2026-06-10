import type { PathPolicy } from '../security/paths.js';
import type { EnvPolicy } from '../security/env.js';
import type { ToolDefinition, ToolPrerequisite } from '../utils/tool-definition.js';
import { TOOL_NAMES } from '../utils/tool-names.js';

// Canonical tool-author surface. Everything a new built-in tool needs
// to implement or reference is exported from this single module, even
// when the underlying definitions live elsewhere:
//
//   - `ToolDefinition` / `ToolPrerequisite` physically live in
//     `src/utils/tool-definition.ts` because `providers/` also imports
//     `ToolDefinition` and the arch test forbids providers → tools.
//   - `TOOL_NAMES` physically lives in `src/utils/tool-names.ts`
//     because `security/permissions.ts` also imports it and the arch
//     test forbids security → tools.
//
// Both indirections are wire-format-driven (the contract crosses the
// tools/providers and tools/security boundaries). They are re-exported
// here so a tool author or a tool-call site only ever needs to read
// `src/tools/types.js` to see the full surface.
export type { ToolDefinition, ToolPrerequisite };
export { TOOL_NAMES };

export type ToolCategory = 'read-only' | 'write' | 'execute';

/**
 * Tool execution result. The shape is a discriminated union so the
 * "valid flag combinations" matrix is enforced by the type checker
 * rather than by JSDoc. Lifted from the prose-only contract that
 * previously lived here (see git blame for the pre-lift matrix).
 *
 * Variants:
 *
 *   1. `ToolSuccess` — `success: true`. May carry `empty`, `important`,
 *      `displayOutput`. May carry `cwdAfter` ONLY when produced by a
 *      `BashToolHandler` (see Pattern 2 / `BashToolResult`). Failure-only
 *      flags (`softError`/`hardError`/`skipCorrector`) are forbidden:
 *      typed as `?: never`, so writing them is a compile error.
 *   2. `ToolFailureGraceful` — `success: false`, no error tag. The tool
 *      decided to fail without throwing (Read on missing file, Edit on
 *      non-matching string, Bash with non-zero exit). May carry
 *      `skipCorrector` to bypass the LLM corrector when the body already
 *      contains the actionable hint.
 *   3. `ToolFailureSoft` — `success: false` + `softError: true` +
 *      `skipCorrector: true`. Constructed by the executor when the
 *      callable throws `ToolResolutionError`. The pair is required (the
 *      type enforces `softError` ⇒ `skipCorrector`).
 *   4. `ToolFailureHard` — `success: false` + `hardError: true`.
 *      Constructed by the executor when the callable throws any other
 *      exception. Mutually exclusive with `softError` (the type lists
 *      both variants separately, so neither can satisfy the other's
 *      shape).
 *
 * Tool authors should never construct `ToolFailureSoft` or
 * `ToolFailureHard` directly — those tags are reserved for the executor
 * catch block in `src/core/agent/tool-calls/run-tool-calls-execute.ts`.
 * Tool authors return `ToolSuccess` (without `cwdAfter`) or
 * `ToolFailureGraceful`.
 */
interface ToolResultBase {
  output: string;
  /** Optional shortened version for terminal display. The full `output` always goes to the model. */
  displayOutput?: string;
}

/**
 * Success shape for standard (non-Bash) tools. `cwdAfter` is forbidden
 * via `?: never` — only `BashToolResult` permits it.
 *
 * Internal to this module: external code should use `ToolResult` /
 * `BashToolResult` / `ExecutedToolResult` rather than naming this
 * variant directly.
 */
interface ToolSuccess extends ToolResultBase {
  success: true;
  /** True when the call ran cleanly but produced no useful result (e.g.
   * Grep with zero matches). The renderer surfaces these distinctly so
   * they don't look identical to a successful "found something" call. */
  empty?: boolean;
  /** Set when success=true but the body still needs to reach the user —
   * the `experimental.toolPreview` gate treats this as not-noise so the
   * body is rendered. Bash sets it for non-zero exit codes: the tool ran
   * cleanly (so success stays true and auto-retry doesn't fire on every
   * failing test) but the user needs to see the exit code and output. */
  important?: boolean;
  /** A user message to be added to the conversation AFTER the tool_result
   * is committed. Used by invoke_skill to inject the skill system message
   * without breaking the tool_use → tool_result adjacency requirement of
   * the Anthropic/Copilot API. The executor applies this after recordResult
   * so the sequence is always: tool_use → tool_result → user(injection). */
  pendingUserMessage?: string;
  cwdAfter?: never;
  softError?: never;
  hardError?: never;
  skipCorrector?: never;
}

/**
 * Bash-specific success shape: `cwdAfter` is permitted because Bash is
 * the only tool that can change the working directory. The agent loop
 * narrows on `tool.kind === 'bash'` (see `BashToolHandler`) to access
 * it; standard tools cannot construct this shape. Internal — use
 * `BashToolResult` externally.
 */
interface BashSuccess extends ToolResultBase {
  success: true;
  empty?: boolean;
  important?: boolean;
  /** Set by Bash when the command changed the working directory. The
   * agent loop reads this and updates the session's `refs.cwd` so the
   * new directory persists across subsequent tool calls. */
  cwdAfter?: string;
  /** Inherited from ToolSuccess — see that interface for the contract.
   * Present here so the executor's pendingUserMessage check compiles
   * against the unified ExecutedToolResult type. */
  pendingUserMessage?: string;
  softError?: never;
  hardError?: never;
  skipCorrector?: never;
}

/**
 * Graceful failure: the tool returned `{ success: false }` rather than
 * throwing. Used by all tools' input-validation paths. May carry
 * `skipCorrector` when the body itself is the actionable hint (Edit's
 * "old_string found N times" message, for example). Internal — use
 * `ToolResult` externally.
 */
interface ToolFailureGraceful extends ToolResultBase {
  success: false;
  /** Set on a `success=false` result when the error is a *reasoning hint*
   * for the model rather than a malformed-call problem the corrector can
   * fix. The agent loop checks this flag and skips the corrector when
   * true. */
  skipCorrector?: boolean;
  softError?: never;
  hardError?: never;
  empty?: never;
  important?: never;
  cwdAfter?: never;
}

/**
 * Executor-constructed shape for `ToolResolutionError`. The
 * reliability-stack analogue of an HTTP 404: valid request, no matching
 * data. `skipCorrector: true` is mandatory (the model already has the
 * resolution message; the LLM corrector would just burn a call) — the
 * type enforces the pairing. Tool authors must NOT construct this
 * directly; throw `ToolResolutionError` and let
 * `run-tool-calls-execute.ts` wrap. Internal — use `ToolResult` externally.
 */
interface ToolFailureSoft extends ToolResultBase {
  success: false;
  softError: true;
  skipCorrector: true;
  hardError?: never;
  empty?: never;
  important?: never;
  cwdAfter?: never;
}

/**
 * Executor-constructed shape for unexpected exceptions
 * (non-`ToolResolutionError`). Distinguishes "the tool threw" from "the
 * tool returned `{ success: false }` gracefully." Only this variant
 * bumps the consecutive-hard-error counter
 * (docs/reliability/next-steps.md §9, "5xx-equivalent"). Tool authors
 * must NOT construct this directly; throw and let the executor wrap.
 * Internal — use `ToolResult` externally.
 */
interface ToolFailureHard extends ToolResultBase {
  success: false;
  hardError: true;
  skipCorrector?: boolean;
  softError?: never;
  empty?: never;
  important?: never;
  cwdAfter?: never;
}

type ToolFailure = ToolFailureGraceful | ToolFailureSoft | ToolFailureHard;

/** Standard tools' result type. Forbids `cwdAfter` on the success branch. */
export type ToolResult = ToolSuccess | ToolFailure;

/** Bash-only result type. Permits `cwdAfter` on the success branch. */
export type BashToolResult = BashSuccess | ToolFailure;

/**
 * Consumer-side type — what the agent loop / event handlers / session
 * log actually see when they receive a `tool-call-result`. Either
 * shape is possible; downstream code that wants to read `cwdAfter`
 * must narrow on `tool.kind === 'bash'` first (see Pattern 2 / the
 * Bash narrowing in `run-tool-calls-execute.ts`).
 *
 * Tool authors should NOT use this — they declare a handler with the
 * narrow `StandardToolHandler` (or `BashToolHandler`) shape, whose
 * `execute` returns one of the two narrower types.
 */
export type ExecutedToolResult = ToolResult | BashToolResult;

/** Per-call context that an agent loop passes when executing a tool.
 *
 * Optional so that headless / test callers can keep using the bare
 * `execute(args)` form. When omitted, tools fall back to process-global
 * defaults (e.g. `process.cwd()` and an empty path/env policy).
 */
export interface ToolContext {
  /** Working directory the tool should resolve relative paths against and
   * spawn shells with. Per-tab in the Ink UI; defaults to process.cwd()
   * elsewhere. */
  cwd: string;
  /** Path-policy deny extensions for this tool call. Read-only; tools must
   * not mutate. The agent loop builds this once per turn from config and
   * passes the same object to every tool. When undefined, tools treat as
   * `{}` (built-in deny list still applies). */
  pathPolicy?: PathPolicy;
  /** Env-policy allow extensions used by Bash to scrub the spawned shell's
   * environment. Same plumbing rules as pathPolicy. */
  envPolicy?: EnvPolicy;
  /** Per-turn abort signal. When fired, tools should cancel in-flight I/O
   * (`fs.readFile({signal})`, `fetch({signal})`, `child_process.spawn`'s
   * AbortController) so an aborted turn doesn't wait out a multi-MB read.
   * Optional — older callers and tests can omit it. */
  signal?: AbortSignal;
  /** WebFetch: probe for the per-session domain allowlist. Lets the tool
   * re-apply the same gate the permission prompt used when validating a
   * redirect target. Hostnames are compared case-insensitively (callers
   * lowercase before passing). */
  isHostnameAllowed?: (hostname: string) => boolean;
}

/**
 * Standard tool handler. `execute` returns `ToolResult`, whose success
 * branch forbids `cwdAfter`. Default `kind` is `'standard'` (omittable).
 */
export interface StandardToolHandler {
  kind?: 'standard';
  name: string;
  description: string;
  category: ToolCategory;
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult>;
}

/**
 * Bash-only handler. The `kind: 'bash'` discriminator narrows callers'
 * reads of `cwdAfter` (see `run-tool-calls-execute.ts`); the broader
 * `BashToolResult` return type permits Bash to set it. No other tool
 * can satisfy this shape, so no other tool can return `cwdAfter`.
 */
export interface BashToolHandler {
  kind: 'bash';
  name: string;
  description: string;
  category: ToolCategory;
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<BashToolResult>;
}

/**
 * Tool-author surface. New tools should declare their value with the
 * narrower `StandardToolHandler` (or `BashToolHandler` for Bash) — that
 * is what makes the `cwdAfter`-forbidden guarantee bite. Annotating as
 * the union `ToolHandler` widens the shape and accepts either branch,
 * which defeats the check.
 */
export type ToolHandler = StandardToolHandler | BashToolHandler;
