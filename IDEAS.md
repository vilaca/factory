# Ideas

## Milestones to a competitive production coding agent

Staged plan, ordered by capability-per-unit-of-work. Most M1 items already exist on feature branches; the work there is landing, not designing.

### M1 — Land the in-flight branches

The structural gaps vs Claude Code are mostly already implemented. Order roughly as listed: `subagent-delegate` and `skills` first because they're the structural ones; everything else compounds on top.

- **`feat/subagent-delegate`** — programmatic delegation with isolated context and summary-back. Single biggest gap closed once it lands. Follow-ups already noted on the branch: live event stream, named tab workers.
- **`feat/skills`** — loadable capability bundles. Pairs with subagents (skill + delegated agent = specialized worker).
- **`feat/hooks`** — pre/post tool-call hooks via settings. Same automation stories Claude Code's hooks enable.
- **`feat/architect-mode`** — high-level planning pass before edits.
- **`feat/repomap`** — repo map in system prompt; reduces blind grepping for small models especially.
- **`feat/lsp`** — diagnostics surfaced in tool results. Unlocks the lint/test feedback loop.
- **`feat/checkpoints`** — `/save`, `/restore`, `/list`. Foundation for `/undo`.
- **`feat/auto-format-on-write-v2`**, **`feat-lint-test-feedback`**, **`feat/loop-detection-tool-agnostic`** — quality fixes that compound: formatted output → fewer diff churns → faster lint feedback → loop detector breaks pathological retries.
- **`feat/apply-patch`** — unified-diff edits. Important escape hatch for models that struggle with the `Edit` signature.
- **`feat/web-fetch`**, **`feat/workflows`**, **`feat/agents-md-fallback-v2`** — ecosystem fit; AGENTS.md/CLAUDE.md/.cursorrules loading makes factory drop-in for existing repos.
- **`feat/bash-sandbox-tier1-2`**, **`feat/security-risk-field-v2`** — security baseline; gates destructive ops without adding friction to the common case.
- **`moooar-tools`** — image/audio/fetch + wider `ChatMessage.content`. Multimodal table stakes.

Pre-merge prep per branch: rebase on current main, conflict resolution, end-to-end regression across at least one frontier and one local provider.

### M2 — Agent depth

Capabilities the merged feature set still lacks but that frontier agents lean on heavily.

- **Task-ledger tool** (TodoWrite-shaped). Persistent in-turn plan the model maintains itself; visible progress without prose. Materially changes how multi-step work proceeds.
- **Parallel sub-agents.** Once delegate lands, fan-out: launch N delegates in one turn for independent queries, gather when all complete. Big wall-clock win on broad-search tasks.
- **Background tasks + monitor.** Long-running shell (build, test suite, dev server) that doesn't block the turn; agent is notified on output/completion. Pairs with the lint/test feedback loop.
- **`/run` and `/undo`** — both small once checkpoints lands. `/undo` becomes "restore the autosaved checkpoint from before the last edit batch."

### M3 — Integration surfaces

Get out of the terminal.

- **ACP server mode** (already in IDEAS) — JSON-RPC surface so editor extensions drive the same core loop. VS Code extension as the reference client.
- **Wider MCP support.** `src/mcp` is a basic adapter; expand resource/prompt surfaces, server lifecycle, and OAuth flows for hosted servers. Each well-supported server is leverage factory gets for free.
- **Headless API surface for CI.** Structured (JSON-streaming) output, exit codes that distinguish "model declined" from "tool failed," and a bounded-cost mode.

### M4 — Production hardening

Separates a hobby tool from something teams ship to production.

- **Eval harness.** Reproducible task suite (fix-this-bug, refactor-this, port-this-API) run nightly across the provider matrix. Without it, prompt and tool-reliability regressions go unnoticed; *with* it, the small-model-resilience claim becomes testable.
- **Structured error taxonomy** (already in IDEAS) — codes like `STALE_REF`, `KEY_EXHAUSTED`, `RATE_LIMIT`, `TOOL_TIMEOUT`. Enables better automated recovery and cleaner UX.
- **Session telemetry beyond cache.** Per-tool latency, error rate, retry counts, correction frequency. Drives the existing "mine session logs" idea.
- **Crash recovery.** Mid-edit-batch terminal kill should leave a recoverable session. Pairs with checkpoints.

### M5 — Ecosystem fit

- **Scoped persistent memory** (already in IDEAS) — natural next layer once skills + hooks land.
- **Plugin/skill manifest + trust model.** Even without a registry, fix the manifest shape, signing, and permission scoping so third-party skills can be safely shared.
- **Team mode.** Shared skills/workflows/memory tracked in-repo; per-user keys and rotation chain stay local. Generalizes the personal-vs-shared split from the memory idea to all config.

---

