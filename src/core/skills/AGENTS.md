# core/skills — orientation

User-authored "skills": markdown files with YAML frontmatter that get injected into the system prompt either always (`alwaysOn: true`) or when their `triggers` regex matches the latest user turn or the recently-used tool list.

## Public entry

- `loadSkills(cwd)` (`loader.ts`) — reads `~/.factory/skills/*.md` (global) + `<cwd>/.factory/skills/*.md` (project), returns `{ skills, warnings }`. Project skills override global skills that share the same `name`.
- `Skill` interface (`loader.ts`) — `{ name, description, alwaysOn, triggers, triggerRegexes, tools, body, sourcePath, scope }`.
- `matchSkills(skills, ctx)` (`matcher.ts`) — per-turn filter: returns the subset whose `triggers` match the latest user input or whose `tools` overlap the recently-used tool list.
- `index.ts` — barrel + the `SkillsRegistry` wrapper used by the session bootstrap.

## Files

- `index.ts` — `SkillsRegistry`: cached load + per-turn match API.
- `loader.ts` — file discovery, frontmatter split, custom YAML-ish parser, schema validation.
- `matcher.ts` — small per-turn matcher (regex against user input, set intersection against tools).

## Skill file format

A skill is a markdown file with YAML frontmatter:

```md
---
name: kebab-case-name
description: One-line summary surfaced in `/skills`.
alwaysOn: false
triggers:
  - 'regex pattern'
  - 'another pattern'
tools:
  - Bash
  - Edit
---

Body in markdown. Injected verbatim into the system prompt when matched.
```

Schema rules enforced in `parseSkillFile`:

- `name` — required, must match `/^[a-z0-9][a-z0-9-]*$/`. Used as the dedupe key (project overrides global by `name`).
- `description` — required string.
- `alwaysOn` — boolean, defaults to `false`. When true, the skill is injected every turn regardless of `triggers` / `tools`.
- `triggers` — array of regex strings (case-insensitive). Compiled at load time into `triggerRegexes`; an invalid pattern fails loading of that file (becomes a warning).
- `tools` — array of tool name strings. When non-empty, the skill is injected only when one of the named tools was used recently.

## Load-bearing details

- **Custom YAML parser, intentional.** `parseFrontmatter` is hand-rolled (~50 LOC) because the schema is small: scalars, booleans, string arrays (block or inline). The custom parser keeps the runtime dependency surface small and the error messages targeted. **Don't add `js-yaml` / `yaml` as a dependency** to "modernize" this — the parser is the size it is because we control the grammar.
- **Project shadows global by `name`, not by file path.** Two skills with the same `name` collapse to the project one. This is the only way users can override a packaged skill without editing global state.
- **Triggers are compiled once at load.** `triggerRegexes` is populated in `parseSkillFile`. The per-turn matcher in `matcher.ts` reuses them so a hot loop of turns doesn't recompile N regexes per skill.
- **Malformed files become warnings, not exceptions.** One bad skill file shouldn't kill startup. `loadSkillsFromDir` accumulates errors into the `warnings` array; the caller surfaces them via the session log.
- **`triggerRegexes` is optional on the `Skill` interface** so test fixtures can omit it; production code always populates it via `parseSkillFile`. If you read `triggerRegexes` from a non-test path, treat its absence as "no triggers", not as an error.

## Adding a new frontmatter field

1. Extend the `Skill` interface in `loader.ts`.
2. Add parsing + validation in `parseSkillFile`. Defaults go here, not in the caller.
3. If the field affects matching, update `matchSkills` in `matcher.ts`. If it affects injection shape, update the system-prompt composer in `ui/tui/agent-loop/compose-system-prompt.ts`.
4. Update the example block at the top of this file.

## Don't

- **Don't add a YAML library dependency.** _Folklore:_ no mechanical check. The hand-rolled parser is intentional — the schema is small enough that an off-the-shelf parser is mostly liability (broader grammar accepted than we promise, larger error surface). Extend `parseFrontmatter` if you need a new scalar shape.
- **Don't compile trigger regexes on the matcher path.** _Folklore:_ no mechanical check. Compilation happens once in `parseSkillFile`; the matcher reads `triggerRegexes` only. Re-compiling per turn costs O(skills × turns).
- **Don't throw on a malformed skill file.** _Folklore:_ no mechanical check. The convention is "skip + warn" so one user-authored typo doesn't break the session. Errors land in the returned `warnings` array.
- **Don't bypass project-shadows-global.** _Folklore:_ no mechanical check. The `Map` in `loadSkills` is keyed by `name`; ordering (globals first, then project) is what makes the override work.
