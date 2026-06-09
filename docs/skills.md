# Skills

Skills are reusable instruction sets packaged as markdown files. When invoked, a skill's body is injected into the model's context (or run in a forked sub-agent), letting you encapsulate workflows, conventions, and domain knowledge that the model can apply on demand.

---

## Directory layout

Skills must use the **directory-per-skill** layout. Flat `.md` files are not loaded — the loader emits a migration warning for them.

```
<scope-root>/
  <skill-name>/
    SKILL.md          ← required; frontmatter + instructions
    reference.md      ← optional supporting files
    templates/
    scripts/
```

---

## Scopes and precedence

Skills are loaded from up to four scopes. When two non-plugin skills share the same `name`, higher precedence wins:

```
Enterprise > Personal > Project
```

Plugin skills are namespaced (`<pluginName>:<skill-name>`) and never conflict with the three user scopes.

| Scope      | Root                                           | Set via                              |
| ---------- | ---------------------------------------------- | ------------------------------------ |
| Project    | `.factory/skills/` in `cwd`                    | checked in with the repo             |
| Personal   | `~/.factory/skills/`                           | your home directory                  |
| Enterprise | any directory                                  | `FACTORY_ENTERPRISE_SKILLS_DIR` env var or `agent.enterprise.skillsDir` in config |
| Plugin     | `<plugin.root>/skills/`                        | `agent.plugins[].root` in config     |

---

## Frontmatter reference

Every `SKILL.md` starts with a YAML frontmatter block delimited by `---`.

```yaml
---
name: deploy-staging
description: Deploy the current branch to the staging environment.
when_to_use: When the user asks to deploy, push to staging, or release a feature branch.
argument-hint: "<branch>"
arguments:
  - branch
allowed-tools:
  - Bash(git *)
  - Bash(kubectl *)
disallowed-tools:
  - AskUserQuestion
disable-model-invocation: false
user-invocable: true
model: claude-opus-4-7
effort: high
context: fork
agent: general-purpose
paths:
  - /home/ci
  - infra/
shell: bash
alwaysOn: false
---

Deploy `$branch` to staging …
```

### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | directory name | Kebab-case identifier (`[a-z0-9][a-z0-9:_-]*`). Used as the dedup key across scopes. |
| `description` | string | `""` | One-line summary shown in `/skills` and used by the model to decide when to invoke. |
| `when_to_use` | string | — | Extended hint appended to the catalog entry seen by the model (`whenToUse` also accepted). |
| `argument-hint` | string | — | Placeholder text shown in the `/skills` listing, e.g. `"<branch>"` (`argumentHint` also accepted). |
| `arguments` | string[] | `[]` | Named argument list. Maps positional tokens to `$name` variables. |
| `allowed-tools` | string[] | `[]` | Tools pre-authorized for the duration of this skill (`allowedTools` also accepted). Accepts the same pattern syntax as settings permissions (e.g. `Bash(git *)`). |
| `disallowed-tools` | string[] | `[]` | Tools hard-denied for the duration of this skill, overriding global allow-all (`disallowedTools` also accepted). |
| `disable-model-invocation` | bool | `false` | When `true`, the skill is hidden from the model's catalog and can only be invoked by the user manually via `/skill-name`. |
| `user-invocable` | bool | `true` | When `false`, the skill is hidden from user command listings but remains available for model-driven invocation. |
| `model` | string | session default | Override the model used when `context: fork`. |
| `effort` | `low` \| `medium` \| `high` | — | Effort hint passed to the sub-agent when `context: fork`. |
| `context` | `current` \| `fork` | `current` | `current` injects the skill body into the running conversation. `fork` runs it in an isolated sub-agent and returns the summary. |
| `agent` | string | — | Sub-agent type to use when `context: fork` (e.g. `Explore`, `general-purpose`). |
| `paths` | string[] | `[]` | Path restriction: skill is only invocable when `cwd` matches at least one pattern. Absolute patterns match as prefix; relative patterns match as a path segment. |
| `shell` | string | `sh` | Interpreter for shell injection blocks (e.g. `bash`, `zsh`). |
| `alwaysOn` | bool | `false` | When `true`, the skill body is inlined into every system prompt turn (`always-on` also accepted). No lazy loading — body is read at startup. |

---

## Argument substitution

Arguments passed after the skill name (e.g. `/deploy-staging main "my message"`) are available inside the skill body:

| Syntax | Expands to |
|---|---|
| `$ARGUMENTS` | Full raw argument string |
| `$ARGUMENTS[n]` | n-th positional token (0-indexed) |
| `$0` … `$9` | Positional tokens 0–9 |
| `$name` | Named argument (requires `arguments:` list) |

Named arguments map by position: the first entry in `arguments` binds `$name` to `$0`, the second to `$1`, etc.

---

## Shell injection

Skill bodies can embed live command output using `!` prefixed backtick syntax. Commands run at invocation time in the skill's `cwd`, not at load time.

**Inline:**
```
Current branch: !`git rev-parse --abbrev-ref HEAD`
```

**Block:**
````
Recent commits:
!```
git log --oneline -10
```
````

Commands have a **10-second timeout** and a **256 KB output cap**. Errors are replaced with `<error: …>` rather than aborting. Block injections are processed before inline ones.

Set `shell: bash` (or any interpreter) in frontmatter to override the default `sh`.

---

## Invocation

### Manual (slash command)

```
/skill-name
/skill-name arg1 arg2
/skill-name "quoted arg"
```

Arguments use shell-style quoting (single/double quotes, backslash escapes).

### Model-driven

The model sees a catalog of all skills where `disable-model-invocation` is not `true`. It calls `invoke_skill` automatically when the user's request matches. Add `when_to_use` to guide matching.

### Always-on

Skills with `alwaysOn: true` are injected verbatim into every system prompt — no invocation needed. Use sparingly; they consume context on every turn.

---

## Permission scoping

Tool permissions are active only while the skill is executing, then reverted:

- `allowed-tools` adds entries to the auto-allow list for the duration of the skill.
- `disallowed-tools` hard-denies tools for the duration, even if globally allowed.

---

## Fork context

When `context: fork`, the skill runs in an isolated sub-agent instead of the current conversation:

```yaml
context: fork
agent: Explore
model: claude-opus-4-7
effort: high
```

The sub-agent receives the rendered skill body as its task and returns a summary that is inserted back into the current turn. If no `runSubagent` implementation is wired (e.g. in headless mode), the skill falls back to current-context injection.

---

## Lazy loading

Only frontmatter is read at startup. The skill body is read from disk on first invocation and cached in memory for the rest of the session. `alwaysOn` skills are the exception — their bodies are loaded eagerly at startup.
