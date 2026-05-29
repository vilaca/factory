# 🏭 MVP Plan — Plugin-based "Worse is Better" Rebuild

> Companion to [`IDEAS.md`](IDEAS.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md).
> `IDEAS.md` is the feature wishlist; `ARCHITECTURE.md` describes the
> current 31k-LOC `src/` tree; this document is the path from one to the
> other through a minimal core and a plugin API.

## Intent

The codebase grew to ~31k LOC across 207 TypeScript files. Maintainability
suffers; the value-per-LOC of new work drops. Apply Richard Gabriel's "worse
is better" philosophy: ship a small core that does **basic chat + tool
calling for all providers** and **nothing else**, and make every other
feature — current and planned — a plugin.

The same `register(api)` API drives in-tree builtins and third-party
packages. No two-tier "real code vs plugins" split.

## Locked decisions

| #   | Decision                 | Choice                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where the new code lives | New repository (greenfield). The current `factory-code` repo stays at v0 as the reference for porting and continues to serve existing users until the new repo reaches parity. Nothing is migrated; ports reference the v0 tree by path.                                                                                                                                                |
| 2   | TUI substrate            | Minimal Ink in core. Includes: input + transcript + abort + status segments + picker + slash dispatcher. Heavy TUI features (tabs, plan-approval, rotation prompt, task ledger, cost footer) become renderer plugins.                                                                                                                                                                   |
| 3   | Provider scope in core   | Three anchors only: **OpenAI-compat** (handles Cerebras / Groq / Mistral / OpenRouter / Vercel / WorkersAI / LlamaCpp via base-URL config) + **Anthropic** + **Ollama**. The other ~10 providers (Copilot, GoogleAIStudio, HuggingFace, Cohere, OpenCodeZen, Codestral, Mistral-native, OpenAI-native, etc.) ship as separate first-party plugin packages (`@factory/provider-<name>`). |

## Architecture: three primitives

The plugin API is intentionally narrow. Everything composes from:

### 1. Registries

Plugins register contributions into named collections. Eight registry kinds
in v1:

| Registry           | Holds                                                                                                   | Used by                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `api.tools`        | `ToolHandler`                                                                                           | Tool plugins (Read, Write, MCP-sourced tools)                                                                                     |
| `api.providers`    | `Provider` + `ProviderDescriptor` (label, aliases, env vars, auth flow, prompt headers) + `AuthHandler` | Provider plugins (drive picker UX)                                                                                                |
| `api.commands`     | Slash command handler                                                                                   | Command plugins (`/help`, `/cost`, `/restore`)                                                                                    |
| `api.systemPrompt` | `SystemPromptContributor` (priority + optional `when` predicate + static text or `(ctx) => string`)     | Prompt-section plugins (AGENTS.md loader, memory injector, **provider-specific guidance**, reliability prompts, scope discipline) |
| `api.transports`   | Entry-point handler                                                                                     | Transport plugins (TUI, headless, ACP, eval)                                                                                      |
| `api.workflows`    | Multi-step interview script                                                                             | Workflow plugins (`/spec`, `/plan`, `/build`)                                                                                     |
| `api.memory`       | Memory backend with read/write/match                                                                    | Memory backend plugins (scoped persistent memory)                                                                                 |
| `api.sandboxes`    | Execution-isolation backend                                                                             | Sandbox plugins (Docker, bwrap, BYO)                                                                                              |

Registries are append-only during plugin `register()`. After all plugins
load, `api.freeze()` locks them for the session.

`api.systemPrompt` accepts a `SystemPromptContributor` shape that supports
conditional sections — each section can declare a `when` predicate that
filters by provider, model, or model tier:

```ts
interface SystemPromptContributor {
  /** Higher = earlier in the final prompt. Default 100. */
  priority?: number;
  /** Optional filter — section is included only when this returns true. */
  when?: (ctx: PromptContext) => boolean;
  /** Static text or a function that produces the section's text per turn. */
  contribute: string | ((ctx: PromptContext) => string | null);
}
interface PromptContext {
  provider: string;
  model: string;
  modelTier: 'strong' | 'medium' | 'weak';
  cwd: string;
}
```

This is the mechanism every provider plugin uses to ship its own
suggested system prompt (XML-heavy for Anthropic, minimal for reasoning
models, aggressively-nudging for small local models). Provider plugins
register a section gated by `when: ctx => ctx.provider === 'anthropic'`
(typically with high priority so it sorts ahead of generic guidance) and
can branch on `ctx.modelTier` for tier-specific variants. Same mechanism
also drives the reliability stack's prompts, AGENTS.md / CLAUDE.md
loaders, scoped memory, lifecycle-phase nudges, etc.

### 2. Hook bus

