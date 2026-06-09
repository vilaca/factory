# High-Level Implementation Spec: Skills Framework for Agents

## 1. Purpose

Implement a reusable **Skills Framework** that extends an agent's capabilities through modular, discoverable, and composable skills.

Skills encapsulate domain knowledge, workflows, automation procedures, and tool-enabled behaviors that can be invoked manually or automatically based on user intent.

---

## 2. Goals

### Primary Goals

- Allow users and organizations to package reusable instructions as skills.
- Enable automatic skill discovery and invocation.
- Support task-oriented workflows and knowledge-oriented reference content.
- Reduce prompt duplication by loading skill content only when needed.
- Support extensibility through scripts, templates, plugins, agents, and supporting files.

### Non-Goals

- Replace core commands.
- Replace permission systems.
- Act as a general plugin framework (though plugins may distribute skills).

---

# 3. Core Concepts

## Skill

A skill is a directory containing a required `SKILL.md` file and optional supporting assets.

```text
skill-name/
├── SKILL.md
├── reference.md
├── examples/
├── templates/
└── scripts/
```

`SKILL.md` serves as the entry point and contains metadata plus executable instructions. Supporting files are loaded only when needed.

---

## Skill Types

### Reference Skills

Provide reusable knowledge, conventions, style guides, and best practices.

Examples:

- API standards
- Coding conventions
- Architecture guidance

### Task Skills

Provide procedural workflows.

Examples:

- Deploy application
- Generate reports
- Create release notes
- Review pull requests

Task skills may be manual-only.

---

# 4. Skill Discovery Model

## Discovery Sources

Skills may be loaded from:

| Scope      | Location              |
| ---------- | --------------------- |
| Enterprise | Managed configuration |
| Personal   | `~/.agent/skills/`    |
| Project    | `.agent/skills/`      |
| Plugin     | `<plugin>/skills/`    |

### Precedence

```text
Enterprise > Personal > Project
```

Plugin skills are namespaced and do not conflict.

---

## Automatic Discovery

The system must:

1. Scan configured skill directories.
2. Watch for skill changes during runtime.
3. Discover nested skills within active workspaces.
4. Load only metadata initially.
5. Load full skill content on invocation.

---

# 5. Skill Metadata Schema

Each skill supports YAML frontmatter.

## Required

No strictly required fields.

## Recommended

```yaml
description:
```

Used for matching user intent and automatic activation.

---

## Supported Metadata

```yaml
name:
description:
when_to_use:
argument-hint:
arguments:
disable-model-invocation:
user-invocable:
allowed-tools:
disallowed-tools:
model:
effort:
context:
agent:
hooks:
paths:
shell:
```

Capabilities include:

- Invocation control
- Tool permissions
- Agent selection
- Argument mapping
- Path restrictions
- Runtime configuration

---

# 6. Invocation Model

## Manual Invocation

Users invoke a skill via:

```text
/skill-name
```

Optional arguments:

```text
/deploy production
```

Arguments become available to the skill runtime.

---

## Automatic Invocation

The agent may automatically activate a skill when:

- User intent matches the skill description.
- Path restrictions are satisfied.
- The skill is not marked as disabled for model invocation.

---

# 7. Skill Execution Lifecycle

### Phase 1 — Discovery

Load metadata only.

### Phase 2 — Selection

Determine skill relevance.

### Phase 3 — Context Rendering

Render:

- Frontmatter
- Markdown instructions
- Variable substitutions
- Dynamic command outputs

### Phase 4 — Execution

Execute in:

- Current context
- Forked sub-agent context

### Phase 5 — Persistence

Keep rendered skill content available throughout the session until compaction or removal.

---

# 8. Argument System

Support positional arguments:

```text
$ARGUMENTS
$ARGUMENTS[0]
$0
```

Support named parameters:

```yaml
arguments:
  - issue
  - branch
```

Usage:

```text
$issue
$branch
```

The skill runtime performs substitution before execution.

---

# 9. Dynamic Context Injection

Skills may embed shell commands:

```text
!`git diff HEAD`
```

Execution flow:

1. Run command.
2. Capture output.
3. Replace placeholder.
4. Pass rendered result to the agent.

Support:

- Inline commands
- Multi-line shell blocks

Provide an administrative option to disable shell execution globally.

---

# 10. Sub-Agent Execution

Skills may execute in isolated contexts.

Example:

```yaml
context: fork
agent: Explore
```

### Behavior

1. Create isolated execution context.
2. Load skill instructions.
3. Execute using the selected agent.
4. Return a summarized result.

Supported agents:

- Explore
- Plan
- General Purpose
- Custom agents

This enables research, planning, auditing, and analysis workflows.

---

# 11. Permission Model

## Allowed Tools

Skills may pre-authorize tool usage:

```yaml
allowed-tools:
  - Bash(git *)
```

## Disallowed Tools

Skills may temporarily remove tool access:

```yaml
disallowed-tools:
  - AskUserQuestion
```

Restrictions apply only while the skill is active.

---

# 12. Visibility Controls

## User Only

```yaml
disable-model-invocation: true
```

Manual invocation only.

## Agent Only

```yaml
user-invocable: false
```

Hidden from user command menus but available for automatic agent invocation.

## Fully Available

Default behavior.

---

# 13. Supporting Assets

Skills may include:

- Templates
- Examples
- Documentation
- Scripts
- Reference data

### Design Requirements

- Keep `SKILL.md` concise.
- Load large reference material lazily.

---

# 14. Plugin & Distribution Support

Skills should be distributable through:

1. Project repositories
2. Personal libraries
3. Enterprise configuration
4. Plugin packages

Plugins may bundle:

- Skills
- Agents
- Hooks
- MCP integrations

Namespaces prevent collisions.

---

# 15. Operational Requirements

## Live Reload

The system must detect:

- Skill creation
- Skill updates
- Skill removal

without restarting the session.

---

## Context Efficiency

Only metadata is loaded globally.

Full content loads:

- On invocation
- On automatic activation

Supporting files remain unloaded until referenced.

---

# 16. Example Use Cases

### Engineering

- Code review
- Deployments
- Git workflows
- PR summaries

### Operations

- Release management
- Incident triage

### Research

- Deep codebase exploration
- Architecture analysis

### Visualization

- Generate HTML reports
- Codebase explorers
- Dependency graphs

### Organizational Knowledge

- Coding standards
- API guidelines
- Security policies

---

# 17. Success Criteria

A successful implementation should:

1. Support modular skill packaging.
2. Enable automatic and manual invocation.
3. Provide safe permission boundaries.
4. Support sub-agent execution.
5. Allow dynamic runtime context injection.
6. Scale from personal workflows to enterprise distribution.
7. Minimize context overhead through lazy loading.
