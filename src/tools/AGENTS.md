# tools — orientation

Built-in tools the model can call (Read, Write, Edit, Bash, Glob, Grep, WebFetch, Delegate, Respond) plus the registry that exposes them.

## Public entry

- `ToolRegistry` (`registry.ts`) — per-session registry; constructed in `src/index.ts` and threaded through `appOptions.toolRegistry`. Do not import `defaultRegistry` from production code (arch test enforces; it exists only as a test convenience).
- `types.ts` — **canonical tool-author surface.** A new tool needs only this file and `errors.ts`. `ToolDefinition`, `ToolPrerequisite`, and `TOOL_NAMES` are re-exported here from `utils/` for ergonomics; see the file header for why the underlying definitions live in `utils/`.

## Files

- `types.ts` — `ToolHandler`, `ToolResult`, `ToolContext`, `ToolCategory`; re-exports `ToolDefinition`, `ToolPrerequisite`, `TOOL_NAMES`.
- `registry.ts` — `ToolRegistry` class with the built-in registration list. Auto-registers Read/Write/Edit/Bash/Glob/Grep/WebFetch/Respond on construction; pass `{ empty: true }` for the subagent runner's curated set.
- `errors.ts` — `ToolResolutionError` (the only "soft error" the executor recognizes; pairs with `softError: true` + `skipCorrector: true` on the result).
- `respond.ts` — synthetic terminal tool. Always registered; visibility on the wire is decided per-turn by `core/agent/run-agent.ts` via `getDefinitions({ exclude })`. Don't make Respond visibility a config flag — the reliability rationale lives in `run-agent.ts` and `reliability-config.ts`.
- `read.ts`, `write.ts`, `edit.ts`, `bash.ts`, `glob.ts`, `grep.ts`, `delegate.ts` — one file per built-in. Each exports a `ToolHandler` constant. Keep tool-specific logic local; don't introduce a tools-internal "framework" beyond what `types.ts` already provides.
- `web/` — WebFetch and its HTML rendering pipeline: `fetch.ts` → `html-tokenize.ts` → `html-render.ts` → `html-to-markdown.ts`, with the tool handler in `index.ts`.

## Tool-author contract

Every tool implements:

```ts
interface ToolHandler {
  name: string; // must match a TOOL_NAMES.* value if it's a built-in
  description: string;
  category: 'read-only' | 'write' | 'execute';
  definition: ToolDefinition; // JSON schema sent to the LLM
  execute(args, ctx?: ToolContext): Promise<ToolResult>;
}
```

Return-shape rules are documented in the `ToolResult` table in `types.ts` (the matrix is exhaustive — read it before adding a new flag combination). Key invariants:

- `success: true` never carries `softError`, `hardError`, or `skipCorrector`.
- `softError` ⇔ executor caught a `ToolResolutionError`; always paired with `skipCorrector: true`.
- `hardError` ⇔ executor caught any other exception. This is the only failure mode that bumps the consecutive-hard-error counter.
- `cwdAfter` is Bash-only.

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

- **Don't add tool-name string literals anywhere.** Use `TOOL_NAMES.*`. The const exists exactly so a typo becomes a compile error.
- **Don't fan-out reads of `ToolDefinition` shape** — every consumer should accept it as a JSON schema and not introspect its fields.
- **Don't put cross-cutting tool state on a module-level variable.** Per-tool state lives on the handler closure or in `ToolContext`; per-session state goes through the registry or `ToolLoopContext`.
