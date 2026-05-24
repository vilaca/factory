# tools — orientation

Built-in tools the model can call (Read, Write, Edit, Bash, Glob, Grep, WebFetch, Delegate, Respond) plus the registry that exposes them.

## Public entry

- `ToolRegistry` (`registry.ts`) — per-session registry; constructed in `src/index.ts` and threaded through `appOptions.toolRegistry`. Do not import `defaultRegistry` from production code (arch test enforces; it exists only as a test convenience).
- `types.ts` — **canonical tool-author surface.** A new tool needs only this file and `errors.ts`. `ToolDefinition`, `ToolPrerequisite`, and `TOOL_NAMES` are re-exported here from `utils/` for ergonomics; see the file header for why the underlying definitions live in `utils/`.

## Files

- `types.ts` — `ToolHandler`, `ToolResult`, `ToolContext`, `ToolCategory`; re-exports `ToolDefinition`, `ToolPrerequisite`, `TOOL_NAMES`.
- `registry.ts` — `ToolRegistry` class with the built-in registration list. Auto-registers Read/Write/Edit/Bash/Glob/Grep/WebFetch/Respond on construction; pass `{ empty: true }` for the subagent runner's curated set.
- `errors.ts` — `ToolResolutionError` (the only "soft error" the executor recognizes; pairs with `softError: true` + `skipCorrector: true` on the result).
- `respond.ts` — synthetic terminal tool. Always registered; visibility on the wire is decided per-turn by `core/agent/run-agent.ts` via `getDefinitions({ exclude })`.
- `read.ts`, `write.ts`, `edit.ts`, `bash.ts`, `glob.ts`, `grep.ts`, `delegate.ts` — one file per built-in. Each exports a handler constant typed as `StandardToolHandler` (or `BashToolHandler` for Bash).
- `web/` — WebFetch and its HTML rendering pipeline: `fetch.ts` → `html-tokenize.ts` → `html-render.ts` → `html-to-markdown.ts`, with the tool handler in `index.ts`.

## Tool-author contract

Every tool implements one of two handler shapes, declared in `types.ts`:

```ts
// Standard tool — forbids `cwdAfter` on the success branch.
interface StandardToolHandler {
  kind?: 'standard';
  name: string; // must match a TOOL_NAMES.* value if it's a built-in
  description: string;
  category: 'read-only' | 'write' | 'execute';
  definition: ToolDefinition; // JSON schema sent to the LLM
  execute(args, ctx?: ToolContext): Promise<ToolResult>;
}

// Bash-only handler. The `kind: 'bash'` discriminator is what allows
// `execute` to return `cwdAfter`; the executor narrows on it to read
// the field. Currently the in-tree `bashTool` plus the subagent's
// hardened wrapper are the only two values of this type.
interface BashToolHandler {
  kind: 'bash';
  // …same other fields…
  execute(args, ctx?: ToolContext): Promise<BashToolResult>;
}
```

Declare new tools with the narrow type (`StandardToolHandler` for everything except Bash). Annotating as the union `ToolHandler` widens the shape and defeats the `cwdAfter` check.

Return shapes are enforced by the discriminated union — the prose matrix that used to live in this file (and in `types.ts`'s JSDoc) is now a type:

- `success: true` ⇒ `softError`/`hardError`/`skipCorrector` typed as `?: never`. Setting any of them is a compile error. **Enforced by type.**
- `softError: true` ⇒ `skipCorrector: true` required. **Enforced by type** (`ToolFailureSoft`).
- `softError` and `hardError` are mutually exclusive — they live in separate variants of the union, so satisfying both is impossible. **Enforced by type.**
- `cwdAfter` ⇒ only available on `BashSuccess`. Setting it on a `StandardToolHandler`'s result is a compile error. **Enforced by type** (`?: never` on `ToolSuccess`).

Wrapping rules the executor (not the tool author) is responsible for:

- `softError` ⇔ executor caught a `ToolResolutionError`. The shape is enforced by type; the _thrown-vs-shaped_ mapping is verified by `test/unit/core/agent/tool-resolution-error.test.ts`.
- `hardError` ⇔ executor caught any other exception. Same split: type guarantees the shape, tests guarantee the catch pathway.

## Adding a tool — checklist

1. New file `src/tools/<name>.ts` exporting a `ToolHandler` constant.
2. Add a `TOOL_NAMES.<Name>` entry in `src/utils/tool-names.ts` (re-exported from `tools/types.ts`).
3. Register it in `ToolRegistry`'s constructor in `registry.ts`. If it shouldn't be in the default set, register it conditionally in `src/index.ts` (e.g. how `Delegate` is registered via `registerSubagentTool`).
4. Tests under `test/unit/tools/<name>.test.ts`. End-to-end coverage under `test/e2e/tools.test.ts` if it needs full-stack verification.
5. If the tool needs interactive permission, the permission gate in `core/agent/tool-calls/run-tool-calls.ts` and `security/permissions.ts` should usually Just Work via `category` — only touch them if you need bespoke prompt copy.
6. If the tool has hard prerequisites ("Edit requires a prior Read of the same file"), express them via `definition.prerequisites` so the step enforcer surfaces nudges at runtime.

## Security gate

Tool execution is gated by `core/agent/tool-calls/run-tool-calls.ts` calling into:

- `security/permissions.ts` — allow-once / allow-always / per-domain (WebFetch) state machine.
- `security/paths.ts` — symlink-aware path jail used by Read/Write/Edit/Grep/Glob.
- `security/bash-rules.ts` — built-in deny list + user globs for Bash.
- `security/env.ts` — env scrubbing for Bash subprocess spawns.

Built-in security rules cannot be overridden by user config — only extended.

## Invariants enforced in `test/unit/arch/modularity.test.ts`

- `tools/**` may import from `core/agent/step-enforcer.js` (for `validatePrereqReferences`) and `core/subagent/runner.js` (Delegate). No other `core/` imports — keep handler files self-contained.
- `ui/**` may import only `tools/types.ts`, `tools/registry.ts`, and `tools/index.ts`. No UI file may import an individual tool handler (handler implementations are private to `tools/` + `core/`).
- Production code outside `tools/index.ts` must not import `defaultRegistry`.

## Don't

- **Don't add tool-name string literals anywhere.** _Enforced by type:_ APIs that take a tool name require `keyof typeof TOOL_NAMES`; a plain string is a compile error.
- **Don't put cross-cutting tool state on a module-level variable.** _Folklore:_ no mechanical check. Per-tool state lives on the handler closure or in `ToolContext`; per-session state goes through the registry or `ToolLoopContext`. The next regression on this rule should land an arch test.
- **Don't widen a handler's annotation to `ToolHandler`** when you mean `StandardToolHandler`. The union accepts either branch, which loses the Bash-only `cwdAfter` guarantee at the declaration site. _Folklore:_ no mechanical check yet — typing as the union compiles. The pattern is enforced by review until a lint rule lands.
