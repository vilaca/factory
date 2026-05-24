# Designing codebases for agents

How to shape a codebase so AI agents can read, modify, and extend it safely — and how doing so usually makes the code better for humans too.

---

## 1. The premise

For decades, "good code" has been optimised for one consumer: the human reader. The standard advice — meaningful names, small functions, elegant abstractions, comprehensive comments — is all aimed at the asymmetry between the seconds a human spends reading a line of code and the minutes they spend writing it.

Agents flip the asymmetry. An agent reads code at machine speed but reasons about it within a bounded context window, with no long-term memory across sessions, no ability to "ask the previous author what they meant", and a tendency to confidently fabricate when the code is ambiguous. The friction that limits an agent is different from the friction that limits a human:

| Friction                | Limits humans because        | Limits agents because                            |
| ----------------------- | ---------------------------- | ------------------------------------------------ |
| Implicit conventions    | They have to learn them once | They have to re-derive them every session        |
| Hidden coupling         | Eventually shows up as a bug | Shows up as a fabricated edit                    |
| Cross-cutting concerns  | Hard to refactor safely      | Impossible to refactor safely                    |
| Documentation that lies | Annoying                     | Indistinguishable from documentation that's true |
| Tests as the spec       | Slow feedback loop           | The _only_ feedback loop                         |

A codebase that an agent can work on is one where these failure modes are made structural rather than cultural: encoded in types, tests, and module boundaries that the agent cannot bypass even if its prompt doesn't tell it the rule.

This essay describes how to do that. The techniques are not new — most are decades-old type-system tricks, capability-based design, or arch-test patterns. What's new is _why_ you'd reach for them and which ones return the most safety per unit of complexity when an agent is the primary author.

---

## 2. The signal hierarchy

When you want an agent not to do something, you have a choice about how to enforce it. The options form a hierarchy from strongest to weakest:

1. **Compile error.** The code does not build. The agent must read the type error and adjust. There is no path through.
2. **Test failure.** The code builds but a test fails before merge. The agent observes a concrete assertion that names the violated invariant.
3. **Pre-commit hook / arch test.** A separate gate fails. Similar to a test failure but usually faster and tied to repository structure.
4. **Lint warning.** A linter emits a message. Some agents read these reliably; many ignore them.
5. **Comment or docstring.** Prose telling the agent what not to do. Read approximately. Followed approximately. Forgotten on the next edit.
6. **External convention.** Wiki page, CONTRIBUTING.md, tribal knowledge. Effectively invisible to an agent.

The single most important shift when designing for agents is to **move every rule you care about as far up this hierarchy as it will go**. If a rule is currently documented in a comment, ask whether it can become a lint rule. If it's a lint rule, ask whether it can become an arch test. If it's an arch test, ask whether it can become a compile error.

The cost goes up the higher you go — a compile-enforced rule typically requires the type system to be shaped around it, which is a real refactor. The benefit goes up faster: a compile error catches the violation the first time the agent tries it, at edit time, with a precise location.

Humans can profitably live in the middle of this hierarchy because they read comments, follow conventions, and accumulate context across sessions. Agents cannot. **For agent-authored codebases, the middle of the hierarchy is functionally empty** — what matters is whether the rule is a hard block or whether the agent has to know it without being told.

---

## 3. The core principle: retrieval locality

A human refactoring a feature can hold the architecture in their head, walk the codebase opportunistically, and synthesise an understanding across many files over hours.

An agent has none of that. To safely modify a feature, an agent has to load every file relevant to that feature into a bounded context. Each additional file is more tokens, more inference cost, and more opportunity to miss a dependency.

The single best architectural metric for agent-friendliness is therefore **how many files an agent must read to safely modify one feature**. Call this _retrieval locality_. Lower is better.

Two architectures that look equally "clean" to a human can differ wildly in retrieval locality:

```
# Layered (good for humans, bad for agents)
prompts/planning.ts
events/planning.ts
hooks/planning.ts
runtime/planning.ts
tests/planning.test.ts

# Vertical slice (good for both, but especially agents)
capabilities/planning/
  prompts.ts
  events.ts
  hooks.ts
  runtime.ts
  tests.ts
  AGENTS.md
```

Both organisations contain the same code, but the second one means an agent can `ls capabilities/planning/` and have everything in front of it. The first one requires the agent to _already know_ that planning logic is sprinkled across five different layers — knowledge it can only get from a comment, a doc, or trial and error.

