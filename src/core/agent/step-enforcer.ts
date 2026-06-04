import type { ToolCallMessage } from '../../providers/types.js';
import type { ToolDefinition, ToolPrerequisite } from '../../tools/types.js';
import { normalizeToolArguments } from '../../utils/tool-call-args.js';
import { StepTracker } from './step-tracker.js';
import { stepNudge, prerequisiteNudge, type Nudge } from './nudges.js';
import { StepEnforcementError, PrerequisiteError } from './errors.js';

const DEFAULT_MAX_PREMATURE_ATTEMPTS = 3;
const DEFAULT_MAX_PREREQ_VIOLATIONS = 2;

export interface StepEnforcerOptions {
  /** Names of tools that must be called successfully before any
   *  terminal tool is allowed. Empty array → no premature-terminal
   *  enforcement. */
  requiredSteps: readonly string[];
  /** Names of terminal tools (e.g. Respond, or a user-provided
   *  `answer`). When the model calls one of these and requiredSteps
   *  haven't completed, the enforcer emits a step nudge. */
  terminalTools: readonly string[];
  /** Map of tool name → prerequisites array (from ToolDefinition.prerequisites). */
  prereqs: ReadonlyMap<string, readonly ToolPrerequisite[]>;
  maxPrematureAttempts?: number;
  maxPrereqViolations?: number;
}

export interface StepCheck {
  nudge?: Nudge;
  needsNudge: boolean;
}

/**
 * Step enforcer (docs/reliability/next-steps.md §7). Stateful — lives for one agent run.
 *
 * Two checks both consume a batch of tool calls and return either a
 * nudge or "go ahead":
 *
 *   - `check(toolCalls)` flags premature terminal attempts. If any
 *     call in the batch is a terminal tool and not every required
 *     step has been recorded, emit a step nudge whose tier escalates
 *     with the attempt count.
 *
 *   - `checkPrerequisites(toolCalls)` flags calls whose tool declared
 *     prerequisites that haven't been met yet. Whole-batch blocking —
 *     a single violator nudges the whole batch (docs/reliability/next-steps.md §7).
 *
 * Both consult the same `StepTracker` so they agree on what has run.
 * Counter resets are handled by `recordCleanBatch()` and `record()`,
 * which the agent loop calls after a successful tool execution.
 */
export class StepEnforcer {
  private readonly tracker: StepTracker;
  private readonly terminalSet: ReadonlySet<string>;
  private readonly prereqs: ReadonlyMap<string, readonly ToolPrerequisite[]>;
  private readonly maxPrematureAttempts: number;
  private readonly maxPrereqViolations: number;
  private prematureAttempts = 0;
  private prereqViolations = 0;

  constructor(opts: StepEnforcerOptions) {
    this.tracker = new StepTracker(opts.requiredSteps);
    this.terminalSet = new Set(opts.terminalTools);
    this.prereqs = opts.prereqs;
    this.maxPrematureAttempts = opts.maxPrematureAttempts ?? DEFAULT_MAX_PREMATURE_ATTEMPTS;
    this.maxPrereqViolations = opts.maxPrereqViolations ?? DEFAULT_MAX_PREREQ_VIOLATIONS;
  }

  /** Premature-terminal check. Returns a nudge if the batch attempts a
   *  terminal tool with required steps unsatisfied. Increments the
   *  internal counter; if the counter exceeds maxPrematureAttempts,
   *  throws StepEnforcementError instead. */
  check(toolCalls: ToolCallMessage[]): StepCheck {
    const attemptedTerminal = toolCalls.find(tc => {
      const n = tc.function?.name;
      return typeof n === 'string' && this.terminalSet.has(n);
    });
    if (!attemptedTerminal) return { needsNudge: false };
    if (this.tracker.isSatisfied()) return { needsNudge: false };

    this.prematureAttempts++;
    if (this.prematureAttempts > this.maxPrematureAttempts) {
      throw new StepEnforcementError(attemptedTerminal.function!.name, this.tracker.pending());
    }
    const tier = Math.min(this.prematureAttempts, 3) as 1 | 2 | 3;
    return {
      needsNudge: true,
      nudge: stepNudge(attemptedTerminal.function!.name, this.tracker.pending(), tier),
    };
  }

