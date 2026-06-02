# Plugin Architecture Refactor

This document captures the design decisions behind splitting factory into a **core** package and a set of **plugins**, organized as a monorepo.

---

## Motivation

The current codebase has an implicit layered structure but everything is wired together in a single package. The goal of this refactor is to make that structure explicit: a minimal, stable core that knows nothing about tools, UIs, or providers, and a set of independent plugins that implement all actual functionality.

---

## The Smallest Working Program

Core is three things that cannot be separated:

```
core = provider interface + agent loop + event bus plumbing
```

- **Provider interface** — the contract for sending messages and receiving streaming responses from an LLM. An abstraction, not an implementation.
- **Agent loop** — the turn driver: send → parse → execute → loop. It knows how to dispatch tool calls by name against whatever registry is passed in. If nothing registers any tools, the model can still have a conversation.
- **Event bus** — the plumbing that lets everything above core observe what is happening without core knowing who is listening.

Core owns no tools. Not even Read or Bash. Core owns no concrete provider. Core owns no UI.

### What core receives (inputs)

```ts
interface CoreOptions {
  provider: Provider          // who to call
  tools: ToolRegistry         // what tools are available (can be empty)
  systemPrompt: string        // composed by layers above before the loop starts
  conversation: Conversation  // initial history
  events: EventBus            // where to broadcast facts
}
```

Everything else — how the system prompt was built, which tools are registered, how security was applied — is none of core's business.

### What core emits on the event bus

```
turn:start
model:call:start
model:call:chunk      (streaming token)
model:call:end
tool:call:start       (name, args)
tool:call:end         (name, result)
turn:end              (stop reason)
error                 (anything unrecoverable)
```

No UI, no security, no logging — just facts. Every layer above subscribes to what it cares about.

### The boundary test

Core never imports from tools, security, UI, or concrete provider implementations. If you can build and run core with zero knowledge of Bash, Anthropic, or Ink, the boundary is right.

---

## Layered Architecture

The system is organized as layers. Each layer only talks to the layer directly below it, never skips.

```
┌─────────────────────────────────┐
│            UI layer             │  TUI, headless, slash commands
├─────────────────────────────────┤
│          Agent layer            │  turn loop, context, compaction
├─────────────────────────────────┤
│         Security layer          │  path jail, bash rules, permissions
├─────────────────────────────────┤
│          Tools layer            │  registry, execution, MCP adapter
├─────────────────────────────────┤
│        Provider layer           │  LLM abstraction, rotation, retry
└─────────────────────────────────┘
```

Layers own structure and enforce authority. A UI plugin cannot bypass security by calling a tool directly because the call would have to skip a layer, which the architecture does not allow.

### Layers vs. events

**Events** model what happens at runtime — they answer "when X occurs, who reacts?"

**Layers** model what depends on what — they answer "who is allowed to know about whom?"

Security is the clearest example: as an event subscriber it is just another listener racing to intercept. As a layer it is a hard architectural boundary — tools cannot execute without passing through it, by construction, not by convention.

### Cross-cutting concerns

Layers work well for vertical concerns (a thing that lives at one level). The harder case is a cross-cutting concern — something that needs to observe multiple layers simultaneously. Session logging is the clearest example: it wants to record provider calls, tool executions, permission decisions, and user input.

That is where the event bus earns its place — not as the primary architecture, but as a narrow escape hatch for observability. Observers can never affect behavior, they only watch.

```
layers  →  own structure, enforce authority, right model for 95% of concerns
events  →  read-only broadcast for cross-cutting observers only, never affect flow
```

---

## Where Plugins Fit

Plugins don't all live at the same level. Each plugin belongs to a specific layer and can only extend that layer's contract.

| Plugin | Layer | What it adds |
|---|---|---|
| provider-anthropic, provider-openai, … | Provider | Implements the `Provider` interface |
| filesystem, shell, web, delegate | Tools | Adds handlers to the tool registry |
| security | Security | Adds policies the security layer enforces |
| mcp | Tools | Adapts remote MCP tools into the registry |
| tui, headless | UI | Adds a rendering surface and slash commands |
| context-skills, session | Agent | Contributes to system prompt, logs turns |

---

## Security as a Plugin

Security is a constraint on other features, not a feature itself. It lives as **middleware** in the tool execution pipeline, running before the actual tool handler, able to short-circuit without ever calling through.

### Ordering

Security must run first. The solution is named pipeline phases that always execute in a fixed order — not a flat middleware chain where registration order is load-bearing:

```
tool:execute pipeline (always in this order):
  1. security phase     ← hard policy checks (path jail, bash deny list)
  2. permission phase   ← interactive approval, plan mode queueing
  3. transform phase    ← other plugins may wrap or modify the call
  4. execute phase      ← the actual tool handler
  5. result phase       ← broadcast result to observers
```

### Three distinct responsibilities

1. **Static policy check** — synchronous, no I/O. Bash deny list, path jail, env scrubbing. Deny immediately if violated.
2. **Interactive permission gate** — async. Has the user approved this tool? If not, pause and prompt. Requires a `requestApproval` capability injected by the host so security never knows whether it is running in TUI or headless mode.
3. **Audit trail** — fire-and-forget broadcast of every decision to the event bus.

