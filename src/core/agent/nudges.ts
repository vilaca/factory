import { TOOL_NAMES } from '../../utils/tool-names.js';

/**
 * Frozen Nudge dataclass shared between the response validator (Phase 4),
 * step enforcer (Phase 5), and the agent loop. Carrying a structured
 * Nudge instead of a raw string means:
 *   - The wire role is decided once, near the producer ("user" everywhere
 *     for the reliability path — Jinja chat templates on llama-server
 *     reject mid-conversation system messages, see next-steps §11).
 *   - The semantic kind survives into the message metadata so tiered
 *     compaction (Phase 3) can drop nudges first, and observability
 *     (Phase 14) can count them by kind.
 *   - Templates are swappable — consumers can pass in custom phrasing
 *     for a specific tool surface without forking the validator.
 *
 * Naming maps 1:1 to the spec's nudge kinds:
 *   - `retry`         — malformed call / text-only when a tool was expected
 *   - `unknown_tool`  — model named a tool that isn't registered
 *   - `step`          — premature terminal (required step not done)
 *   - `prerequisite`  — tool's declared prereq not yet satisfied
 *
 * `tier` is only meaningful for `step` (1=polite, 2=direct, 3=ALL CAPS).
 * For other kinds it stays at 1; readers should ignore.
 */
export type NudgeKind = 'retry' | 'unknown_tool' | 'step' | 'prerequisite';

export interface Nudge {
  readonly role: 'user';
  readonly content: string;
  readonly kind: NudgeKind;
  readonly tier: 1 | 2 | 3;
}

function freezeNudge(n: Omit<Nudge, 'role'>): Nudge {
  return Object.freeze({ role: 'user' as const, ...n });
}

/** "Your previous response was not a valid tool call." — short, declarative.
 *  Wording matches the reliability spec (§6); the model is told what
 *  went wrong (text instead of tool call) without prescribing how to
 *  fix it beyond the structural shape. Tier stays at 1; the step-nudge
 *  escalation does not apply here — formatting failures aren't a
 *  matter of politeness. */
export function retryNudge(): Nudge {
  return freezeNudge({
    content:
      'Your previous response was not a valid tool call. You must respond with a tool call, not free text. Please try again with a valid tool call.',
    kind: 'retry',
    tier: 1,
  });
}

/** "Tool 'X' does not exist. Available tools: ..." — names the tool
 *  that was guessed and the actual set. The framework's measured lift
 *  here comes from listing the available names: small models often
 *  invent a near-synonym and pivot back when they see the real list. */
export function unknownToolNudge(badName: string, availableTools: readonly string[]): Nudge {
  const list = availableTools.length > 0 ? availableTools.join(', ') : '(none)';
  return freezeNudge({
    content: `Tool '${badName}' does not exist. Available tools: ${list}. Call one of them.`,
    kind: 'unknown_tool',
    tier: 1,
  });
}

/** Prerequisite-not-yet-met nudge. The missing list is the prereqs the
 *  attempted tool declared on `ToolDefinition` (Phase 5). Wording
 *  mirrors §6: tells the model which tool to call now rather than just
 *  saying "you're missing something." */
export function prerequisiteNudge(attemptedTool: string, missing: readonly string[]): Nudge {
  const list = missing.join(', ');
  return freezeNudge({
    content: `You cannot call ${attemptedTool} yet. You must first call: ${list}. Call the prerequisite tool now.`,
    kind: 'prerequisite',
    tier: 1,
  });
}

/** Three-tier escalation for premature-terminal attempts. The
 *  reliability spec measures ~10pt completion lift from tier escalation
 *  vs a single-tier nudge: the aggressive third tier saves runs where
 *  polite phrasing was being ignored.
 *
 *  Tier 1 — polite explanation of what's missing.
 *  Tier 2 — direct command to pick from the pending list.
 *  Tier 3 — capslocked imperative. Mentions the forbidden terminal by
 *           name and the required next step. The wording is designed
 *           to feel jarring to a model that has been ignoring the
 *           previous two attempts — that turns out to matter. */
export function stepNudge(
  attemptedTerminal: string,
  pending: readonly string[],
  tier: 1 | 2 | 3,
): Nudge {
  const list = pending.join(', ');
  let content: string;
  switch (tier) {
    case 1:
      content = `You cannot call ${attemptedTerminal} yet. You must first complete these required steps: ${list}. Call one of them now.`;
      break;
    case 2:
      content = `You must call one of these tools now: ${list}. Pick one.`;
      break;
    case 3:
      content = `STOP. You MUST call one of: ${list}. Do NOT call ${attemptedTerminal}. Your next response MUST be a tool call to one of: ${list}.`;
      break;
  }
  return freezeNudge({ content, kind: 'step', tier });
}

/** Re-export the canonical tool name so consumers in this file's
 *  immediate neighbourhood don't have to import from two places. The
 *  step-nudge templates above reference tools by string, not by
 *  enum — they pass through whatever the runtime called the tool. The
 *  Respond constant is here as a courtesy for callers that want to
 *  reference it in their custom nudge wording. */
export const RESPOND_TOOL = TOOL_NAMES.Respond;
