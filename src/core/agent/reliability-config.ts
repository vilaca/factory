import type { Provider } from '../../providers/types.js';
import { TOOL_NAMES } from '../../tools/host.js';
import { appendProviderLog } from '../../utils/provider-log.js';
import { getSamplingDefaults } from '../../providers/sampling-defaults.js';

/**
 * Cross-cutting auto-enable rules for the reliability stack.
 *
 * The framework's headline result — an 8B local model going from 38% to 99%
 * on multi-step tool workflows — comes from stacking guardrails that are
 * each individually small. We don't want callers to opt into the stack
 * one knob at a time; we also don't want frontier models paying for
 * machinery they don't need. The compromise: auto-enable per-feature
 * based on what the active provider/model signals.
 *
 * Source of truth for "does this model need help": `Provider.getCapabilities
 * (model).modelTier`. The picker already classifies models into
 * strong/medium/weak; weak is the small-model cohort that benefits from
 * every guardrail. As Phase 9's sampling-defaults map and the
 * conditional surfacing rules from `docs/reliability/next-steps.md` land, this helper
 * grows to consult those signals too.
 */
/** Per-(provider, model) reliability activation. Recomputed once per
 *  turn in `phase-preflight.ts` because rotation can swap models
 *  mid-run, and threaded forward into `phase-model-call.ts` (which
 *  reads `forceToolCall` to set Anthropic `tool_choice: "any"`) and
 *  `phase-response-emission.ts` / `phase-no-tool-calls.ts` (which read
 *  `useRespondTool` to decide the Respond short-circuit and the
 *  validator retry-nudge path).
 *
 *  Lives here, not in `phase-types.ts`, because `autoEnableForModel`
 *  produces it — putting the type next to its producer keeps the
 *  dependency arrow consumer → producer rather than the other way
 *  around. */
export interface ActivationFlags {
  /** Expose the synthetic Respond tool to the model and short-circuit a
   *  single-Respond batch as the turn's natural completion. Keeps the
   *  model in tool-calling grammar at all times — eliminates the
   *  text-vs-tool-call ambiguity that costs 60+ points on small models
   *  per the reliability spec §13. */
  useRespondTool: boolean;
  /** Auto-set `forceToolCall` on Anthropic calls — the preprint shows
   *  this single knob lifts Haiku bare from 43.8% → 88.9%, a cheap
   *  intermediate guardrail when full step enforcement isn't
   *  configured. Only applies on Anthropic; other providers ignore.
   *  Default false. */
  forceToolCall: boolean;
}

/** Pure lookup — no logging, no side effects. Safe to call from inside
 *  loops and constructors. The logging entry point is
 *  `logActivation` below, which the agent loop calls once per turn so
 *  the user sees one INFO line per session rather than per call. */
export function autoEnableForModel(provider: Provider, model: string): ActivationFlags {
  const tier = provider.getCapabilities(model).modelTier;
  // A model gets the reliability path when EITHER:
  //   - the provider tier says it's weak (small local / cheap cloud), OR
  //   - we have sampling defaults for it (i.e. we verified one of its
  //     HF cards into the table — implies we care about its reliability
  //     profile and want to apply the guardrails by default).
  const hasSamplingProfile = Object.keys(getSamplingDefaults(model)).length > 0;
  const useRespondTool = tier === 'weak' || hasSamplingProfile;
  return {
    useRespondTool,
    // Auto-force-tool-call on Anthropic for weak-tier models. The
    // ChatOptions threading at call-site decides whether the
    // provider honors this (only Anthropic does today). Strong-tier
    // frontier models route text naturally; forcing them just trims
    // their natural answers.
    forceToolCall: tier === 'weak' && provider.name === 'anthropic',
  };
}

const loggedSessions = new Map<string, ActivationFlags>();

/** Emit a one-shot INFO line to the provider-events log when activation
 *  changes for a given `(provider, model)` pair. Per the surfacing
 *  decision recorded in the plan ("auto-detect, log on activate"), the
 *  caller doesn't need to know about the stack — but operators looking
 *  at the events log should be able to see which guardrails turned on
 *  for which model in this session. */
export function logActivation(
  provider: Provider,
  model: string,
  activation: ActivationFlags,
): void {
  const key = `${provider.name}::${model}`;
  const prev = loggedSessions.get(key);
  if (prev && shallowEqualActivation(prev, activation)) return;
  loggedSessions.set(key, activation);
  const features: string[] = [];
  if (activation.useRespondTool) features.push(TOOL_NAMES.Respond);
  if (activation.forceToolCall) features.push('forceToolCall');
  if (features.length === 0) return;
  appendProviderLog({
    provider: provider.name,
    category: 'diagnostic',
    action: 'reliability-activated',
    outcome: 'started',
    detail: `model=${model} features=${features.join(',')}`,
  });
}

function shallowEqualActivation(a: ActivationFlags, b: ActivationFlags): boolean {
  return a.useRespondTool === b.useRespondTool && a.forceToolCall === b.forceToolCall;
}

/** Test-only — clear the per-session activation cache so each unit test
 *  starts with a clean slate. */
export function _resetActivationLogForTests(): void {
  loggedSessions.clear();
}
