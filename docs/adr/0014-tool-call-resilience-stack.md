# 0014 — Tool-call resilience stack for non-frontier models

- **Status:** Accepted
- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

A premise of the project — "bring your own model, including 7B-class" — requires that the agent loop survive models that mis-emit tool calls. The observed failure modes are not exotic: prose-embedded JSON that should have been a tool call, malformed arguments missing a required field, fabricated tool-result blocks the model invents instead of waiting, near-duplicate Bash calls in a tight loop, and self-reinforcing repetition that produces the same line indefinitely.

A single mechanism cannot address these — they happen at different layers (transport text, parsed call, dispatched call, recurring pattern) and need different responses. But uncoordinated retries amplify the problem: a corrector that re-prompts on a repetition will burn tokens on the same loop the repeat-detector is trying to break.

## Decision

Resilience is a set of layers, each acting at a different juncture in the turn pipeline. The junctures are fixed; within a juncture the order is documented and tested. From earliest to latest in a turn:

- **Streaming layer (during `callModel`):**
  - **Repeat detector** (`repeat-detector.ts`) — aborts the turn when streamed output exhibits self-reinforcing repetition past a threshold. Runs continuously while chunks arrive.

- **Parsing layer (in `parse-response.ts`, after the model finishes the turn):**
  1. **Text-tool fallback parser** (`text-tool-parser.ts`) — extracts tool calls from prose when the provider returned them outside the structured tool-call channel.
  2. **Tool-result imitation strip** (`tool-result-format.ts`) — removes fabricated `tool_result` blocks the model wrote instead of waiting for real ones.

  The parsing order is load-bearing: the strip runs after extraction so the corrector below never sees a fabricated result.

- **Pre-execution dispatch (in `run-tool-calls.ts`):**
  - **Bash-dedup nudge** (`bash-dedup.ts`) — fires a one-shot system nudge when the model is about to run a near-duplicate Bash command. Nudges, does not block.

- **Post-failure recovery (in `run-tool-calls.ts`, only when a tool call fails):**
  - **LLM-driven corrector** (`tool-call-corrector.ts`) — re-prompts on a malformed call using a cheaper model picked by `weak-tier.ts`. Capped retries; emits `tool-call-corrector-aborted` on exhaustion.

Each layer reports a distinct `AgentEvent` (`repetition-detected`, `tool-call-recovered`, `tool-result-imitation-stripped`, `bash-dedup-nudge`, `tool-call-corrected` / `tool-call-corrector-aborted`) so debugging which mechanism fired is a log read.

## Consequences

**Easier.**

- Each failure mode has a single owner. A new failure pattern goes in its own layer rather than overloading an existing one.
- Token cost of recovery is bounded: the corrector uses a weak tier; the repeat detector aborts rather than re-prompts; bash-dedup nudges only once.
- Logs make it obvious whether the model needed help on this turn — useful for the eval harness (M5) and for picking which models to recommend.

**Harder.**

- Within the parsing layer, order is not commutative: the imitation strip must run before the corrector so the corrector never re-prompts about a fabricated result. Across junctures, layers cannot be reordered at all — repeat-detection has to be streaming, bash-dedup has to be pre-execution, the corrector has to be post-failure. New layers slot into one of these junctures or define a new one with an ADR.
- A frontier model that doesn't need any of these layers still pays the parse cost. The cost is measurable but small; if it ever isn't, the layers can be made opt-out per provider rather than removed.

**Invariants future contributors must preserve.**

- The order in `run-tool-calls.ts` and `call-model.ts` is load-bearing. Comments at each layer explain why it sits where it does.
- A new resilience mechanism is a new layer or a refinement to an existing one — not a special case wedged into an unrelated layer.
- The weak-tier corrector picks the cheapest available model, not the current one. This is what keeps recovery cost bounded even when the user is running a frontier tier.
