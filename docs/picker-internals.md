# Picker internals

Maintainer notes for the model picker pipeline. Covers per-provider quirks, capability inference, sort order, and the inference fallbacks that protect against missing model metadata.

## Pipeline

A model id flows through four stages before reaching the user's terminal:

```
provider catalog → listModels() filter → prepareModels() sort → ProviderPicker render
```

1. **Catalog fetch** — each provider reads its upstream `/v1/models` (or equivalent). Some providers ship rich metadata (OpenRouter's `architecture`, Mistral's `capabilities`); others ship only `{id, created, owned_by}` (OpenAI, Groq).
2. **Per-provider filter** — `src/providers/list-models-filter.ts` `filterChatModels()` partitions the catalog into kept/dropped and writes one diagnostic log entry per non-empty drop set. See [Filter logging](#filter-logging).
3. **Picker sort** — `src/ui/tui/components/provider-picker/prepare.ts` `prepareModels()` orders by capability signals exposed via `Provider.getCapabilities(model)`. See [Sort order](#sort-order).
4. **Render** — `stages.tsx` shows a windowed list. `Session.tsx` and `cli/startup/menu.tsx` both call `buildPickerInfo()` (`src/ui/tui/components/provider-picker/build-info.ts`) to derive `ModelDisplayInfo` consistently.

## Filter logging

Every catalog drop lands in `~/.factory/provider-events.jsonl`:

```json
{"ts":"2026-05-09T...","provider":"openai","category":"diagnostic","action":"list-models-filter",
 "detail":"{\"kept\":42,\"dropped\":[{\"id\":\"whisper-1\",\"reason\":\"non-chat: matches 'whisper'\"}, ...]}"}
```

Inspect with:

```bash
tail -f ~/.factory/provider-events.jsonl |
  jq 'select(.action=="list-models-filter") | {provider, detail: (.detail | fromjson)}'
```

When a user asks "where's `gpt-4o-audio-preview`?", the log answers (`reason: "non-chat: matches 'audio'"`).

## Sort order

`prepareModels()` is a stable sort with these keys, descending unless noted:

1. **Tier** (`strong` > `medium` > `weak` > unknown). Primary signal — buckets flagships, mini/mid-tier, and deprecated/weak families.
2. **Coding specialist** (true > false). `codex`/`coder` substring fine-tunes float above generic flagships within the same tier — this CLI is a coding agent, so coding-specialist variants are preferred.
3. **Context window** (`ProviderCapabilities.contextWindow`). Larger first.
4. **Max output tokens** (`ProviderCapabilities.maxOutputTokens`). Larger first.
5. **Name** (`localeCompare(b, a, { numeric: true })`). Newer numeric versions first, e.g. `claude-sonnet-4-5` above `3-5`.

Coding-specialist detection lives in `build-info.ts` `isCodingSpecialistName()` — generic substring match, no per-provider table.

## Tier inference

Every provider must populate `getCapabilities(model).modelTier`. The `weak`/`medium`/`strong` distinction is provider-specific because catalog conventions differ. Two patterns recur:

- **Mini/nano demotion**: a smaller variant of an otherwise-strong family. Most providers handle this with a longest-prefix table that has explicit rows for the mini variants. The OpenAI provider also has a generic `/(?:^|[-/])(?:mini|nano)\b/` regex as a *fallback* so an unknown future `gpt-6-mini` still demotes correctly.
- **Deprecated families**: pinned to `weak` so the picker pushes them to the bottom even when context size would otherwise rank them higher.

## OpenAI: why one big table

OpenAI's `/v1/models` returns only `{id, object, created, owned_by}`. Every other capability — context window, max output, vision, tools, reasoning, deprecation — has to be inferred from the model id.

Rather than scatter `startsWith` chains across six functions, all per-family knowledge lives in one ordered table at the bottom of `src/providers/openai/provider.ts`:

```ts
const OPENAI_FAMILIES: ReadonlyArray<OpenAIFamily> = [
  { prefix: 'gpt-5', contextWindow: 1_047_576, maxOutputTokens: 128_000, tier: 'strong', reasoning: true, vision: true },
  // ...
  { prefix: 'gpt-3.5-turbo', contextWindow: 16_385, maxOutputTokens: 4_096, deprecated: true },
];
```

`lookupFamily(model)` returns the row whose `prefix` is the longest match (so `gpt-4o-mini` beats `gpt-4o`). All capability getters are one-liners through this lookup.

**To add a new OpenAI family**: add one row. Existing functions don't need changes.

**Defaults when no row matches** (used for new flagships before someone adds a row):

| Field | Default | Effect |
|---|---|---|
| `contextWindow` | `128_000` | sorts mid-pack |
| `maxOutputTokens` | `16_384` | sorts mid-pack |
| `reasoning` | `false` | API request keeps `temperature` |
| `vision` | `false` | not flagged in detail string |
| `supportsTools` | `true` | tools enabled |
| `tier` (override) | falls through to mini/nano regex, then `strong` | flagships float to top of `strong`; minis demote to `medium` |

Self-correcting: a brand-new `gpt-6-titan` with no table row lands in middle of `strong` tier with default capabilities — visible, not at the top, not buried.

## Date-alias dedup

OpenAI's catalog returns both an alias and its dated pin (e.g. `o3-mini` *and* `o3-mini-2025-01-31`). The provider drops the dated form when its alias is also present:

```ts
const aliasBase = stripDateSuffix(item.id);
if (aliasBase && allIds.has(aliasBase)) return `alias of '${aliasBase}'`;
```

Recognised suffixes: `-YYYY-MM-DD` and `-NNNN` (e.g. `gpt-4-0613`). The drop is logged with reason `"alias of '<base>'"` so the user can see why a specific dated id is missing.

## Provider catalog signals (cheat sheet)

| Provider | Context window | Deprecation flag | Mini/nano detection | Notes |
|---|---|---|---|---|
| OpenAI | inferred (table) | inferred (table) | regex + table | richest inference logic |
| Groq | inferred | none | regex | small catalog |
| OpenRouter | catalog (`top_provider.context_length`) | catalog (`expiration_date`) | from `architecture` | most metadata of any provider |
| Mistral | catalog (`max_context_length`) | inferred | substring | catalog has `capabilities.completion_chat` |
| Cohere | catalog (`context_length`) | catalog (`is_deprecated`) | n/a | catalog can be filtered server-side via `?endpoint=chat` |
| Anthropic | inferred (3-model curated list) | n/a (curated) | n/a | no public catalog API |
| HuggingFace | inferred (curated list) | n/a | n/a | no "models I can use" endpoint |
| Google AI Studio | catalog (`inputTokenLimit`) | name substring | regex | rich filter via `supportedGenerationMethods` |
| Vercel AI Gateway | catalog (`context_window`) | name substring | n/a | filters to `type === 'language'` |
| Cerebras / Workers AI / Copilot / OpenCode Zen / llama.cpp / Ollama | inferred or upstream-trusted | varies | varies | see provider source |

## When metadata changes

| Change | What to update |
|---|---|
| OpenAI ships a new flagship (`gpt-6`, etc.) | Add a row to `OPENAI_FAMILIES`. Existing functions inherit it. |
| OpenAI deprecates a family | Set `deprecated: true` on the matching row. Picker shows warning + sinks to weak tier. |
| New non-chat endpoint type ships (e.g. `/v1/realtime-vision`) | Add a substring to that provider's `NON_CHAT_PATTERNS`. Drops are logged. |
| New coding-specialist family (Anthropic-codex, etc.) | Nothing — `codex`/`coder` substring is detected generically. |
| Provider exposes new capability metadata | Plumb it through `getCapabilities()`; picker auto-uses ctx/maxOut. |

## Cross-references

- `src/providers/list-models-filter.ts` — shared filter+log helper.
- `src/ui/tui/components/provider-picker/prepare.ts` — sort algorithm.
- `src/ui/tui/components/provider-picker/build-info.ts` — `Provider` → `ModelDisplayInfo` adapter.
- `src/providers/types.ts` — `ProviderCapabilities`, `ModelPickerInfo`.
- `src/core/session/session-log.ts` `appendProviderLog` — diagnostic log writer.