Sequencing rationale: **M1** closes the perceived gap on most workflows; **M2** makes the agent feel comparably capable on hard tasks; **M3** makes adoption easy; **M4** keeps it; **M5** is what makes the bring-your-own-model story stick beyond solo users.

---

## Hierarchical permission model

Replace the flat allowlist in `src/permissions.ts` with a tree, e.g. `bash:git:read`, `bash:git:write`, `mcp:atlassian:*`. Grant once at a node, cascade to children; revoke at a node, cascade too.

- Pro: fewer entries, intent is obvious, revocations are surgical.
- Con: matching is more complex; harder to answer "what exactly does this token permit" at a glance — flat lists are dumb but auditable.
- Worth doing if prompt volume / allowlist size justifies the matching cost.

## Other ideas worth considering

- **Deterministic refs for list outputs** (`@k1`, `@k2` …) valid until next list. Useful for `/keys`, sessions, models — cheaper than UUIDs in prompts and self-invalidating.
- **Structured errors with machine-readable codes + recovery hint** (e.g. `STALE_REF`, `KEY_EXHAUSTED`). Lets the model branch on code instead of regexing English.
- **Progressive "skeleton" output** for tree-shaped data — shallow overview with child counts first, drill in on demand. Generic token-saver.

## `/run` — execute a shell command and feed output into the conversation

Slash command that runs an arbitrary shell command, captures stdout/stderr/exit, and injects the result as a user message so the model can react to it. Useful for "run the tests / lint / type-check and fix what breaks" loops without the model having to ask the user to paste output.

- Stream output live in the UI; truncate very long output with a tail-N policy and a note.
- Reuse the existing permission system to gate which commands are allowed.

## `/undo` — revert the last assistant-applied change

One-shot rollback for the most recent edit set the agent made. Two plausible implementations:

1. **Git-backed**: snapshot before each edit batch (stash or temp commit), `/undo` resets to it.
2. **In-memory**: keep the previous file contents per edit and restore on demand.

Git-backed is more robust (survives crashes, multi-file batches) but requires a clean working tree or a dedicated shadow branch. Pairs naturally with `/run` — try a change, run tests, undo if red.

## Task ledger tool — model-maintained todo list as structured state

A first-class tool (call it `Todo`) that lets the model maintain a persistent, in-conversation plan as structured state rather than prose. Same shape as Claude Code's `TodoWrite`. The list is rendered as a live checkbox panel in the UI, updated in place as the model works.

Shape:
- One tool with either a `set` operation (replace the whole list) or granular `add`/`update`/`complete`. Granular is friendlier on tokens; `set` is harder for the model to get wrong.
- Each item: a short imperative line + status (`pending` / `in_progress` / `completed`). Exactly one `in_progress` at a time. Mark `completed` the moment a step finishes, not batched at the end.
- System-prompt nudge: "for any task with >3 discrete steps, maintain a `Todo` list and keep it current."

Why it earns its keep:
- **Forces planning before acting.** Writing the list surfaces missing steps and bad ordering earlier than diving into edits.
- **Anchors long turns.** On a 15-tool-call task the model drifts; the ledger is a stable artifact it can re-read to stay aligned with the original ask.
- **Replaces narration with state.** Collapses "now I'll do X… done… next…" prose into one structured artifact updated in place. Material token saving on multi-step turns.
- **Survives compaction.** Compaction preserves structured state cleanly; prose summaries of progress get lossy-compressed and the model loses track.
- **Recovery point.** Interrupted turn? Next turn resumes from the still-`in_progress`/`pending` items instead of re-deriving the plan.

Risks to engineer around:
- Models can over-use it on trivial tasks ("read this file" → 1-item list). The system-prompt threshold matters; tune empirically.
- Stale items left `in_progress` after errors. The renderer should highlight them so the user notices, and the model should be prompted to reconcile at turn start.
- Don't let it become a parallel narration. If the model writes both a ledger update *and* a prose "I just did X" sentence every step, you've doubled tokens. Style guidance in the system prompt has to push prose out, not add the ledger on top.

Cheap to build (tool definition + renderer + prompt nudge), high leverage on hard tasks. Likely the first M2 item to ship.

## ACP server mode — expose the agent over JSON-RPC

Run the CLI as a JSON-RPC 2.0 server (Agent Client Protocol shape) so IDEs and other tools can drive the agent without reimplementing its brain: prompt routing, rotation, tool dispatch, permissions all stay in one place.

- Transport: stdio first (cheapest, fits editor extensions); add a local socket later if needed.
- Methods to expose at minimum: `prompt`, `cancel`, `listModels`, `listTools`, plus a streaming notification channel for tokens / tool events.
- Reuse the same core loop as the TUI — TUI becomes one client among others.
- Worth doing once there's demand for editor integrations; otherwise YAGNI.

## Mine session logs to cut token usage