Ten named lifecycle events, four chain semantics. Two events
(`on-stream-chunk`, `after-parse-response`) and one semantics
(`VetoOrTransform`) exist specifically to host the small-model
reliability stack — see the dedicated section below.

| Event                  | Semantics                          | Used by                                                                                    |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `before-turn`          | TransformHandler\<TurnInput\>      | Compaction, memory injection, prompt assembly                                              |
| `after-turn`           | SubscribeHandler\<TurnResult\>     | Snapshots, telemetry, task-ledger sync, auto-retry, empty-turn warning                     |
| `before-tool-call`     | VetoOrTransform\<ToolCall\>        | Permission gates, MCP hash check, security, tool-call corrector, step enforcer, bash-dedup |
| `after-tool-call`      | TransformHandler\<ToolResult\>     | DLP redact, prompt-inject validate, LSP, lint, auto-format                                 |
| `before-model-call`    | TransformHandler\<ModelInput\>     | Auto-route, cost cap, rotation, cache key, weak tier, force-tool-call, thinking control    |
| `on-stream-chunk`      | StreamHandler\<ChatChunk\>         | Repeat detector (mid-stream abort)                                                         |
| `after-parse-response` | TransformHandler\<ParsedResponse\> | Imitation strip, text-tool fallback, Respond unwrap                                        |
| `after-model-call`     | SubscribeHandler\<ChatChunk\>      | Cost track, telemetry, response-id chain                                                   |
| `on-error`             | SubscribeHandler\<Error\>          | Retry, diagnose-then-replan, rotation                                                      |
| `on-permission`        | VetoHandler\<PermissionRequest\>   | Permission-gate plugins (interactive, YOLO, allowlist)                                     |

Handler kinds:

```ts
type TransformHandler<T> = (v: T, ctx: HookContext) => T | Promise<T>;
type SubscribeHandler<T> = (v: T, ctx: HookContext) => void | Promise<void>;
type VetoHandler<T> = (v: T, ctx: HookContext) => Decision | Promise<Decision>;
type VetoOrTransform<T> = (v: T, ctx: HookContext) => Verdict<T> | Promise<Verdict<T>>;
type StreamHandler<T> = (v: T, abort: () => void) => void;

type Decision = 'allow' | { deny: true; reason: string };
type Verdict<T> = 'allow' | { deny: true; reason: string } | { transform: T };
```

Hook handlers receive a `HookContext` exposing the side-effect surface
plugins need without giving them direct conversation access:

```ts
interface HookContext {
  /** Queue a user or system message; the agent loop appends it to history
   * at the next turn boundary. Used by step enforcer, bash-dedup nudges. */
  injectMessage(role: 'user' | 'system', content: string): void;
  /** Re-enter the agent loop with a synthetic user prompt instead of
   * returning control to the user. Used by auto-retry and empty-turn
   * recovery in `after-turn` handlers. */
  continueLoop(message: string): void;
  /** Namespaced logger. */
  log: Logger;
}
```

