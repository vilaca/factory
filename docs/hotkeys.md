# Hotkeys

Keybindings are grouped by what they affect. Bindings are **not** customizable — the table is exhaustive.

## Tabs

Each tab is an independent agent (own conversation, working directory, provider, model). See [the README](../README.md#why-factory) for the multi-tab model.

| Key                 | Action |
| ------------------- | ------ |
| `Ctrl+T`            | New tab |
| `Ctrl+W`            | Close the active tab (exits the app if it's the last) |
| `Ctrl+N` / `Ctrl+P` | Cycle to the next / previous tab |
| `F1`–`F12`          | Jump directly to tab N |

## Provider / model

| Key                 | Action |
| ------------------- | ------ |
| `Ctrl+K`            | Open the provider/model picker (recent pairs first) |

The picker is the same one shown on first launch and via `--pick` / `/pick`.

## Run control

| Key                 | Action |
| ------------------- | ------ |
| `Esc`               | Abort the current agent run |
| `Ctrl+C`            | Abort the running turn, or exit when idle. Press twice in quick succession to force-exit. |

`Ctrl+C` is context-sensitive: with a turn in flight it interrupts; otherwise it exits the application.

## Prompt input

| Key                 | Action |
| ------------------- | ------ |
| `↑` / `↓`           | Recall the previous / next prompt from history |

## Customization

Hotkeys are not user-configurable. If a binding clashes with your terminal or a multiplexer (e.g. `Ctrl+W` in tmux's prefix sequence), the workaround is to rebind on the terminal side — `factory` doesn't read a keymap config.
