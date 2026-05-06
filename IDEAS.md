# Ideas

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