### Slash commands

Slash commands are a UI concern. The core never sees them — they are intercepted before a prompt reaches the agent loop.

Plugins register slash commands at startup via a reducer: each plugin declares a list of `SlashCommand` descriptors, the UI folds them into a single dispatch table keyed by name. Conflicts (two plugins claiming the same name) are a hard error at startup — names are user-visible strings and silent shadowing would be a UX bug.

```ts
interface SlashCommand {
  name: string
  description: string        // shown in /help
  handler: (args: string, ctx: SlashContext) => SlashResult
}

interface SlashContext {
  conversation: ConversationHandle
  agentConfig: AgentConfigHandle
  session: SessionHandle
  display: DisplayHandle
}

type SlashResult =
  | { type: "handled" }
  | { type: "prompt"; text: string }   // forward as agent input
  | { type: "error"; message: string }
```

`/help` is driven by the same registry plugins write into — if `/help` is correct, the registry is correct.

---

## Code Duplication Policy

Many providers share the OpenAI-compatible API. The preference is **duplication over shared code between plugins**.

Shared code between plugins creates hidden coupling. If a common `openai-api-client` is extracted and both the OpenAI and Groq plugins depend on it, those two plugins are no longer independent. A change to the shared code affects both.

The duplication is the lesser evil:
- Each plugin can evolve independently
- Each plugin can be removed cleanly
- The shared HTTP + JSON shape is thin enough that the coupling cost exceeds the deduplication benefit

### Where to draw the line

| Thing | Verdict | Reason |
|---|---|---|
| HTTP calls to `/v1/chat/completions` | Duplicate | Belongs to each provider plugin |
| JSON schema for OpenAI message format | Duplicate | Each plugin owns its wire format |
| Streaming SSE parser | Duplicate | Each provider's stream has quirks |
| `Provider` interface | Core | It's the contract, not an implementation |
| Retry/backoff logic | Duplicate | Each provider has different rate limit behavior |
| `ToolResult` / `ToolCall` types | Core | Seam types, not provider-specific |

**The one exception:** test utilities. A shared mock server for the OpenAI API is reasonable in `devDependencies` — test infrastructure coupling is much cheaper than production coupling.

---

## Repository Structure

A standard monorepo with workspaces:

```
/
├── packages/
│   ├── core/                    # provider interface + agent loop + event bus
│   │   ├── src/
│   │   └── package.json
│   │
│   ├── plugins/
│   │   ├── anthropic/           # Anthropic provider
│   │   ├── openai/              # OpenAI provider
│   │   ├── ollama/              # Ollama provider
│   │   ├── groq/                # Groq provider
│   │   ├── filesystem/          # Read, Write, Edit, Glob, Grep
│   │   ├── shell/               # Bash
│   │   ├── web/                 # WebFetch + web helpers
│   │   ├── delegate/            # Subagent delegation
│   │   ├── mcp/                 # MCP adapter
│   │   ├── security/            # Path jail, bash rules, permissions
│   │   ├── session/             # Logging, stats
│   │   ├── tui/                 # Ink TUI, slash commands
│   │   └── headless/            # stdin/stdout UI
│   │
│   └── factory/                 # the assembled application
│       ├── src/
│       └── package.json
│
├── package.json                 # workspace root
└── tsconfig.base.json
```

### Workspace root `package.json`

```json
{
  "name": "factory-monorepo",
  "private": true,
  "workspaces": [
    "packages/core",
    "packages/plugins/*",
    "packages/factory"
  ]
}
```

### Package naming convention

```
@factory/core
@factory/plugin-anthropic
@factory/plugin-filesystem
@factory/plugin-shell
@factory/plugin-security
@factory/plugin-tui
...
```

An external author would publish `@their-name/factory-plugin-xyz` and it slots in at the `factory` assembly level without touching the monorepo.

### The role of `factory`

`factory` is the wiring package. It imports core and all plugins, composes them, and produces the runnable CLI. It is the only place where everything is allowed to meet — its entire job is assembly.

It makes the seam explicit: anyone building an external plugin can read `factory/src/index.ts` and see exactly how the application is assembled. It also means multiple assemblies are possible — `factory` ships the full product, a `factory-minimal` or test harness could wire only core + one provider + no tools.

### Do not create `packages/shared/`

A `shared` or `utils` package is where coupling hides. If two plugins need the same utility, duplicate it. If it truly belongs to the architecture, it belongs in `core`. The middle ground is a trap.

---

## Plugin Grouping: Domain, Not Type

Plugins are grouped by **feature/domain**, not by what kind of thing they are.

Type-based grouping (`tools-fs/`, `tools-shell/`) tells you what a plugin *is*, not what it is *for*. It creates artificial boundaries. `delegate` is a tool, but it also needs a provider, manages its own conversation, and has security implications — which type folder does it go in?

Domain grouping is more honest. `filesystem/` collects Read, Write, Edit, Glob, and Grep because they share a security surface (path jail), share test fixtures, and evolve together. `shell/` is alone not because it is a different type from filesystem tools, but because it has a completely different security story and a different evolution path. The domain boundary is meaningful.

### The test

When you need to change something, do you touch one directory or several? Domain grouping should usually mean one. Type grouping almost always means several.