Offline analytics pass over our own transcripts (model turns + tool calls + outcomes) to find token waste and convert it into deterministic local behavior.

What to look for:
- **Recurring tool-call sequences** (same N calls in the same order across sessions) → propose as a slash command / parameterized macro. Replays without re-prompting the model.
- **Hot prompt prefixes** that repeat verbatim across sessions → push them behind explicit prompt caching so they hit cache instead of being re-tokenized.
- **Question → answer pairs the user keeps asking** ("which key is active?", "what's my chain?") → already partly addressed by `/keys`; extend the pattern when new ones surface.
- **Failed-then-corrected patterns** (model proposes X, user rejects, model does Y) → quality signal for system-prompt tuning, not a runtime saver but a feedback loop.

Pipeline shape worth borrowing — *architecture only, no code*: a 4-stage offline compiler over recorded artifacts:
1. **Normalize** raw log events into a canonical action stream.
2. **Resolve** — collapse redundant context, identify stable handles.
3. **Identify** — detect retrieval objectives / recurring intents.
4. **Synthesize** — emit a reusable skill / macro / cache entry.

The offline-compile-once / replay-cheaply shape is the win — record nothing new, just analyze what already happened and emit deterministic replacements.

## Prompt caching across supported models

Superseded by the staged plan in `~/.claude/plans/vast-inventing-candle.md` — see Phases 0–7 for what shipped, plus the `Cost & Token Management` section in `README.md` for the user-facing surface.

### TODO — Phase 8: Gemini explicit caching

Gemini 2.5 has implicit caching (≥1024 tokens, automatic) which the current plumbing already covers via `prompt_tokens_details.cached_tokens`. Explicit `cachedContents` is only worth the lifecycle complexity (create / refresh on TTL / delete) for very long stable prefixes (>32k tokens) reused across many sessions.

**Build trigger:** Phase 0 telemetry shows Gemini cache-miss rate >40% on long prefixes. Until that data exists, this stays deferred.

If pursued: adopt `@google/genai` SDK in `src/providers/googleaistudio.ts` and manage cache lifecycle. Reuse the per-key warmth signal from `core/key-stats.ts` to decide when to refresh.

## Scoped persistent memory

Per-project memory layer that surfaces context only when relevant, instead of always-loading a single index every turn.

Shape:
- Memories stored as small JSON/markdown files under `.factory/memories/` in the user's project (or a global dir for cross-project facts).
- Each memory tagged with a **glob** (e.g. `src/auth/**`, `migrations/*.sql`) and a **type** (preference, technical, decision, guideline).
- On each turn, match the conversation's referenced paths against globs; inject only the matching memories. Unmatched memories stay on disk, paying zero tokens.
- Personal vs shared split: shared memories are git-tracked (team conventions, architectural decisions); personal memories stay local (workflow preferences). Two directories, one config flag.

Auto-capture hooks:
- Detect "no, do it this way" corrections in the transcript and propose saving the rule as a memory.
- Detect repeated explanations of the same fact across sessions and propose promoting it to a memory.
- Always confirm before writing — silent capture builds garbage fast.

Risks to engineer around:
- Stale memories are worse than no memory. Need a TTL / last-confirmed timestamp and a "challenge" path when a memory contradicts current code.
- Shared memories injected into teammates' sessions amplify mistakes. Treat the shared scope as conservative-by-default.
- Glob matching has to be cheap — runs every turn.

Token win comes from scoped injection; UX win comes from auto-capture; team win comes from git sync. Each is independently shippable.

**Related work:** [mdcore](https://github.com/piyush-tyagi-13/markdown-core-ai) (markdown-core-ai) is a semantic knowledge base engine that does retrieval + ingestion + classification for markdown vaults. Worth studying for two specific patterns:

1. **Synthesis over fragments** — mdcore assembles BM25 + vector hits into stitched context (heading-aware chunks + citations) and asks an LLM to produce a single concise synthesis instead of dumping raw excerpts. Includes provenance (filenames, timestamps) so the synthesis can prefer/flag authoritative sources and improve chunking.

2. **Conflict detection without auto-overwrite** — similarity thresholds (BM25/vector) drive behavior:
   - High similarity (>threshold) → near-duplicate → flag
   - Low similarity (<threshold) → new content → accept
   - Ambiguous band (~0.65–0.82) → LLM decides
   
   On conflict, mdcore surfaces both versions, generates an LLM "proposal" (target path, merged content or delta, change log, confidence hints), and requires explicit user approval before writing. Can add rules (prefer official folders, timestamp bias) or two-stage prompts (1: list contradictions, 2: produce reconciled canonical text with citations).

For factory: use synthesis when injecting memories (don't just paste excerpts — ask the model to weave them into a briefing). Use conflict detection if memories ever need auto-merging or if the team wants to catch contradictions before they ossify in git.
