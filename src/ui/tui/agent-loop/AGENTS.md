# ui/tui/agent-loop — orientation

The React-hook orchestrator (`useAgentLoop`) and the pure helpers it delegates to. This is the seam between the TUI render layer and `core/agent/runAgent`. The hook owns the React state; the helpers own the work.

## Public entry

- `useAgentLoop(opts)` (`use-agent-loop.ts`) — returns `AgentLoopApi`. `Session.tsx` mounts exactly one of these per tab.
- `RunRefs` (`agent-loop-types.ts`) — mutable per-tab state that survives across renders. The source of truth for everything the runtime needs to know between turns (provider, model, conversation, key id, rotation snapshot, responses-chain pointer, plan mode, cwd, …).

## Files

- `use-agent-loop.ts` — the hook. Wires React state + actions + the run loop into `AgentLoopApi`. Tagged with a TODO to extract action handlers; if you're adding a new action and the file already feels large, consider extracting alongside that change rather than after.
- `agent-loop-types.ts` — `RunRefs`, `AgentLoopApi`, `AgentLoopDeps`, `UseAgentLoopOptions`, `PermissionRequestState`, `RunState`. Read this first when touching anything here.
- `init.ts` — pre-mount work: instantiate Conversation, PermissionManager, ContextManager, SessionLogger, FileCache, SkillsRegistry. Returns the seeded `RunRefs`.
- `setup.ts` — post-mount work: prime the provider, wire the responses-chain ref, install the rotation prompt bridge.
- `swap.ts` — `swapModel` / `swapProvider`. The only place that mints + primes a new Provider mid-session.
- `run-loop.ts` — `runAgentLoopInternal` + `processInput`. Drives one turn by pumping `runAgent`'s async generator into the event handler.
- `event-handler.ts` — `AgentEvent → state mutation`. One handler per event type; do not coalesce.
- `compose-system-prompt.ts` — per-turn system-prompt composition (project facts + tool list + skills + experimental flags). Pure.
- `compaction-resolver.ts` — picks the compaction-target provider/model for this turn (primary vs `RunRefs.compactionTarget`).
- `prime-context-window.ts` — async prime of `ContextManager.contextWindow` (e.g. ollama's `/api/show`).
- `history.ts` — prompt input-history stack. Pure.
- `git-state.ts` — branch + dirty refresh.

## Shared mutable state cheatsheet

When you're editing `use-agent-loop.ts` or its helpers, you'll see these names on `RunRefs`. They are explicit, not magic:

| Name                               | Mutated by                                                          | Read by                                                   |
| ---------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| `conversation`                     | every turn (append user / tool / assistant)                         | `runAgent`, compaction, context manager                   |
| `permissions`                      | user decisions, slash commands                                      | tool-call gate in `runAgent`                              |
| `provider`, `model`, `activeKeyId` | `swap*`, rotation hooks                                             | `callModel`, cache-boundary placement                     |
| `primary`                          | only user-driven swaps                                              | `/rotate refresh` (where to return after tier-2 rotation) |
| `rotation`                         | `/rotate` slash commands                                            | `callModel`'s rotation runtime                            |
| `responsesChain`                   | captured per turn by `runAgent`, cleared on swap/rotate/clear/abort | next call's input slice                                   |
| `planMode`                         | `/plan` toggle, `togglePlanMode` action                             | tool-call gate                                            |
| `cwd`                              | Bash `cd`, `/cwd` slash                                             | every tool execution + status bar                         |
| `compactionTarget`                 | `/compaction-model` slash                                           | `compaction-resolver.ts`                                  |

Don't introduce new ambient state at the hook level. If something needs to survive a render, put it on `RunRefs`.

## Why two `compaction-resolver.ts` files

There are two: `src/ui/agent-events/compaction-resolver.ts` (shared between headless + TUI) and `src/ui/tui/agent-loop/compaction-resolver.ts` (TUI-specific picker). This split is technical debt; if you touch either, consider whether they can be merged behind a single API.

## Invariants enforced in `test/unit/arch/modularity.test.ts`

Inherits everything in `ui/tui/AGENTS.md`. The two relevant ones to keep in mind while editing here:

- `RunRefs` is the seat of all cross-render mutable state. Don't shadow it with a `useRef`.
- Provider mint + capability read MUST be paired with `prime()` (cf880ed contract). `swap.ts` is the canonical site; if you mint a Provider elsewhere, route through `prime()`.

## Don't

- **Don't call `runAgent` directly from a component or slash command.** Route through `processInput` / `runAgentLoopInternal` so the event-handler wiring is consistent.
- **Don't mutate `RunRefs` from a React render.** Mutations happen in event handlers, action handlers, or post-render effects — never inside the render body.
- **Don't add per-turn config knobs to `useAgentLoop` signatures.** Add them to `UseAgentLoopOptions` (seeded from `appOptions` in `src/index.ts`) so they flow through the same plumbing as everything else.
- **Don't observe events by polling `RunRefs`.** New UI behavior on an `AgentEvent` belongs in `event-handler.ts`. New transient activity labels go through `setActivity` so the status bar surfaces them.