Hooks fire in registration order. For Transform chains, the output of one
handler is the input to the next. For Veto chains, the first `deny` wins.
For VetoOrTransform, `deny` halts; `transform` replaces and continues the
chain; `allow` is a no-op pass-through. For Subscribe and Stream chains,
errors are isolated (one plugin's failure does not break others).
`on-stream-chunk` is a hot-path hook — handlers must be fast and must not
allocate per chunk. Dispatch is a direct function call, not EventEmitter.

### 3. Renderer extension

Three extension points for the TUI plugin. Undefined when running under a
non-TUI transport (headless / ACP), so a renderer plugin gracefully no-ops.

```ts
api.renderer?.addStatusSegment(component: () => ReactNode): void;
api.renderer?.addPanel(trigger: PanelTrigger, component: ComponentType): void;
api.renderer?.addKeybinding(key: KeyChord, action: () => void): void;
```

## Plugin types

Fifteen contribution shapes. Most plugin packages contribute several at
once.

Note on Provider plugins: each registers a triple — `Provider` (chat /
listModels / capabilities), `ProviderDescriptor` (picker metadata: label,
aliases, env vars, auth-flow tag, prompt headers), and `AuthHandler` (the
per-flow code that runs during the picker's `key-add` stage, e.g. simple
prompt vs device flow vs OAuth). The picker queries the registry and
delegates the auth dance back to whichever plugin owns the provider —
keeping the multi-key add/select/delete/confirm UX identical across all
providers while letting each plugin own its credential acquisition.

| #   | Type             | Primary primitive                                                 |
| --- | ---------------- | ----------------------------------------------------------------- |
| 1   | Provider         | registry (`api.providers`) — Provider + descriptor + auth handler |
| 2   | Tool             | registry (`api.tools`)                                            |
| 3   | Command          | registry (`api.commands`)                                         |
| 4   | Hook             | hook bus                                                          |
| 5   | Permission gate  | hook bus (`on-permission` veto)                                   |
| 6   | Prompt section   | registry (`api.systemPrompt`)                                     |
| 7   | Renderer         | renderer extension                                                |
| 8   | Transport        | registry (`api.transports`)                                       |
| 9   | Workflow         | registry + hook bus                                               |
| 10  | Skill            | registry (matcher) + prompt section                               |
| 11  | Memory backend   | registry + prompt section                                         |
| 12  | Snapshot store   | registry + hook bus + commands                                    |
| 13  | Sandbox          | registry (`api.sandboxes`)                                        |
| 14  | Context strategy | hook bus (`before-turn` transform)                                |
| 15  | Auth flow        | bundled with provider plugin                                      |

### Composite examples

A single npm package commonly contributes multiple types:

| Package                        | Contributes                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@factory/plugin-cost-tracker` | hook (`after-model-call`) + renderer (status segment) + command (`/cost`)                                                                          |
| `@factory/plugin-snapshots`    | snapshot store + hook (`before-turn`) + commands (`/save`, `/restore`, `/diff`, `/undo`)                                                           |
| `@factory/plugin-mcp`          | tool source (dynamic registration) + hook (handshake on session-start, hash-pin check on `before-tool-call`)                                       |
| `@factory/plugin-lsp`          | hook (`after-tool-call` on Edit/Write) + renderer (diagnostics panel)                                                                              |
| `@factory/plugin-todo-ledger`  | tool (TodoWrite) + renderer (panel) + prompt section (system-prompt nudge)                                                                         |
| `@factory/plugin-yolo`         | permission gate + renderer (warning banner)                                                                                                        |
| `@factory/plugin-reliability`  | tool (Respond) + 6 prompt sections + on-stream-chunk + after-parse-response + before-tool-call + after-turn + before-model-call (see next section) |

## Small-model reliability stack

Factory's value proposition includes making smaller, cheaper, local models
actually usable for coding tasks. The current codebase implements ~12
distinct "nudge" mechanisms across `src/core/agent/` that catch and correct
common small-model failures. All of them bundle into one plugin —
`@factory/plugin-reliability` — in the new architecture. This section
documents the mapping because the bundle is what shaped three additions to
the otherwise-minimal plugin API.

### Mechanisms and their plugin mappings

| Mechanism                                                                                                                              | Source today                                                  | Plugin mechanism                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Reliability prompts (parallel-first / verification / scope-discipline / debug-protocol / anti-rationalization / tool-output-untrusted) | IDEAS.md (planned)                                            | Prompt section — `api.systemPrompt.register({ priority, text })`                      |
| `Respond` synthetic tool (keeps model in tool-calling grammar)                                                                         | `src/tools/respond.ts`                                        | Tool + prompt section nudge                                                           |
| `forceToolCall` / `thinking` / `reasoningEffort` (ChatOptions knobs)                                                                   | `src/providers/types.ts` ChatOptions                          | `before-model-call` transform                                                         |
| Weak-tier model swap for corrector / subagent calls                                                                                    | `src/core/agent/call-model/weak-tier.ts`                      | `before-model-call` transform (reads `_requestSource`, swaps `model`)                 |
| Bash dedup nudge                                                                                                                       | `src/core/agent/tool-calls/bash-dedup.ts`                     | `before-tool-call` — `ctx.injectMessage` after detecting near-duplicate               |
| Step enforcer (tier-escalating prerequisite check)                                                                                     | (planned, current `step-nudge` / `prerequisite-nudge` events) | `before-tool-call` — `{ deny, reason }` + `ctx.injectMessage`                         |
| Empty-turn warning / output-cap "continue"                                                                                             | `src/core/agent/run-agent.ts`                                 | `after-turn` — detect zero output + `ctx.continueLoop(prompt)`                        |
| Auto-retry injection                                                                                                                   | `src/core/agent/recovery-state.ts`                            | `after-turn` — bad-pattern detection + `ctx.continueLoop`                             |
| Repeat detector (mid-stream loop abort)                                                                                                | `src/core/agent/call-model/repeat-detector.ts`                | `on-stream-chunk` — abort callback on detection                                       |
| Imitation strip (fabricated tool-result blocks)                                                                                        | `src/core/agent/tool-calls/tool-result-format.ts`             | `after-parse-response` transform — strip fakes from `text`                            |
| Text-tool fallback parser (prose-embedded tool calls)                                                                                  | `src/core/agent/tool-calls/text-tool-parser.ts`               | `after-parse-response` transform — fill `toolCalls[]` if empty                        |
| Respond unwrap (Respond tool call → plain text)                                                                                        | `src/core/agent/run-agent.ts` `respond-stripped` event        | `after-parse-response` transform                                                      |
| Tool-call corrector (LLM-driven malformed-call repair)                                                                                 | `src/core/agent/tool-calls/tool-call-corrector.ts`            | `before-tool-call` — returns `{ transform: correctedCall }` after weak-tier model fix |

### Why three additions to the API were necessary

Nine of these mechanisms fit the original eight-event hook bus and three
chain semantics. Three did not, and forced the additions called out in
the hook-bus table:

1. **Mid-stream interventions.** The repeat detector inspects chunks
   _while_ the model is streaming and aborts the call before the loop
   wastes 5–15k tokens. `after-model-call` fires post-stream — too late.
   Added: `on-stream-chunk` with abort callback.
2. **Response parsing transforms.** Imitation strip, text-tool fallback,
   and Respond unwrap mutate the parsed `{ text, toolCalls[] }` after
   streaming but before tool dispatch. Promoting `after-model-call` to
   Transform would force every observability plugin (cost tracker,
   telemetry) to remember to return the chunk unchanged. Cleaner to add
   a sibling event. Added: `after-parse-response` transform.
3. **Tool-call repair.** The corrector needs to _fix_ malformed tool
   calls, not just allow or deny them. Pure veto would force a denial
   loop where the agent re-emits the same broken call. Added:
   `VetoOrTransform` semantics on `before-tool-call`.

These three additions are the price of supporting small-model reliability
without baking it into core. They are stable from v0.1.0 alongside the
other seven events.

### Package structure

```
@factory/plugin-reliability/
  src/
    index.ts                  default export: register(api)
    repeat-detector.ts        on-stream-chunk
    response-parser.ts        after-parse-response (imitation, text-fallback, respond-unwrap)
    bash-dedup.ts             before-tool-call
    step-enforcer.ts          before-tool-call (prerequisite check)
    tool-corrector.ts         before-tool-call (VetoOrTransform via weak-tier model)
    auto-retry.ts             after-turn → ctx.continueLoop
    empty-turn.ts             after-turn → ctx.continueLoop
    weak-tier.ts              before-model-call
    force-tool-call.ts        before-model-call (ChatOptions)
    prompts/                  6 prompt sections
    respond-tool.ts           tool registration (synthetic terminal tool)
```

Per-mechanism toggles via plugin config:

```json
{
  "plugins": ["@factory/plugin-reliability"],
  "reliability": {
    "repeatDetector": true,
    "toolCorrector": true,
    "weakTier": { "enabled": true, "model": "claude-haiku-4-5" },
    "prompts": ["parallel-first", "verification", "scope-discipline"]
  }
}
```

Users on frontier strong-tier models can disable the plugin entirely or
keep only the prompts. Users running 7B local models keep everything on.
The reliability stack is a Phase 5 port — not in v0.1 — but the hook
events that host it land in v0.1 so plugin authors can build on a stable
contract from day one.

## Plugin loading

A plugin is a Node module with a default-exported `register` function:

```ts
export default async function register(api: PluginApi): Promise<void> {
  api.tools.register(myTool);
  api.commands.register('mycmd', handler);
  api.on('after-tool-call', async result => transform(result));
}
```

The user enables plugins in `~/.factory/config.json`:

```json
{
  "plugins": [
    "@factory/plugin-mcp",
    "@factory/plugin-cost-tracker",
    "./.factory/plugins/my-local-thing"
  ]
}
```

Load sequence in `main()`:

```
1. parseArgs
2. loadConfig
3. api = new PluginApi(config, logger)
4. for plugin in [...BUILTIN_PLUGINS, ...config.plugins]:
     try: await (await import(spec)).default(api)
     catch e: api.log.error('plugin failed', { spec, e }); continue
5. api.freeze()
6. transport = api.transports.resolve(argv.transport ?? 'tui')
7. await transport.run(api)
```

Resolution: bare specifiers go through Node's resolver (`import.meta.resolve`);
paths are loaded directly. A single failed plugin logs and is skipped — it
does not abort startup.

### Plugin-owned config and state

```ts
const myConfig = api.config<MyConfig>(myZodSchema);
// reads config.plugins[<plugin-name>], zod-validated

const globalDir = api.state.global(); // ~/.factory/state/<plugin-name>/
const projectDir = api.state.project(); // <cwd>/.factory/state/<plugin-name>/
```

Plugins own these directories. Core does not introspect their contents.

### Core-owned credential store (shared with provider plugins)

Credentials (API keys, OAuth tokens) are not per-plugin state — they're a
shared store that the picker and the headless credential resolver both
read. The TUI picker adds and deletes keys; provider plugins read them
when instantiating clients; the credential resolver reads them at startup
to decide which providers to probe.

```ts
interface CredentialStore {
  list(provider: string): Promise<KeySummary[]>;
  add(provider: string, label: string, secret: string): Promise<string>;  // returns keyId
  remove(provider: string, keyId: string): Promise<void>;
  get(provider: string, keyId?: string): Promise<string | undefined>;
}

api.credentials: CredentialStore;
```

Storage location is core's decision (`~/.factory/credentials.json` with
the same multi-key schema the current `src/core/auth/credentials.ts`
uses). Provider plugins do not write credentials directly — they hand
the user-typed secret to `api.credentials.add()` and receive a keyId.
The picker's `key-add` stage looks identical for every provider; only
the validation step (which calls back into the provider plugin's
`AuthHandler`) varies.

## Directory layout

In the **new repository** (working name TBD — see "Open questions"):

```
src/
  core/                        ~1.5k LOC budget
    plugin-api.ts              PluginApi facade
    registries/
      tools.ts
      providers.ts
      commands.ts
      system-prompt.ts
      transports.ts
      workflows.ts
      memory.ts
      sandboxes.ts
    hook-bus.ts                event dispatcher + chain semantics
    agent-loop.ts              turn orchestrator (minimal)
    conversation.ts            message history, naive trim-at-overflow
    types.ts                   Provider, ToolHandler, ChatMessage, etc.
    config.ts                  zod-validated config loader
    loader.ts                  plugin resolution + import + register
    main.ts                    new entry binary
  plugins/
    builtin-providers/
      _openai-adapter/         underscore = shared infra, not a plugin
      openai/                  ports from factory-code/src/providers/openai/
      anthropic/               ports from factory-code/src/providers/anthropic.ts
      ollama/                  ports from factory-code/src/providers/ollama.ts
    builtin-tools/             read, write, edit, bash, grep, glob
    builtin-tui/               Ink REPL with picker + slash + status
    builtin-headless/          non-TTY entry
    builtin-commands/          /help, /clear, /exit
    builtin-security/          hard denylist (rm -rf /, ~/.ssh, etc.)
```

`src/core/` imports nothing from `src/plugins/`. Enforced by an arch test
that replaces the current repo's `archunit` rules. The registry/hook seam
is the new boundary.

The existing `factory-code` repo stays at v0. It is the reference for
porting (Phase 5+ tables cite paths in that repo) and continues to serve
existing users until the new repo reaches parity. Nothing is migrated;
each port is a fresh implementation that reads the v0 source for design
intent and copies only the load-bearing logic.

## Phasing

### Phase 0 — Walking skeleton (~1 week)

Goal: `factory --provider ollama --model llama3 "read foo.txt"` works.

Deliverables:

- `src/core/plugin-api.ts` with all 8 empty registries + hook bus + renderer-undefined stub
- `src/core/loader.ts` with dynamic-import + error isolation
- `src/core/agent-loop.ts`: append input → stream provider → execute tool calls → loop
- `src/core/conversation.ts`: message list, no compaction (fail at overflow)
- `src/core/config.ts`: minimal zod schema for `{ provider, model, plugins[] }`
- `src/plugins/builtin-providers/ollama/`: ported from current `src/providers/ollama.ts`
- `src/plugins/builtin-tools/read.ts`: ported from current `src/tools/read.ts`
- `src/plugins/builtin-headless/`: stdin/stdout transport
- `src/main.ts`: parse argv, load config, instantiate `PluginApi`, run loader, dispatch to transport

Skeleton smoke test: one e2e test that runs the binary against a mock
Ollama, asks it to call Read, asserts the file content reaches the model.

### Phase 1 — Provider parity (~2 weeks)

Goal: all three anchor providers work; OpenAI-compat covers the seven
config-only providers via base URL.

Deliverables:

- Port `src/providers/openai/` (the shared adapter) to `src/plugins/builtin-providers/_openai-adapter/`
- Port `anthropic.ts`, `ollama.ts` as builtin plugins
- Each provider plugin registers a triple: `Provider` implementation + `ProviderDescriptor` (label, aliases, env vars, auth-flow tag, prompt headers — same shape as current `src/providers/registry.ts:ProviderDescriptor`) + `AuthHandler` for the picker's validation step
- Each builtin provider also contributes its own conditional `SystemPromptContributor` (provider-specific system prompt — Anthropic-style XML structure / OpenAI-style developer-role hints / Ollama-style aggressive nudging for small local models). Tier branching (`strong` / `medium` / `weak`) inside each provider's contributor handles model-family variants without core changes.
- Verify OpenAI-compat against Cerebras / Groq / Mistral / OpenRouter / Vercel / WorkersAI / LlamaCpp endpoints (config-only — no per-host code)
- Auth flow in v0.1: only `simple-prompt` (text input + `api.credentials.add`) and env-var resolution. Device flow + OAuth deferred to per-provider plugins (Phase 5: `@factory/provider-copilot` for GitHub device flow, `@factory/provider-googleaistudio` for OAuth, etc.) — the `AuthHandler` interface accepts them now so plugins can add later without core changes.
- The remaining ~10 providers stay in `legacy/v0/` for now

### Phase 2 — Tool parity (~1 week)

Goal: same tool set as current main.

Deliverables:

- Port Write, Edit, Bash, Grep, Glob from `src/tools/`
- `Bash` queries `api.sandboxes.resolve('host')` (default sandbox = no isolation; sandbox plugins replace this later)
- WebFetch + Delegate stay in legacy for now (ship as plugins in Phase 5)

### Phase 3 — TUI (~1 week)

Goal: interactive REPL with picker + slash + status segment. The picker
keeps its existing UX (current `src/ui/tui/components/provider-picker/`
stage machine: recent → provider → key submenu → model). Only the
provider-list source changes — from the hardcoded `DESCRIPTOR_LIST` to
whatever `api.providers.list()` returns.

Deliverables:

- `src/plugins/builtin-tui/`: extract minimal Ink REPL from current `src/ui/tui/`
- Input box + transcript + abort + one status segment slot
- Picker UI ported from `src/ui/tui/components/provider-picker/`. Stages preserved unchanged: `recent`, `provider`, `key`, `key-add`, `key-validating`, `key-validate-failed`, `key-delete`, `key-confirm-delete`, `loading`, `model`, `error`. Multi-key per provider preserved. The picker:
  - Iterates `api.providers.list()` for the provider stage instead of a hardcoded `DESCRIPTOR_LIST`.
  - Reads `ProviderDescriptor` from each plugin for label, aliases, env vars, auth-flow type, and per-stage prompt headers (`inputPrompt`, `noModelsMessage`, etc.).
  - Delegates the `key-add` validation step to the provider plugin's `AuthHandler` so device-flow / OAuth / simple-prompt branches stay inside the plugin that owns them.
  - Uses core-owned multi-key storage (`api.credentials`, see below) so the key submenu's add / select / delete / confirm flow works identically across providers.
- Slash dispatcher: routes `/foo` to `api.commands.get('foo')`
- `src/plugins/builtin-commands/`: `/help` (lists registered commands), `/clear`, `/exit`
- Renderer extension API exercised by one builtin status segment (model + token count from `after-model-call` subscriber)

Decision point: if Ink's surface in core ends up > 500 LOC, reconsider
readline. Track LOC during Phase 3 implementation.

### Phase 4 — API stabilization (~1 week)

Goal: third-party plugins can be authored.

Deliverables:

- `PLUGINS.md`: full documentation of registries, hook bus, renderer, lifecycle, config schema
- One external plugin built in a separate repo as validation (proposed: `@factory/plugin-cost-tracker` — exercises hook + renderer + command)
- Tag core 0.1.0; plugin API semver begins
- Replace the current `archunit` boundary tests with one new test: `src/core/` imports nothing from `src/plugins/`

### Phase 5 — Existing-feature ports (incremental)

Each existing feature in the `factory-code` v0 repo lands as a plugin in
the new repo without touching core. Priority ordering (highest leverage
first):

| Plugin                                            | Source in factory-code (v0 repo)                                                                                                                                                                            | Type(s)                                                                                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@factory/plugin-hooks`                           | `core/hooks/`                                                                                                                                                                                               | hook bus + command (`/hooks`)                                                                                                                                       |
| `@factory/plugin-permissions`                     | `security/permissions.ts`                                                                                                                                                                                   | permission gate                                                                                                                                                     |
| `@factory/plugin-security`                        | `security/{paths,bash-rules,env}.ts`                                                                                                                                                                        | hook bus (`before-tool-call` veto)                                                                                                                                  |
| `@factory/plugin-mcp`                             | `mcp/`                                                                                                                                                                                                      | tool source + hook                                                                                                                                                  |
| `@factory/plugin-skills`                          | `core/skills/`                                                                                                                                                                                              | skill registry + prompt section                                                                                                                                     |
| `@factory/plugin-session-log`                     | `core/session/session-log.ts`                                                                                                                                                                               | hook subscribers                                                                                                                                                    |
| `@factory/plugin-rotation`                        | `core/agent/call-model/call-model-rotation.ts`                                                                                                                                                              | hook (`before-model-call` + `on-error`)                                                                                                                             |
| `@factory/plugin-compaction`                      | `core/context/context-manager.ts`                                                                                                                                                                           | context strategy                                                                                                                                                    |
| `@factory/plugin-reliability`                     | `core/agent/call-model/{repeat-detector,weak-tier}.ts`, `core/agent/tool-calls/{tool-call-corrector,bash-dedup,text-tool-parser,tool-result-format}.ts`, `core/agent/recovery-state.ts`, `tools/respond.ts` | prompt sections + tool (Respond) + on-stream-chunk + after-parse-response + before-tool-call + after-turn + before-model-call (see "Small-model reliability stack") |
| `@factory/plugin-plan-mode`                       | `cli/args.ts` + plan-approval components                                                                                                                                                                    | permission gate + renderer panel                                                                                                                                    |
| `@factory/plugin-tabs`                            | `ui/tui/tabs/`                                                                                                                                                                                              | renderer plugin                                                                                                                                                     |
| `@factory/plugin-subagents`                       | `core/subagent/` + `tools/delegate.ts`                                                                                                                                                                      | tool + provider hook                                                                                                                                                |
| `@factory/plugin-webfetch`                        | `tools/web/`                                                                                                                                                                                                | tool                                                                                                                                                                |
| `@factory/plugin-picker-advanced`                 | `ui/tui/components/provider-picker/`                                                                                                                                                                        | renderer plugin (advanced picker; replaces minimal)                                                                                                                 |
| Plus per-provider plugins for the ~10 not in core | `providers/<name>.ts`                                                                                                                                                                                       | provider                                                                                                                                                            |

End of Phase 5: feature-equivalent to current main, organized as ~15
plugins around a ~2k LOC core. `legacy/v0/` deletable.

### Phase 6+ — IDEAS.md ports

Each feature ships as its own plugin without touching core. Sequenced by
the M1–M6 milestones in `IDEAS.md`:

- M1 carryover: `feat/architect-mode`, `feat/repomap`, `feat/lsp`, `feat/checkpoints`, `feat/apply-patch`, `feat/workflows`, `feat/agents-md-fallback-v2`, `feat/bash-sandbox-tier1-2`, `feat/security-risk-field-v2`, `moooar-tools`
- M3: task-ledger tool, parallel sub-agents, background tasks
- M4: ACP server transport, wider MCP support, headless CI surface
- M5: eval harness driver, structured error taxonomy, runtime cost ceilings, crash recovery
- M6: scoped persistent memory, plugin/skill trust model, team mode
- Patterns-to-borrow sections: DLP redaction, prompt-injection validation, encoding-pipeline detection, MCP supply-chain hardening, cross-tool egress tripwire, typed communication acts, harness-enforced invariants, lifecycle commands, persona personas, anti-rationalization tables, scope-discipline protocol, debug protocol, parallel-first heuristic, verification principle, snapshots, cost tracking, auto-routing, YOLO mode, `/doctor`, `/think`

## Hook event contract (v1, locked)

```ts
interface HookEvents {
  'before-turn': TransformHandler<TurnInput>;
  'after-turn': SubscribeHandler<TurnResult>;
  'before-tool-call': VetoOrTransform<ToolCall>;
  'after-tool-call': TransformHandler<ToolResult>;
  'before-model-call': TransformHandler<ModelInput>;
  'on-stream-chunk': StreamHandler<ChatChunk>;
  'after-parse-response': TransformHandler<ParsedResponse>;
  'after-model-call': SubscribeHandler<ChatChunk>;
  'on-error': SubscribeHandler<Error>;
  'on-permission': VetoHandler<PermissionRequest>;
}

interface ParsedResponse {
  text: string;
  toolCalls: ToolCallMessage[];
}

interface PluginApi {
  on<E extends keyof HookEvents>(event: E, handler: HookEvents[E]): void;
}
```

If a feature reveals a missing event in Phase 5 or 6, the API extends. The
existing ten are stable from v0.1.0.

The system-prompt composer is a registry, not a hook (sections contribute
strings with priority, then concatenate). Documented here for completeness.

## Deferred decisions

- **Provider scope, second pass.** If Phase 1 reveals the OpenAI-compat
  adapter is large enough to be its own plugin, split it out. Currently
  budgeted at ~700 LOC including SSE / tool-call accumulation.
- **TUI substrate, second pass.** If Phase 3 Ink-in-core exceeds 500 LOC,
  evaluate readline + Ink-as-plugin.
- **Plugin source format.** v1 supports bare specifiers + paths. Plugin
  registries, signing, hash pinning all deferred. Decide when external
  ecosystem appears.
- **Memory + snapshot interfaces.** Defer to first port. The shape will be
  driven by the first plugin (likely scoped persistent memory).
- **Sandbox provider abstraction.** Defer to first sandbox plugin (likely
  `@factory/plugin-sandbox-bwrap` or `@factory/plugin-sandbox-docker`).
- **Hot reload / runtime enable-disable.** Out of scope for v1. Restart to
  change plugins.
- **Capability manifest / sandboxing of plugins.** Listing a plugin in
  config = consent. Add a first-run trust prompt mirroring the existing
  hook trust model when ecosystem grows.

## Risks and mitigations

1. **Plugin API churn before lock.** Mitigation: don't tag 1.0 until Phase
   4's external-plugin trial passes. Pre-1.0 versions can break
   compatibly. Document churn risk in `PLUGINS.md`.
2. **archunit boundary tests encode current module discipline.**
   Mitigation: replace per-domain rules with one new test —
   `src/core/` imports nothing from `src/plugins/`. The registry/hook
   seam is the new boundary; the old `tools/` ↛ `ui/` style rules become
   irrelevant.
3. **Provider auth flow currently entangled with the picker.** Mitigation:
   extract auth flow into per-provider plugin packages. The picker queries
   the registry; each provider plugin advertises its auth-flow type
   (env / prompt / device / oauth); the picker invokes the matching flow.
4. **Two-tier "real code vs plugins" temptation.** Mitigation: every
   builtin routes through the public `PluginApi`. If a builtin needs an
   API the public surface doesn't have, that's a missing-surface bug —
   extend the API, don't go around it.
5. **Loss of features during port.** Mitigation: `legacy/v0/` stays
   runnable as `factory-legacy` until Phase 5 reaches parity. Nothing is
   deleted until the equivalent plugin passes its e2e tests.
6. **Performance regression from hook bus dispatch overhead.** Mitigation:
   hook bus is direct function calls in-process, no EventEmitter
   framework. Benchmark Phase 0 vs current main on a representative
   10-tool-call turn before tagging 0.1.0.
7. **Plugin breakage in the wild after API change.** Mitigation: once 1.0
   ships, breaking changes require a major bump and a migration codemod.

## v0.1 MVP cut (definition of done for Phase 0–4)

Core (~2.5k LOC):

- Eight registries + hook bus + renderer extension
- Naive conversation (trim-at-overflow, no compaction)
- Plugin loader (npm specifier + path resolution, error isolation)
- Zod-validated config

Builtin plugins:

- Providers: OpenAI-compat, Anthropic, Ollama (auth: env var + CLI flag only)
- Tools: Read, Write, Edit, Bash, Grep, Glob
- TUI: input + transcript + abort + status segment + picker + slash dispatch
- Headless: stdin/stdout entry
- Commands: `/help`, `/clear`, `/exit`
- Security: hard denylist (`rm -rf /`, fork bomb, `curl | sh`, `~/.ssh` reads — same set as current `bash-rules.ts` built-ins; cannot be overridden)

Deferred to Phase 5+ (not in v0.1):

- Picker beyond model+provider list, advanced picker UI
- Hooks, skills, MCP, slash commands beyond the three above
- Plan mode, permission prompt (only hard denylist runs)
- Compaction, key rotation, retry, repeat detection
- Tool corrector, weak tier, auto-retry
- Session log, key stats, telemetry
- WebFetch, Delegate, TodoWrite
- The ~10 non-anchor providers
- Tabs, plan-approval panel, cost footer, rotation prompt

## Open questions

These need answers before Phase 5 begins but are not blockers for Phase 0–4:

- **Plugin distribution.** Are the ~15 first-party plugins individual npm
  packages under `@factory/plugin-*` or a monorepo with workspace packages?
  Monorepo simplifies coordinated changes; individual packages let users
  pin versions. Lean monorepo for v0.1, separate per-package release for
  third-party-targeted plugins after 1.0.
- **Plugin trust model.** First-run prompt mirroring the existing hook
  trust pattern? Hash pinning under `~/.factory/plugin-pins.json`?
  Deferred until the first non-trivial security issue or ecosystem
  growth.
- **Eval harness.** Where does it live — as a transport plugin
  (`api.transports.register('eval', ...)`) or a separate binary?
  Transport-plugin is more consistent; separate binary is what users
  expect for CI. Lean transport-plugin with a thin wrapper script.

---

## Sequencing rationale

**Phase 0** proves the plugin API can actually run an agent. Without that,
every subsequent decision is speculation. **Phase 1–2** demonstrate that
existing functionality fits the API (provider + tool). **Phase 3** proves
the TUI layer fits without becoming bloated. **Phase 4** is the lock — the
external plugin in a separate repo is the falsification test for the API
shape.

Phase 5 is incremental forever after that; each plugin lands independently
and the order is driven by user demand.

Phases 0–4 are estimated at ~6 weeks of focused work. Phase 5 stretches
across however long the existing codebase takes to migrate; Phase 6+ is
the rest of factory's roadmap.