Vertical slicing trades off some DRYness — `events/` no longer has every event in one folder — for retrieval locality. For agents this trade is almost always worth making, because the cost of duplicated code is paid once at maintenance time, while the cost of cross-folder reasoning is paid every single edit.

---

## 4. Patterns that lift rules into types

The biggest leverage in agent-oriented design comes from finding rules that currently live in prose ("don't set field X when condition Y holds") and lifting them into type-level guarantees. Below are the patterns that recur most often, with concrete examples drawn from real codebases.

### 4.1 Discriminated unions for state matrices

The pattern: any time you have a struct with optional fields whose validity depends on other fields, the struct is begging to become a discriminated union.

**Before — prose contract:**

```ts
interface ToolResult {
  success: boolean;
  output: string;
  // Only set when success=true; only set by Bash. Cannot coexist with hardError.
  cwdAfter?: string;
  // Set when the executor caught ToolResolutionError. Always paired with skipCorrector: true.
  softError?: boolean;
  // Set when the executor caught any other exception. Mutually exclusive with softError.
  hardError?: boolean;
  // Skip the LLM corrector. Required when softError is true; meaningless on success.
  skipCorrector?: boolean;
}
```

A reader has to parse the comments and remember a 7-field combinatorial matrix. Five of the eight obvious flag combinations are illegal, and nothing at compile time stops anyone from writing them.

**After — discriminated union:**

```ts
type ToolResult =
  | {
      success: true;
      output: string;
      empty?: boolean;
      important?: boolean;
      cwdAfter?: never;
      softError?: never;
      hardError?: never;
      skipCorrector?: never;
    }
  | {
      success: false;
      output: string;
      skipCorrector?: boolean;
      softError?: never;
      hardError?: never;
    }
  | { success: false; output: string; softError: true; skipCorrector: true; hardError?: never }
  | { success: false; output: string; hardError: true; skipCorrector?: boolean; softError?: never };
```

Now every illegal combination is a compile error. The matrix is enforced by `tsc`, not by hope. Tool authors no longer need to know the rules — the type system tells them when they're wrong.

The `?: never` trick is load-bearing. Declaring a field as `?: never` on a union variant means "this variant exists structurally, but the field, if set, must be `never`" — i.e., unset. Anyone writing the field on that variant gets a clear `Type 'string' is not assignable to type 'never'` error.

### 4.2 Phantom fields for capability-restricted variants

Sometimes a rule is "only one specific subtype may use this field". The naïve fix is to put the field in a parent type with a runtime comment. The better fix is a phantom field on the discriminator.

**Example:** in the factory codebase, only the Bash tool can change the working directory (signalled via `cwdAfter` on its result). Every other tool must not set it.

```ts
// Standard tools forbid cwdAfter on success.
interface ToolSuccess {
  success: true;
  output: string;
  cwdAfter?: never;
}

// Bash specifically permits it.
interface BashSuccess {
  success: true;
  output: string;
  cwdAfter?: string;
}

interface StandardToolHandler {
  kind?: 'standard';
  execute(args): Promise<ToolSuccess | ToolFailure>;
}

interface BashToolHandler {
  kind: 'bash';
  execute(args): Promise<BashSuccess | ToolFailure>;
}

type ToolHandler = StandardToolHandler | BashToolHandler;
```

A tool authored as `StandardToolHandler` cannot return `cwdAfter` — compile error. The consumer that reads `cwdAfter` narrows on `tool.kind === 'bash'` first, which is the only way the type system makes the field readable.

The discriminator (`kind`) does double duty: it lets the consumer narrow the result type, and it gates which tool authors can even write the field.

### 4.3 Capability tokens for "must call X first" rules

The pattern: a function must only be called inside a specific context — under a mutex, after authentication, in a particular phase. A runtime check at the function's entry catches misuse but doesn't prevent it.

The lift is to require a _capability token_ as a parameter. The token has a private constructor; the only way to obtain one is to call the bracketing function that mints it.

**Example:** all writes to a shared config file must happen under a mutex to prevent races.

