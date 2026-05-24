# utils — orientation

Small, dependency-free helpers used by multiple top-level layers (`security/`, `providers/`, `core/`, `tools/`, `ui/`, `cli/`). Every file in this folder is meant to be a leaf — `utils/` itself imports from nothing inside `src/` except other `utils/` files.

## Files

- `atomic-write.ts` — write-then-rename helper used by config / credential persisters.
- `build-info.ts` — embedded build / version metadata (`__APP_VERSION__`, `__BUILD_TIMESTAMP__`).
- `chat-message.ts` — `ChatMessage` shape + helpers, used wherever conversations are built.
- `debug.ts` — `debug(...)` gated on `DEBUG_FACTORY` env var.
- `errors.ts` — `errorMessage(unknown)`: best-effort string extraction from anything thrown.
- `factory-paths.ts` — `factoryHomePath(...)`, the single source of truth for `~/.factory/...`.
- `format-tokens.ts` — token-count pretty-printing for the status bar.
- `git.ts` — branch / dirty detection used by `agent-loop/git-state.ts` and the status bar.
- `glob-match.ts` — minimal glob matcher; used by bash rules + path policy.
- `json-extract.ts` — tolerant JSON extraction from model output (fenced blocks, trailing garbage).
- `json-schema-validate.ts` — minimal JSON Schema validator for tool argument validation.
- `provider-log.ts` — `[provider/model] …` log prefix helpers.
- `think-tags.ts` — strip / fold `<think>` blocks across providers that surface them.
- `timeout.ts` — `withTimeout(promise, ms)` + `TimeoutError`.
- `tokens.ts` — token estimation (chars/4 baseline).
- **`tool-definition.ts`** — `ToolDefinition` + `ToolPrerequisite`. **Lives here, not in `tools/`** — see below.
- **`tool-names.ts`** — `TOOL_NAMES` constant. **Lives here, not in `tools/`** — see below.

## Why `tool-definition.ts` and `tool-names.ts` live in `utils/`

They look like they belong in `tools/`. The reason they don't is **layering**: `security/permissions.ts` and `providers/openai/*` both need them, but `security/**` and `providers/**` are primitives that the arch test forbids from importing siblings (`security → tools`, `providers → tools` are both arch-test violations).

`utils/` is the lowest layer everyone can import from, so the shared types live here. `src/tools/types.ts` re-exports both so tool authors still see a unified `tools/types.ts` surface — they never have to know the underlying file moved.

**Don't try to "tidy" this by moving the types into `tools/types.ts`** as the canonical home. Two things will happen:

1. `tsc` will still pass.
2. `npm run test:unit -- modularity` will fail with `security/permissions.ts → tools/types.ts` and `providers/openai/* → tools/types.ts` arch-test violations.

The natural next move ("just add `tools/types.ts` to the `security` and `providers` allowlists") defeats the entire purpose of the primitive-layer arch tests. The current layout — leaf types in `utils/`, ergonomic re-export from `tools/types.ts` — is the load-bearing answer.

This is documented in the file headers of `tool-definition.ts` and `tool-names.ts` too, but agents tend to read those after deciding on the move. This file is meant to catch the decision before it's made.

## Invariants enforced in `test/unit/arch/modularity.test.ts`

- `utils/**` must not import from any sibling top-level folder (`security/`, `providers/`, `core/`, `tools/`, `ui/`, `mcp/`, `cli/`). If a util needs context from one of those layers, it accepts it as a parameter.
- The arch tests that put `security/`, `providers/openai/`, etc. on a primitive-only diet are the reason `tool-definition.ts` and `tool-names.ts` cannot be moved into `tools/`.

## Don't

- **Don't add a util that imports from `core/`, `tools/`, `ui/`, etc.** _Enforced by arch test:_ `utils/**` is a leaf layer. Take the caller's context as a parameter.
- **Don't move `tool-definition.ts` or `tool-names.ts` into `tools/`.** _Enforced by arch test:_ the move breaks `security/**` and `providers/openai/**` imports. The re-export from `tools/types.ts` already gives tool authors a clean surface — preserve that, don't relocate.
- **Don't add a runtime dependency to a util.** Every file here is meant to be pure / dependency-free so that the layers that import from `utils/` stay light. Anything needing a third-party package belongs one layer up.
