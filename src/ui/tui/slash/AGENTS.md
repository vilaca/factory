# ui/tui/slash — orientation

`/command` handlers. `dispatch.ts` is the single dispatcher; each command is a small function in this folder or, for the bigger families (rotate, keys, stats, hooks), its own file.

## Public entry

- `dispatchSlashCommand(cmd, arg, ctx)` (`dispatch.ts`) — called by `use-session-input.ts` when the user submits an input starting with `/`. Returns `true` if the command was recognized (consumed); even unknown commands return `true` and surface a notice rather than falling through to the agent.

## Files

- `dispatch.ts` — the dispatcher + the `HANDLERS` record + `printHelp` + the small commands inlined as arrow functions. _Known drift point:_ `HANDLERS` and `printHelp` are two parallel structures, edited in lockstep today. The lift is to define a single `SLASH_COMMANDS` array (`{ name, aliases?, help?, handler }`) and derive both views from it; until that lands, both must be updated for every command.
- `rotate.ts`, `rotate-helpers.ts`, `rotate-subcommands.ts` — `/rotate` family. The biggest slash subtree because rotation has subcommands (`set`, `add`, `show`, `enable`, `disable`, `refresh`, `keys-on/off`, …).
- `keys.ts` — `/keys` (per-provider key listing / health snapshot).
- `stats.ts` — `/stats` (per-session cache hits, compaction events, largest tool results).
- `hooks.ts` — `/hooks` (active hook list, taken from `RunRefs.hooksConfig`).

## Adding a new slash command

1. Decide where the handler lives. Rule of thumb:
   - Small, no subcommands → inline in `dispatch.ts` next to peers.
   - Subcommands or > ~40 LOC → new file `slash/<name>.ts` exporting `dispatch<Name>(arg, agent)`.
2. Add an entry to `HANDLERS` in `dispatch.ts`.
3. Add a row to `printHelp` (also in `dispatch.ts`) so `/help` lists it. (Until the `SLASH_COMMANDS` table lift lands, this is two edits in lockstep.)
4. If the command needs context the agent doesn't have (e.g. a picker dialog), thread it via `SlashCommandContext` (set in `Session.tsx` when the API is wired).

## What `SlashCommandContext` carries

`dispatch.ts` builds the context once per session:

| Field                  | Set by         | Purpose                                                   |
| ---------------------- | -------------- | --------------------------------------------------------- |
| `agent`                | `useAgentLoop` | Read state, mutate refs, add notices                      |
| `exit`                 | Ink `useApp`   | Exit on `/exit`                                           |
| `tabs`                 | `useTabs`      | Multi-tab commands (`/new`, `/close`, `/tabs`, `/switch`) |
| `openPicker`           | `Session.tsx`  | `/pick` and Ctrl+K                                        |
| `toggleFullOutput`     | `Session.tsx`  | `/full`                                                   |
| `openCompactionPicker` | `Session.tsx`  | `/compaction-model`                                       |

Headless / test contexts can omit the optional ones; the handlers print a "not available" notice instead.

## Easter eggs

`/emoji` is registered in `HANDLERS` but absent from `printHelp` — intentional, so `/help` doesn't list it.

## Don't

- **Don't fire model calls from a slash command.** _Folklore:_ no mechanical check. Slash handlers mutate state, surface notices, or open dialogs. Anything that should trigger a turn goes through `agent.submitPrompt`. Candidate for an arch test forbidding `provider.chat` / `runAgent` imports inside `slash/**`.
- **Don't reach into `core/agent/` directly.** _Folklore:_ no mechanical check. Slash handlers talk to the runtime through `agent.refs.current` (`RunRefs`) and `AgentLoopApi` actions only. New behaviour the agent loop needs to know about should be a new action on `AgentLoopApi`. Same arch-test candidate as above.
