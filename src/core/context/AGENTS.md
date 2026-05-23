# core/context — orientation

Conversation state and context-window management. If you're modifying how messages are stored, what the system prompt contains, or how we shrink the context when it fills, you're in the right place.

## Public surface

- `Conversation` (`conversation.ts:33`) — append-only message store with typed metadata (`AppendMeta`). 12 message types are tagged (`system_prompt`, `user_input`, `tool_call`, `tool_result`, `reasoning`, `text_response`, `step_nudge`, `prerequisite_nudge`, `retry_nudge`, `context_warning`, `summary`, `tool_error`). Metadata is stripped at the wire boundary.
- `ContextManager` (`context-manager.ts:80`) — window-budget state machine; orchestrates summary-LLM compaction (phase 4).
- `runTieredCompact()` (`tiered-compact.ts:200`) — deterministic phases 1–3 (no LLM call): elide tool results, drop reasoning, prune oldest turns. Exports `CompactionPhase = 0|1|2|3`, `TieredCompactResult`, `findEligibleEnd`, `TRUNCATE_CHARS`.
- System prompt builders (`system-prompt.ts`) — `buildEnvironmentMessage`, `getGitStatusSnippet`, `getPlanModePrompt`, `getSubagentsPrompt`, `getLineCountHintPrompt`, `getTextToolFallbackPrompt`.
- Project facts (`project-facts.ts`) — glob-driven discovery of `CLAUDE.md` / `AGENTS.md` files within scope.

## Files

- `conversation.ts` (262 LOC) — `Conversation` class + `AppendMeta`.
- `context-manager.ts` (599 LOC) — `ContextManager` class. Owns usage estimation, summary-LLM trigger thresholds, summary prompt construction, context-warning emission.
- `tiered-compact.ts` (262 LOC) — phases 1–3 algorithm.
- `system-prompt.ts` (236 LOC) — modular system-prompt fragments.
- `project-facts.ts` (128 LOC) — facts-file discovery.

## Compaction in two acts

`core/agent/compaction.ts:maybeCompact()` is the entry point from the turn loop. It sequences:

1. **Phases 1–3 (deterministic)** — calls `runTieredCompact` here. No LLM call. Always tried first.
2. **Phase 4 (summary LLM)** — falls through to `ContextManager` summary path only if deterministic phases didn't free enough budget.

If you're tempted to add a "smart" decision between them, look at how the sequencer escalates today before adding heuristics.

## Token math conventions (enforced by ArchUnit)

Never read `.totalTokens`, `.completionTokens`, or `.reasoningTokens` directly when computing context fullness. Always go through `contextFillTokens(usage)` in `src/providers/usage.ts` — it pulls `promptTokens` from the correct field per provider and returns the canonical "how full are we" number.

Rule lives in `test/unit/arch/modularity.test.ts` (commit `44aeb26`). Bug it prevents: status-bar jitter from accidentally summing prompt + completion.

## Adding a new message type

Every `Conversation.append()` accepts an `AppendMeta` carrier. Downstream decisions key off the 12 types: deterministic compaction uses them to know what's safe to elide (`reasoning` droppable in phase 2; `user_input` sacred); the renderer uses them to decide what to show; the summary phase uses them to anchor on user requests. Don't add a new type without:

- Adding it to the union in `conversation.ts` / `chat-message.ts`.
- Deciding its compaction class (which phase, if any, may drop or elide it).
- Updating `stripMetadata` if it must not leak to the wire.

## Out of scope here

- Prompt caching boundary placement — `src/core/agent/cache/cache-boundaries.ts`.
- Compaction event rendering — `src/ui/tui/agent-loop/compaction-resolver.ts` and `src/ui/headless.ts`.
