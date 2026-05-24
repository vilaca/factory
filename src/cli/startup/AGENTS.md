# cli/startup — orientation

Startup orchestration. Each `phase-*.ts` file is one phase of `main()` in `src/index.ts`; `phases.ts` is the barrel that re-exports them. The split exists so each phase is reviewable in isolation — there's no orchestration logic in `phases.ts` itself.

## Public entry

Imported from `src/index.ts`:

```ts
import {
  applyRotationPhase, // phase-rotation.ts
  resolveProvider, // phase-provider-selection.ts
  authenticateAndConnect, // phase-provider-connect.ts
  selectAndValidateModel, // phase-model-selection.ts
  installShutdownHandlers, // phase-runtime-lifecycle.ts
  gatherGitState, // phase-runtime-lifecycle.ts
  handleProjectTrust, // phase-trust-and-subagent.ts
  registerSubagentTool, // phase-trust-and-subagent.ts
} from './cli/startup/phases.js';
```

`buildExperimentalConfig` (`config.ts`) and the menu Ink component (`menu.tsx`) are also called from `src/index.ts`.

## Files

- `phases.ts` — barrel. The only public surface; importers depend on it.
- `phase-rotation.ts` — `applyRotationPhase`: parses `--rotate` + config + persisted state into the active rotation snapshot.
- `phase-provider-selection.ts` — `resolveProvider`: CLI flag → last session → first reachable. Returns `{ providerName, resumeModel, resumeKeyId }`.
- `phase-provider-connect.ts` — `authenticateAndConnect`: builds the Provider (with `prime()`), runs the auth flow per descriptor, returns `{ provider, availableModels, activeKeyId }`.
- `phase-model-selection.ts` — `selectAndValidateModel`: picks the model, validates tool support, decides `useTextToolFallback` and `validationMode`.
- `phase-runtime-lifecycle.ts` — `installShutdownHandlers`, `gatherGitState`. Process-shape concerns.
- `phase-trust-and-subagent.ts` — `handleProjectTrust` (gates project-config-driven MCP / hooks before they spawn), `registerSubagentTool` (Delegate tool, gated by `experimental.subagents`).
- `config.ts` — pure helpers: `buildExperimentalConfig`, source-of-truth helpers for which override (CLI vs config vs default) wins.
- `menu.tsx` — Ink-rendered startup picker.
- `parse-rotation.ts` — parser for the `--rotate <p:m,p:m>` chain syntax.

## Phase ordering

`main()` is intentionally linear. The order matters:

1. `parseArgs` — CLI flags.
2. `loadConfig` — global + project config (merged).
3. `applyRotationPhase` — overrides config in memory.
4. **Path/env policies are captured as locals** here, then threaded through `appOptions`. (Locals, not globals — every session sees them via `ToolContext` / `RunRefs`.)
5. `getLastSessionSelection` + `probeAllProviders` — what's reachable right now.
6. `resolveProvider` → `authenticateAndConnect` → `selectAndValidateModel` — provider/model picked and primed.
7. `buildSystemPrompt`.
8. `handleProjectTrust` — runs **before** any MCP server is spawned or project-declared hook is registered. The order is load-bearing: a hostile `.factory/config.json` would otherwise auto-spawn arbitrary commands the moment a user runs factory inside a cloned repo.
9. Tool registry, MCP, subagent, shutdown handlers, git state.
10. Dispatch to TUI or headless based on `isInteractiveTty`.

If you're reordering anything, re-derive the rationale from `src/index.ts` first — the linearity is intentional.

## Adding a startup phase

1. New file `cli/startup/phase-<name>.ts` exporting one or two functions.
2. Add them to the barrel in `phases.ts`.
3. Call them from `src/index.ts` in the right ordering slot (see "Phase ordering" above).
4. Phase functions should take their inputs as arguments and return their outputs explicitly — no module-level state, no implicit `await` of singletons. The shape of `phase-provider-connect.ts` (returns `{ provider, availableModels, activeKeyId }`) is the canonical pattern.

## Invariants enforced in `test/unit/arch/modularity.test.ts`

- The codebase has a hand-rolled CLI parser (`src/cli/args.ts`). Adding `commander`, `yargs`, `meow`, `minimist`, `arg`, `cmd-ts`, `sade`, `mri`, or `cac` to _any_ `src/` file fails an arch test. Phase files should hand-roll their own parsing if they take arg-shaped input (cf. `parse-rotation.ts`).
- `core/**` must not depend on `cli/**`. Startup phases can call into `core/`, but never the reverse.

## Don't

- **Don't smuggle phase logic into the barrel** (`phases.ts`). It's a re-export. Functions live in phase files.
- **Don't introduce module-level state in a phase file.** Each phase is a function. If it needs to remember something, it returns it; the caller (in `src/index.ts`) holds it as a local and threads it forward.
- **Don't call `process.exit` from a phase.** Phases throw or return errors; `src/index.ts`'s top-level `.catch` / `process.on('unhandledRejection')` handlers decide exit codes.
- **Don't reorder `handleProjectTrust` to run after MCP / hooks wiring.** It must precede them.
