# ui/tui/slash — orientation

`/command` handlers. `dispatch.ts` is the single dispatcher; each command is a small function in this folder or, for the bigger families (rotate, keys, stats, hooks), its own file.

## Public entry

- `dispatchSlashCommand(cmd, arg, ctx)` (`dispatch.ts`) — called by `use-session-input.ts` when the user submits an input starting with `/`. Returns `true` if the command was recognized (consumed); even unknown commands return `true` and surface a notice rather than falling through to the agent.

## Files

- `dispatch.ts` — the dispatcher + the `SLASH_COMMANDS` table + `printHelp` + the small commands inlined as arrow functions. **Single-source contract:** `SLASH_COMMANDS: readonly SlashCommandSpec[]` is the only place command metadata lives; `HANDLERS` (the dispatch map) and `printHelp` (the `/help` output) are both derived from it. Adding a command is one entry; aliases live on the entry; the `description` field is the on/off switch for `/help` visibility (omit it for easter eggs).
- `rotate.ts`, `rotate-helpers.ts`, `rotate-subcommands.ts` — `/rotate` family. The biggest slash subtree because rotation has subcommands (`set`, `add`, `show`, `enable`, `disable`, `refresh`, `keys-on/off`, …).
- `keys.ts` — `/keys` (per-provider key listing / health snapshot).
- `stats.ts` — `/stats` (per-session cache hits, compaction events, largest tool results).
- `hooks.ts` — `/hooks` (active hook list, taken from `RunRefs.hooksConfig`).

## Adding a new slash command

1. Decide where the handler lives. Rule of thumb:
   - Small, no subcommands → inline in `dispatch.ts` next to peers.
   - Subcommands or > ~40 LOC → new file `slash/<name>.ts` exporting `dispatch<Name>(arg, agent)`.
2. Add **one** entry to `SLASH_COMMANDS` in `dispatch.ts`:
   ```ts
   { name: '/foo', argSpec: '<bar>', description: 'Do foo with bar', handler: handleFoo }
   ```
   `HANDLERS` and `/help` update automatically. Place the entry in the array at the position where you want it to render in `/help` (the array's order is the rendered order).
3. Aliases (extra dispatch-only names that resolve to the same handler) go in `aliases`. They appear alongside the canonical name in the synopsis but never need a separate entry.
4. Easter eggs: omit `description`. The command will still dispatch but won't appear in `/help`. The legacy "`/emoji` is in HANDLERS but not in printHelp by convention" footgun is now structural — `description` is the single switch.
5. If the command needs context the agent doesn't have (e.g. a picker dialog), thread it via `SlashCommandContext` (set in `Session.tsx` when the API is wired).

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

`/emoji` is registered without a `description`, so `SLASH_COMMANDS` exposes it to the dispatcher but `printHelp`'s filter (`spec.description !== undefined`) skips it. This is structural — there is no separate "hide this from /help" flag to forget; the absence of `description` IS the flag.

## Don't

- **Don't fire model calls from a slash command.** _Folklore:_ no mechanical check. Slash handlers mutate state, surface notices, or open dialogs. Anything that should trigger a turn goes through `agent.submitPrompt`. Candidate for an arch test forbidding `provider.chat` / `runAgent` imports inside `slash/**`.
- **Don't reach into `core/agent/` directly.** _Folklore:_ no mechanical check. Slash handlers talk to the runtime through `agent.refs.current` (`RunRefs`) and `AgentLoopApi` actions only. New behaviour the agent loop needs to know about should be a new action on `AgentLoopApi`. Same arch-test candidate as above.