```ts
class ConfigWriteCapability {
  private constructor() {}
  // Internal factory — only callable from within this module's
  // critical-section helper below.
  static __mint(): ConfigWriteCapability {
    return new ConfigWriteCapability();
  }
}

function withConfigLock<T>(fn: (cap: ConfigWriteCapability) => Promise<T>): Promise<T> {
  return mutex.acquire().then(() => fn(ConfigWriteCapability.__mint()));
}

async function writeMergedConfig(
  cap: ConfigWriteCapability, // <-- caller must already hold one
  path: string,
  merged: Record<string, unknown>,
): Promise<Config> {
  // ... actual write logic
}
```

A future helper added by an agent that forgets to call `withConfigLock` will fail to compile when it tries to call `writeMergedConfig` — there's no way to construct a `ConfigWriteCapability` outside `withConfigLock`. The cost: a couple of extra type definitions. The benefit: the entire class of "I forgot the lock" bugs becomes impossible.

This is the type-system analogue of the "linear types" / "session types" research from the 1990s. You don't need a full linear type system to get most of the benefit — TypeScript's private constructors and structural typing are enough.

### 4.4 Type-composing call chains for phase ordering

The pattern: a system has phases that must run in a specific order (load config → authenticate → connect → serve requests). The naïve enforcement is documentation; the agentic enforcement is types that compose.

```ts
interface Phase0 {
  cliArgs: CliArgs;
  cwd: string;
}
interface Phase1 extends Phase0 {
  config: Config;
}
interface Phase2 extends Phase1 {
  auth: AuthenticatedUser;
}
interface Phase3 extends Phase2 {
  connection: DbConnection;
}

declare function loadConfig(ctx: Phase0): Promise<Phase1>;
declare function authenticate(ctx: Phase1): Promise<Phase2>;
declare function connect(ctx: Phase2): Promise<Phase3>;
declare function serve(ctx: Phase3): Promise<void>;
```

Calling `serve(loadConfig(args))` is a compile error — `serve` requires a `Phase3`, and `loadConfig` returns a `Phase1`. The only call chain that type-checks is `loadConfig → authenticate → connect → serve`.

This pattern extends naturally to branded subtypes for invariants:

```ts
declare const TRUSTED: unique symbol;
type TrustedConfig = Config & { readonly [TRUSTED]: true };

// Only handleProjectTrust can produce a TrustedConfig.
declare function handleProjectTrust(c: Config): TrustedConfig;

// Downstream consumers require it.
declare function buildMcpManager(c: TrustedConfig): McpManager;
```

`buildMcpManager(rawConfig)` is a compile error. The dependency "MCP setup happens after trust resolution" is now structural.

### 4.5 Single-source derivation for parallel structures