  /** Prerequisite check. Returns a nudge if ANY call in the batch has
   *  unmet prereqs — whole-batch blocking. Bumps the violation
   *  counter; over budget → throws PrerequisiteError. */
  checkPrerequisites(toolCalls: ToolCallMessage[]): StepCheck {
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      if (!name) continue;
      const declared = this.prereqs.get(name);
      if (!declared || declared.length === 0) continue;
      const args = normalizeToolArguments(tc.function!.arguments);
      const missing = this.findMissingPrereqs(declared, args);
      if (missing.length === 0) continue;
      this.prereqViolations++;
      if (this.prereqViolations > this.maxPrereqViolations) {
        throw new PrerequisiteError(name, missing);
      }
      return { needsNudge: true, nudge: prerequisiteNudge(name, missing) };
    }
    return { needsNudge: false };
  }

  /** Caller invokes after a successful tool execution. Records the
   *  call on the step tracker (for arg-matched prereq lookups and
   *  required-step tracking). Note: prereq violations are checked
   *  *before* execution, so this only fires on tools that passed the
   *  enforcer. */
  record(tool: string, args: Record<string, unknown>): void {
    this.tracker.record(tool, args);
  }

  /** Called by the agent loop at the end of a clean batch (no errors,
   *  no nudges fired). Resets the transient violation counters so a
   *  single off-day call doesn't poison the rest of the run. */
  resetCounters(): void {
    this.prematureAttempts = 0;
    this.prereqViolations = 0;
  }

  /** Read-only access to the underlying tracker. Used by Phase 14's
   *  observability events ("which steps just completed?") and by
   *  tests. */
  getTracker(): StepTracker {
    return this.tracker;
  }

  /** Names of required steps still pending. */
  pending(): string[] {
    return this.tracker.pending();
  }

  private findMissingPrereqs(
    declared: readonly ToolPrerequisite[],
    args: Record<string, unknown>,
  ): string[] {
    const missing: string[] = [];
    for (const p of declared) {
      if (typeof p === 'string') {
        if (!this.tracker.hasCalled(p)) missing.push(p);
        continue;
      }
      const value = args[p.matchArg];
      if (!this.tracker.hasCalledWithArg(p.tool, p.matchArg, value)) {
        missing.push(p.tool);
      }
    }
    return missing;
  }
}

/** Per-run factory: build a `StepEnforcer` when AgentOptions opted in
 *  to any of `requiredSteps`, `terminalTools`, or tool-declared
 *  prerequisites. Returns `undefined` for the common case — callers
 *  should pass that straight through to `runAgent.options.stepEnforcer`
 *  so the enforcement phase short-circuits without allocating.
 *
 *  Lives here, next to `StepEnforcer` itself, because the construction
 *  logic owns the "do we need an enforcer at all?" predicate alongside
 *  the constructor it ultimately calls. Don't inline this back into
 *  `run-agent.ts` — the entry point is meant to be orchestration glue,
 *  not per-feature factory wiring. */
export function buildStepEnforcer(opts: {
  requiredSteps?: readonly string[];
  terminalTools?: readonly string[];
  toolDefinitions: readonly ToolDefinition[];
}): StepEnforcer | undefined {
  const hasRequired = !!opts.requiredSteps && opts.requiredSteps.length > 0;
  const hasTerminal = !!opts.terminalTools && opts.terminalTools.length > 0;
  const hasPrereqs = opts.toolDefinitions.some(d => d.prerequisites && d.prerequisites.length > 0);
  if (!hasRequired && !hasTerminal && !hasPrereqs) return undefined;
  return new StepEnforcer({
    requiredSteps: opts.requiredSteps ?? [],
    terminalTools: opts.terminalTools ?? [],
    prereqs: collectPrereqs(opts.toolDefinitions),
  });
}

/**
 * Pull prerequisites off a tool-definition list into a map suitable
 * for the StepEnforcer constructor. Called by the agent loop at run
 * start; the registry validation pass below ensures every prereq
 * resolves to a registered tool.
 */
export function collectPrereqs(
  definitions: readonly ToolDefinition[],
): Map<string, readonly ToolPrerequisite[]> {
  const out = new Map<string, readonly ToolPrerequisite[]>();
  for (const d of definitions) {
    if (d.prerequisites && d.prerequisites.length > 0) {
      out.set(d.function.name, d.prerequisites);
    }
  }
  return out;
}

/**
 * Validate that every prerequisite references a registered tool name.
 * The reliability spec (§8) wants this at registry-build time so a
 * misnamed prereq surfaces as a startup error, not a confusing nudge
 * at runtime. Throws TypeError listing the offenders.
 */
export function validatePrereqReferences(definitions: readonly ToolDefinition[]): void {
  const known = new Set(definitions.map(d => d.function.name));
  const bad: string[] = [];
  for (const d of definitions) {
    if (!d.prerequisites) continue;
    for (const p of d.prerequisites) {
      const ref = typeof p === 'string' ? p : p.tool;
      if (!known.has(ref)) {
        bad.push(`${d.function.name} → ${ref}`);
      }
    }
  }
  if (bad.length > 0) {
    throw new TypeError(
      `Unknown prerequisite tool name(s): ${bad.join('; ')}. Every prerequisite must reference a registered tool.`,
    );
  }
}
