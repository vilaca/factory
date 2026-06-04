# ui/tui/agent-loop — orientation

The React-hook orchestrator (`useAgentLoop`) and the pure helpers it delegates to. This is the seam between the TUI render layer and `core/agent/runAgent`. The hook owns the React state; the helpers own the work.

## Getting Started

New to this module? Start here:
1. Read `agent-loop-types.ts` to understand `RunRefs` (the shared state shape)
2. Look at `use-agent-loop.ts` to see how React state connects to the agent loop
3. Check `run-loop.ts` to see how turns are driven
4. Browse tests in `test/unit/ui/tui/agent-loop/` for usage examples

## Public entry

- `useAgentLoop(opts)` (`use-agent-loop.ts`) — returns `AgentLoopApi`. `Session.tsx` mounts exactly one of these per tab.
- `RunRefs` (`agent-loop-types.ts`) — mutable per-tab state that survives across renders. The source of truth for everything the runtime needs to know between turns (provider, model, conversation, key id, rotation snapshot, responses-chain pointer, plan mode, cwd, …).

## Files

- `use-agent-loop.ts` — the hook. Wires React state + actions + the run loop into `AgentLoopApi`.
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

## Data Flow

```
Session.tsx (mounts hook)
  ↓
use-agent-loop.ts (React state + actions)
  ↓
init.ts → setup.ts (bootstrap sequence)
  ↓
run-loop.ts → event-handler.ts (turn execution → mutation sink)
  │
  ├─ swap.ts (provider/model changes, independent path)
  └─ prime-context-window.ts (async context window updates, mount/swap-time)
```

Key state containers:
- `RunRefs` (mutable, survives renders) — the source of truth
- React state (ephemeral, per-render) — derived from RunRefs events
- `event-handler.ts` — the sole mutation sink for AgentEvents

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

If something needs to survive a render, put it on `RunRefs`, not on a fresh `useRef` or `useState`. Re-deriving from `RunRefs` is fine; mirroring is not.

## Why two `compaction-resolver.ts` files

There are two: `src/ui/agent-events/compaction-resolver.ts` (shared between headless + TUI) and `src/ui/tui/agent-loop/compaction-resolver.ts` (TUI-specific picker). The split is a known seam — the shared file holds the pure resolution logic, the TUI file holds the picker wiring. A future cleanup can unify them behind one API.

## Invariants enforced in `test/unit/arch/modularity.test.ts`

Inherits everything in `ui/tui/AGENTS.md`. The most relevant rule when editing here:

- Provider mint + capability read MUST be paired with `prime()` — _enforced by arch test_ (cf880ed contract). `swap.ts` is the canonical site; if you mint a Provider elsewhere, route through `prime()`.

## Tests

Unit tests live in `test/unit/ui/tui/agent-loop/`:
- `event-handler.test.ts` — event → state mutation wiring
- `swap.test.ts` — provider/model swap flows
- `event-handler-activity.test.ts` — activity label transitions
- `prime-context-window.test.ts` — context-window priming
- `rotation-wrap.test.ts` — rotation prompt integration

## Initialization Sequence

```
1. Session.tsx mounts useAgentLoop(opts)
2. useAgentLoop calls init.ts functions to create RunRefs
3. setup.ts runs mount-time wiring (session logger, skills, hooks)
4. prime-context-window.ts async primes ContextManager.contextWindow
5. Hook returns AgentLoopApi to Session.tsx
```

## Don't

- **Don't call `runAgent` directly from a component or slash command.** _Folklore:_ no mechanical check. Route through `processInput` / `runAgentLoopInternal` so the event-handler wiring is consistent. Candidate for an arch test forbidding `runAgent` imports outside `agent-loop/run-loop.ts`.
- **Don't mutate `RunRefs` from a React render.** _Folklore:_ no mechanical check — TypeScript permits it. Mutations happen in event handlers, action handlers, or post-render effects, never inside the render body. The next regression on this is a hint that a lint rule on `RunRefs` writes inside render bodies would be worth the cost.
- **Don't observe events by polling `RunRefs`.** _Folklore:_ no mechanical check. New UI behaviour on an `AgentEvent` belongs in `event-handler.ts`. New transient activity labels go through `setActivity` so the status bar surfaces them.