The pattern: two or more data structures must stay in sync (a command table and its help text, an enum and its display labels, a state machine's states and its transitions). Drift between them is almost certain at some point.

The lift is to define one as the source of truth and derive the others:

```ts
// One source of truth:
const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/exit', aliases: ['/quit'], help: 'Exit (or close active tab)', handler: handleExit },
  { name: '/new', help: 'Open a new tab', handler: handleNew },
  { name: '/emoji', handler: handleEmoji }, // hidden: no `help`
];

// Derived — never edited directly:
const HANDLERS = Object.fromEntries(
  SLASH_COMMANDS.flatMap(c => [c.name, ...(c.aliases ?? [])].map(n => [n, c.handler])),
);
const HELP_ROWS = SLASH_COMMANDS.filter(c => c.help).map(c => [c.name, c.help!]);
```

Now adding a command updates both views atomically because there is only one view. The "they will drift" failure mode is structurally impossible — not test-prevented, not lint-prevented, _impossible_.

This pattern doesn't lift to the type system per se; it lifts the rule from "convention" to "data shape". Either way the agent doesn't have to know the rule, because following it is the only thing the code lets them do.

### 4.6 Sealed surfaces (private exports + arch tests)

Some libraries should not leak their wire types into the rest of the codebase. The wire types are stable inside the adapter but unstable outside it (because they track the upstream SDK).

The lift is to forbid the wire types from being imported anywhere except the adapter:

```ts
// test/unit/arch/modularity.test.ts
it('@modelcontextprotocol/sdk imports are scoped to mcp/{client,adapter}.ts', async () => {
  const allowed = new Set(['src/mcp/client.ts', 'src/mcp/adapter.ts']);
  const rule = projectFiles()
    .inFolder('src/**')
    .should()
    .adhereTo(file => {
      if (allowed.has(file.path)) return true;
      return !/@modelcontextprotocol\/sdk/.test(file.content);
    }, 'MCP SDK imports stay inside the adapter');
  await expectNoViolations(rule, 'MCP SDK scoping');
});
```

The arch test plus the structural fact that `client.ts` doesn't re-export the SDK's types together mean the wire types are sealed inside the folder. Bumping the SDK is a 2-file change, not an N-file refactor — and an agent adding a feature elsewhere has no way to accidentally couple to the SDK.

### 4.7 Event-keyed result types

The pattern: a single dispatcher handles many event types, each of which returns a different shape. The naïve interface uses a union type with all possible fields optional and a comment matrix for which fields apply to which event.

The lift is to key the result type by the event:

```ts
interface HookResultByEvent {
  PreCompact: { summaryReplacement?: string };
  SessionStart: { conversationAppend?: string };
  UserPromptSubmit: { conversationAppend?: string };
  PreToolUse: { cancel?: boolean; reason?: string };
  PostToolUse: Record<string, never>;
  Stop: Record<string, never>;
}

function runHooks<E extends keyof HookResultByEvent>(
  event: E,
  opts: RunHookOptions,
): Promise<HookResultByEvent[E]>;
```

Now:

- Adding a new event without extending `HookResultByEvent` is a compile error (the keyof constraint catches it).
- A `PostToolUse` hook returning `summaryReplacement` is a compile error (PostToolUse's shape doesn't have that key).
- A consumer of `runHooks('PreCompact', ...)` knows by type exactly what's in the response.

The whole "which fields apply to which event" matrix becomes a type, not a comment.

---

## 5. Documentation that doesn't rot

Even with everything lifted to types, you still need documentation — for the rules that genuinely can't be lifted, for the _why_ behind decisions, and for orientation when an agent first encounters a module.

The hard part is making that documentation stay true. Documentation rot is the failure mode of most "well-documented" codebases — the doc was written once, then drifted from reality over months as the code changed but the doc didn't.

Three rules for documentation that survives:

### 5.1 Colocate, don't centralise

Documentation lives next to the code it describes. A central wiki page about the planning subsystem will go stale; an `AGENTS.md` in `capabilities/planning/` won't, because the same edit that touches the code touches the doc.

This is the same rule as "tests next to code", applied to docs. The friction of updating the doc has to be lower than the friction of leaving it stale.

### 5.2 Don't auto-generate the prose

The temptation to auto-generate per-module documentation from the code structure is strong — and exactly wrong for agent-maintained codebases. What an agent needs from a doc is precisely what an auto-generator cannot produce:

- **Why** this module exists in the shape it has (not just _what_ it contains).
- **What you'll regret** doing — the constraints that aren't structural yet.
- **What the load-bearing decisions are** — the things that look arbitrary but are not.

An auto-generated "this folder contains foo.ts, bar.ts, and baz.ts" doc is useless because the agent can already see that with `ls`. A hand-written "this folder is intentionally not split into `commands/` and `handlers/` because that split is what's been tried twice and reverted both times" doc is the difference between a safe edit and a regression.

The corollary: keep these docs short. The temptation to be comprehensive produces docs no one reads. Aim for ~60-80 lines per module, no more, focused on orientation, not API reference.

### 5.3 Distinguish enforced from advisory

Every claim in a documentation file is one of three things:

- **T (type-enforceable)**: The claim is enforced by the type system. Violating it is a compile error. Strongest possible signal.
- **E (test-enforceable)**: The claim is enforced by a test (unit test, arch test, property test). Violating it fails a check.
- **F (folklore)**: The claim is enforced by nothing. It's a request that the agent voluntarily follow a rule.

T and E claims age well — when the underlying code changes, the type error or test failure forces a sync. F claims rot.

Mark each claim with its enforcement source:

```markdown
- **Constraint:** cwdAfter is Bash-only.
  _Enforced by type:_ `StandardToolHandler` declares `cwdAfter?: never`;
  only `BashToolHandler` permits the field.

- **Constraint:** Built-in security rules cannot be weakened by user config.
  _Enforced by test:_ `test/unit/security/permissions.test.ts` — property
  test fuzzing user rule sets against the built-in deny list.

- **Constraint:** Prefer fast tools (Glob/Grep) over Bash for searches.
  _Folklore:_ no mechanical check. Reviewer judgement.
```

The F claims are the suspicious ones. For each F claim, ask: can it be lifted to E? Can the E be lifted to T? Every lift you can afford is one less thing that will silently rot.

### 5.4 Audit and prune

Periodically, walk every claim in every doc and re-classify it. New T's are great (you lifted something). New E's are great (you mechanised something). New F's are warning signs (you accumulated unenforced rules). Prune ruthlessly: an F claim that's been stable for six months is much more likely to be wrong than a T claim that's been stable for six months.

A useful exercise: count the T/E/F ratio per file. A file with mostly T claims is in good shape. A file with mostly F claims is the next refactoring target — not because the rules are wrong, but because they're not load-bearing.

---

## 6. Tests as the executable specification

When a rule can't be lifted to a type, write a test. When you write the test, write it in a way that an agent reading the test can understand what the rule actually is, not just that it's enforced.

### 6.1 Architecture tests, not just unit tests

Most repositories test behaviour — "this function returns X when given Y". Agent-friendly repositories also test _structure_:

- Module A may not import module B.
- A specific identifier may only be declared in one file.
- Files that import both X and Y must also import Z.
- The public surface of folder F must not contain types from library L.

These are _invariants about the shape of the codebase_, not its behaviour. They catch the class of regression an agent is most likely to introduce: "I added a new feature in the wrong layer." They run fast, and they're easy to write.

The cost is that you need an arch-test framework — but for most languages one exists (ArchUnit for Java, archunitnet for .NET, archunit-ts / archunitjs for TypeScript). The benefit scales with the codebase: every layering rule that's tested is one less rule that has to live in someone's head.

### 6.2 Cite the bug

Every arch test (and many unit tests) should name the regression it prevents:

```ts
it('files must not pair loadGlobalConfig with saveGlobalConfig — use updateGlobalConfig (f848472 contract)', ...)
```

The `f848472` is a real commit SHA that fixed a real race condition. An agent reading the failing test learns not just "this is forbidden" but "this is forbidden because it caused a specific bug, here's where to read about it." The arch test becomes a load-bearing piece of institutional memory.

The pattern: every non-obvious rule cites either a commit SHA or a docs file. The rule becomes traceable to its origin, which is precisely the context an agent can't reconstruct on its own.

### 6.3 Property tests over example tests

For invariants ("the failure counter only resets on a fully clean batch"), property tests catch regressions that example tests miss. They also document the invariant more precisely than any prose can — a property test is essentially an executable specification of the rule.

The cost is real (property tests are harder to write than example tests) but for the invariants that genuinely matter — the ones an agent would otherwise have to re-derive — they're worth it.

---

## 7. Anti-patterns that hurt agents more than humans

Some patterns that feel fine to a human reader actively confuse agents. Worth naming them so you can grep your codebase for them.

### 7.1 Inheritance hierarchies over composition

An agent reading `class FooService extends AbstractServiceBase implements ServiceMixin<Foo>` has to load three files to understand one. A free function or struct usually does the same work with one file.

Inheritance is fine when it's genuinely modelling an "is-a" relationship; it's a tax when it's modelling code reuse. For agentic codebases, the tax is paid every edit.

### 7.2 Magic decorators / middleware chains

```ts
// Hard for agents
const handler = pipe(withAuth, withCaching, withRetries, withTracing, withLogging)(actualHandler);

// Easy for agents
async function handler(req) {
  const user = await authenticate(req);
  const cached = await checkCache(req);
  if (cached) return cached;
  return retryWithLogging(() => actualHandler(req, user));
}
```

The first version is shorter and "cleaner" to a human who already knows the convention. The second version is two screens longer but an agent reading it understands the execution order from the code itself, without having to load every decorator's source.

Explicit, top-to-bottom pipelines beat magic composition for agents. Even when the explicit version has some duplication.

### 7.3 Implicit cross-file state

A module-level `let configCache = new Map(...)` that's mutated from several files is a death trap. The agent has no reliable way to find every mutation site, and the lifetime of the state is invisible.

Two fixes, in order of preference:

1. **Make the state per-session.** Construct it in one place, thread it through.
2. **If it must be global, make every mutation go through a single function.** Then the agent only has to grep for one identifier.

The factory codebase's `defaultRegistry` story is a good example: the original design exported a module-level singleton; production code was eventually moved to per-session registries constructed in `src/index.ts`, with an arch test ensuring no production code reintroduces the import. The arch test is the load-bearing part — without it, the singleton would creep back in within a few weeks.

### 7.4 Strings where enums belong

`if (event.type === "tool-call-result")` is exactly as easy to mistype as `if (event.type === "tool-call-results")`, and the second one is silently wrong. An enum or a `typeof` of a frozen object turns the typo into a compile error.

The standard objection ("but enums add ceremony") is for human authors. For agentic authors the ceremony is free; the typo prevention is the whole point.

### 7.5 Comments that paraphrase the next line

```ts
// Increment the counter
counter++;
```

This isn't just useless to a human — it's actively misleading to an agent, because the agent will infer "the convention here is to comment every line" and start emitting the same noise. Once the noise is in the codebase, every future agent edit perpetuates it.

The rule for comments in agent-maintained code: comments explain _why_, not _what_. The code is already the _what_; the comment exists to convey context the code can't (a tradeoff that was made, a constraint from outside the file, the bug that motivated the current structure).

---

## 8. A maturity ladder

How do you know if your codebase is agent-friendly? Roughly five levels, from worst to best:

**Level 0 — Human-only.** Modular by team, not by capability. Cross-cutting concerns are spread across folders. Rules live in comments and tribal knowledge. Agents make plausible-looking edits that introduce regressions. The team blames the agents.

**Level 1 — Documented.** A `README.md` exists for major subsystems. New contributors (human or agent) can orient themselves. Most rules still live in prose. Agents follow the rules they happen to read; miss the ones they don't.

**Level 2 — Tested.** Unit tests cover behaviour. Some arch tests exist. Agent edits that break behaviour are caught at CI. Agent edits that introduce structural drift mostly aren't.

**Level 3 — Architecturally enforced.** A meaningful suite of arch tests enforces module boundaries, cross-cutting contracts, and naming conventions. Per-module `AGENTS.md` files orient agents on each subsystem. Most regressions agents introduce are caught at CI, often with a test that names the SHA where the bug was originally fixed.

**Level 4 — Type-enforced where possible.** Every constraint that can be lifted to the type system has been. Discriminated unions, capability tokens, phantom types, and brand types catch the most likely classes of agent error at compile time. The remaining rules (the ones that genuinely can't be typed) are arch-tested, with each `AGENTS.md` claim marked T / E / F so it's obvious which rules are mechanical and which are advisory.

Most codebases are somewhere between 0 and 2. Moving up the ladder doesn't require a rewrite — each level is a series of small incremental changes, and each level pays off independently.

The unit of progress is _one lifted rule_. Pick the rule you've watched agents break the most often. Lift it as far up the hierarchy as you can afford. Repeat.

---

## 9. The economics

A common objection to the patterns above is that they add complexity. Discriminated unions are more code than the loose struct. Capability tokens require extra ceremony. Vertical slicing means duplicating some infrastructure.

This is true, and it's also why these patterns weren't worth it for many codebases until recently. The math has changed:

- **Edits are cheaper.** When an agent can land a small refactor in minutes instead of hours, the cost of _each_ edit drops. The cost of _each_ mistake stays the same or grows. Mistake prevention is now a much better investment than it used to be.
- **Context is expensive.** Every file an agent has to load to understand a change costs tokens, inference time, and risk. Anything that reduces files-per-edit pays off on every single edit.
- **Long-tail bugs scale.** A codebase that's agent-edited a thousand times a year has a thousand chances to introduce the "you forgot the lock" bug. A codebase that makes that bug structurally impossible has zero. The math works out for any rule that would otherwise be violated more than a handful of times.

The shift in mindset: **structural impossibility is now cheaper than structural improbability**. A pattern that would have been overkill in a human-only codebase is a routine cost in an agent-maintained one, because the alternative is paying for the consequences thousands of times.

---

## 10. Closing

The good news: most of these techniques are also better for humans. Discriminated unions catch human errors too. Vertical slicing makes onboarding easier. Arch tests prevent humans from drifting the architecture. The patterns that make a codebase agent-friendly mostly just make it _better_.

The new news: the _priority_ is different. Patterns that were optional in human-only codebases ("nice to have, but the comment is fine") are load-bearing in agent-maintained ones. The hierarchy of enforcement — compile errors over tests over hooks over lints over comments — is no longer a stylistic preference. It's the difference between a codebase agents can safely work on and one where every edit is a roll of the dice.

The work to move up the maturity ladder is real, but it's incremental. Pick one rule. Lift it as far as it'll go. Watch what the agent does next.

Repeat.
