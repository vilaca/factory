# core/skills — orientation

User-authored "skills": markdown files with YAML frontmatter that are injected into the model's context either always (`alwaysOn: true`) or on demand via model-driven or manual invocation.

## Public entry

- `loadSkills(cwd, config?)` (`loader.ts`) — reads `~/.factory/skills/*/SKILL.md` (personal) and `<cwd>/.factory/skills/*/SKILL.md` (project), plus optional enterprise and plugin scopes. Returns `{ skills, warnings }`. Higher-priority scopes override lower-priority skills by `name`.
- `Skill` interface (`loader.ts`) — metadata-only record: see below.
- `loadSkillBody(skill)` (`loader.ts`) — lazily reads and caches the body of a skill. Safe to call multiple times.
- `invokeSkill(name, args, ctx)` (`invoke.ts`) — orchestrates lookup → path check → body load → render → permission scope → inject or fork.
- `index.ts` — barrel + `SkillsRegistry` wrapper used by the session bootstrap.

## Files

| File             | Responsibility                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `index.ts`       | `SkillsRegistry`: cached load + catalog/alwaysOn section API.                                               |
| `loader.ts`      | File discovery, frontmatter split, custom YAML parser, schema validation, lazy body loading.                |
| `invoke.ts`      | Invocation orchestrator: lookup, path gating, body load, render, permission push/pop, inject or fork.       |
| `render.ts`      | Argument substitution (`$ARGUMENTS`, `$0..$9`, named) and shell injection (`` !`cmd` ``, ` !```block``` `). |
| `permissions.ts` | `pushSkillScope` — stack-based allowed/disallowed tool permission frame.                                    |
| `scopes.ts`      | `resolveScopes` — builds the ordered list of scope roots from cwd, home, env, and config.                   |

## Skill interface (`loader.ts`)

```ts
interface Skill {
  name: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  argumentNames: string[];
  allowedTools: string[];
  disallowedTools: string[];
  disableModelInvocation: boolean;
  userInvocable: boolean;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  context: 'current' | 'fork';
  agent?: string;
  paths: string[];
  shell?: string;
  alwaysOn: boolean;
  scope: 'enterprise' | 'personal' | 'project' | 'plugin';
  pluginName?: string;
  sourceDir: string; // absolute path to the skill directory
  metadataOnly: boolean;
  body?: string; // populated by loadSkillBody()
}
```

## Skill file format

```md
---
name: kebab-case-name
description: One-line summary surfaced in the model catalog and /skills.
when_to_use: Extended hint for model invocation decisions.
argument-hint: '<arg>'
arguments:
  - branch
allowed-tools:
  - Bash(git *)
disallowed-tools:
  - AskUserQuestion
disable-model-invocation: false
user-invocable: true
model: claude-opus-4-7
effort: high
context: fork
agent: Explore
paths:
  - /home/ci
  - infra/
shell: bash
alwaysOn: false
---

Skill body. Injected verbatim when invoked. Argument substitution and
shell injection (!\`cmd\`) are processed at invocation time.
```

## Invocation model (model-driven)

Activation is **model-driven**: `SkillsRegistry.catalogSection()` injects a short catalog into the system prompt listing every skill where `disableModelInvocation` is false. The model calls the `invoke_skill` tool when the user's request matches; the tool dispatches to `invokeSkill()`. There is no regex-trigger path — the deprecated `evaluate()` and `formatInjection()` stubs on `SkillsRegistry` exist only to avoid crashes during the transition and always return empty results.

## Load-bearing details

- **Directory-per-skill layout only.** Flat `.md` files under a scope root are detected by `findLegacyFlatSkills` and produce a migration warning; they are not loaded.
- **Custom YAML parser, intentional.** `parseFrontmatter` is hand-rolled. The schema is small (scalars, booleans, string arrays). **Don't add `js-yaml` / `yaml`** — the parser is intentionally constrained to the grammar we own.
- **Precedence: project → personal → enterprise.** Scopes are loaded in that order; each scope's `Map.set()` overwrites the previous for the same `name`. Plugin skills are namespaced `<pluginName>:<skill>` and never overwrite user scopes.
- **Lazy body loading.** `loadSkillMetadata` discards the body; `loadSkillBody` reads and caches it on first call. `alwaysOn` skills are the exception — `alwaysOnSection()` requires the body at startup.
- **Malformed files become warnings, not exceptions.** One bad `SKILL.md` does not abort startup. Errors accumulate in the `warnings` array returned from `loadSkills`.

## Adding a new frontmatter field

1. Extend the `Skill` interface in `loader.ts`.
2. Add parsing + validation in `parseSkillFields`. Defaults go here, not in the caller.
3. If the field affects invocation shape, update `invoke.ts` or `render.ts`.
4. If it affects system-prompt injection, update `SkillsRegistry.catalogSection()` or `alwaysOnSection()` in `index.ts`.
5. Update the field reference in `docs/skills.md`.

## Don't

- **Don't add a YAML library dependency.** The hand-rolled parser covers our grammar exactly. Extend `parseFrontmatter` for new scalar shapes.
- **Don't compile regexes on the invoke path.** No regex-trigger path exists; don't re-introduce one.
- **Don't throw on a malformed skill file.** Convention: skip + warn. Errors land in the `warnings` array.
- **Don't bypass project-shadows-global.** The `Map` in `loadSkills` keyed by `name` with project loaded first, enterprise last, is what makes precedence work.
