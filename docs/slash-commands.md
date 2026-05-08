# Slash commands

Slash commands are typed at the prompt and run synchronously — they don't go to the model. Most affect the current tab; `/new`, `/close`, `/switch`, `/tabs` operate on the tab registry.

| Command                 | Description |
| ----------------------- | ----------- |
| `/help`                 | Show available commands and hotkeys |
| `/new [<label>]`        | Open a new tab |
| `/close`                | Close the active tab |
| `/tabs`                 | List open tabs |
| `/switch <n\|label>`    | Switch to a tab by index, label, or unique prefix |
| `/clear`                | Clear conversation history |
| `/model [<name>]`       | Show current provider/model, or switch (accepts `<provider>:<model>` to switch both) |
| `/pick`                 | Open the provider/model picker (recent pairs first) |
| `/rotate`               | View the active rotation chain. Subcommands: `add`, `insert`, `remove`, `move`, `clear`, `refresh` (return to the head of the chain and reset the in-memory failure log) |
| `/keys [<provider>]`    | Show saved keys with usage / rate-limit / cache-hit counters |
| `/stats`                | Cache hit rate, compaction events, and largest tool results for the current session |
| `/full`                 | Show full Read output in the terminal instead of the 5-line preview (applies going forward; the model always sees the full text either way) |
| `/cwd [<dir>]`          | Show or change the active tab's working directory |
| `/permissions`          | Reset tool permissions |
| `/plan`                 | Toggle plan mode or show queued plan |
| `/queue`                | Show the queued plan |
| `/approve` (or `y`)     | Execute the queued plan |
| `/cancel` (or `n`)      | Drop the queued plan |
| `/log`                  | Show current session log path |
| `/correct on\|off`      | Toggle LLM tool-call corrector |
| `/exp [<name> on\|off]` | List or toggle experimental flags |
| `/skills`               | List loaded skills (when `skills` flag is on) |
| `/skill <name>`         | Print the body of a specific skill |
| `/exit`, `/quit`, `/q`  | Exit (or close the active tab if multiple are open) |

## /rotate subcommands

- `/rotate` — show the active chain.
- `/rotate add <provider:model>` — append to the end.
- `/rotate insert <pos> <provider:model>` — insert at position N (1-indexed).
- `/rotate remove <pos>` — drop entry at position N.
- `/rotate move <from> <to>` — reorder.
- `/rotate clear` — reset to empty.
- `/rotate refresh` — return to the head of the chain and clear the in-memory failure log (use after fixing a failing key/provider out-of-band).

`/rotate --default` operates on the default chain (used when no per-(provider, model) override applies). `/rotate --for <provider:model>` scopes to a specific override.

## /exp flags

`/exp` lists every experimental flag and its current state. Toggle one with `/exp <name> on` or `/exp <name> off`. The persisted version is in `~/.factory/config.json`; toggling at runtime is session-only unless you re-launch with the corresponding `--<flag>` CLI flag.
