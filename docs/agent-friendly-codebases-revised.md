# Designing codebases for agents (revised)

A revised take on shaping a codebase so AI agents can read, modify, and extend it safely. The premise is unchanged from the first essay: agents flip the human/code asymmetry — they read fast but reason in a bounded context, with no cross-session memory and a tendency to fabricate when the code is ambiguous. The friction that limits an agent is structural, not stylistic.

This version corrects four things the first essay got wrong or skipped:

1. "Move every rule up the hierarchy" oversimplifies. Some rules cannot be lifted and are still load-bearing. The fix is **classification, not elimination**.
2. The maturity ladder is **per-subsystem, not per-repo**. Treating it as a single number hides the only useful question: which subsystem is the next lift worth in.
3. Lifts have **cascade cost**. A clean lift through a 200-file codebase still produces dozens of migration failures at the call sites. The doc has to plan for the migration, not just the lift.
4. Documentation rot is real, but the failure mode worth naming is **mixed enforceability** — docs where enforced and unenforced claims are indistinguishable. That's worse than either pure form.

---

## 1. The signal hierarchy, with the missing rung

The original hierarchy still holds:

1. **Compile error** — the code does not build.
2. **Test / arch-test failure** — the code builds, a check fails.
3. **Lint warning** — read approximately, followed approximately.
4. **Comment** — read approximately, followed less.
5. **External convention** — invisible to an agent.

The missing rung is **orientation**: the one-paragraph "what is this, where does it start, what's the public entry." Orientation is not a rule — it's not enforceable and shouldn't be. It is what lets the agent know which rules apply at all. An agent landing in a directory cold needs orientation before it can act on any rule, no matter how well-enforced.

The original framing ("move every rule as far up the hierarchy as possible") is correct for **rules**. It is wrong for **orientation, rationale, and checklists**. Those are the unliftable content, and they're the content most worth keeping.

The corrected framing:

- **Rules** (enforceable claims about what the code must or must not do) → lift as high as possible.
- **Orientation** (what this place is) → keep, can't be lifted, label as orientation.
- **Rationale** (why the rule exists) → keep, can't be lifted, label as rationale. The highest-value rationale is the kind that stops a plausible-looking bad change.
- **Checklists** (what to do, in what order, when adding feature X) → keep, can't be fully lifted, label as procedure.

The original essay's "audit and prune" loop misses this: an `F` (folklore) claim isn't always a candidate for promotion to `E` (test) or `T` (type). Sometimes it's a candidate for relabeling — it was never a rule in the first place, it was orientation pretending to be one.

---

## 2. Retrieval locality, with a cost model

Retrieval locality — files-an-agent-must-read-to-modify-one-feature — remains the best single architectural metric. The first essay sells vertical slicing as the answer. Two refinements:

**Vertical slicing has a known failure mode:** the slice that grows too coupled to be a slice. Six files in `capabilities/planning/` that all import each other is technically one directory but cognitively six files. The metric to watch is not "directory size" but "files an agent transitively reads to make a typical edit." A flat directory with one mega-file is sometimes more agent-friendly than a clean six-file slice if all six are always loaded together.

**The trade against DRY is real and the original understates it.** Vertical slicing accepts that "events" or "prompts" are no longer in one folder. For agents this is right, but the duplication cost is paid by humans doing systemic refactors. The honest version: vertical slicing optimizes for the median edit at the cost of the rare cross-cutting one. If a codebase does many cross-cutting edits (a UI framework, a compiler), the layered organization may still win.

The metric to track over time, regardless of organization: **what fraction of pull requests touch more than three directories?** A growing fraction means the retrieval locality is decaying. Track it; don't reorganize on instinct.

---

## 3. Lift patterns — the asymmetric author/consumer surface

The first essay covers discriminated unions, capability tokens, phantom types, branded subtypes, single-source derivation, sealed surfaces, and event-keyed results. All still good. One pattern missing that recurs often enough to deserve a name.

### 3.1 Narrow at declaration, union at consumption

When a type has variant-specific fields, the consumer often wants the union (it accepts any variant), but the author wants the narrow type (it forbids fields from the other variants). The same name can't safely do both: if `ToolHandler = Standard | Bash` and a new tool author annotates as `ToolHandler`, they get the loose shape and lose the per-variant guarantees.

The fix is two exported types:

```ts
export interface StandardThing {
  kind?: 'standard'; /* narrow fields */
}
export interface BashThing {
  kind: 'bash'; /* narrow fields including cwdAfter */
}

// Authors use the narrow one.
// Consumers use the union and narrow on `kind`.
export type Thing = StandardThing | BashThing;
```

The discipline: **authors annotate with the narrow type, consumers annotate with the union**. The `AGENTS.md` should explicitly tell agents not to widen at the declaration site. The cost is one extra exported type. The benefit is that the `?: never` guarantees that the first essay describes actually bite — they only bite at the _narrow_ type.

This is the lift that fails silently if you skip it. The union accepts a missing `cwdAfter`, accepts a present `cwdAfter`, accepts both `softError` and `hardError` because some branch of the union permits each. Only the narrow type forbids them.

### 3.2 Wire-format-driven indirection

Sometimes the natural physical home of a type isn't possible. Example: a tool definition type that crosses the boundary between providers, tools, and security — and an arch test forbids providers and security from importing tools.

The pattern: put the type in a neutral location (a utility module) and **re-export it from the natural surface**. Header comments at both locations explain the indirection. The re-export is the canonical import path for new code; the underlying file is the physical home for boundary reasons.

```ts
// utils/wire.ts — physical home
export interface ToolDefinition {
  /* ... */
}
//
// Lives here (not in tools/) because providers/ also imports it,
// and the arch test forbids providers → tools. The canonical
// re-export for tool authors lives in tools/types.ts.

// tools/types.ts — canonical author surface
export type { ToolDefinition } from '../utils/wire.js';
// Single-stop shop for tool authors; the underlying file lives
// in utils/ for cross-boundary reasons documented there.
```

This pattern looks like indirection-for-its-own-sake. It's worth it because:

- Agents grep `import.*from 'tools/types'` to find every tool. Without the re-export, half the imports point at `utils/wire.js` and the grep misses them.
- The header comments preempt the "let me move this to its natural home" refactor that breaks the arch test.

The cost is one extra hop when an agent traces a definition. The benefit is one canonical import path and a structural answer to "where do I import this from."

---

## 4. The lift has a cascade cost

The first essay sells lifts as wins. They are, eventually. They are not free in the moment.

A real-world lift sequence:

1. Tighten a result type from `success: boolean` (with optional flags) to a discriminated union with `success: true` / `success: false` variants and `?: never` on disallowed combinations.
2. Compile. The lift itself is a 50-line diff in one file.
3. Discover that **fifteen call sites across production and tests** now fail to typecheck. Some are constructing `{ success: !err, output }` (boolean, not literal). Some are test fixtures that wrote ad-hoc handlers without the new discriminator field. Some are MCP-shaped adapters that translate from external sources.
4. Migrate every call site. Half of the migrations are trivial (`success: true` instead of `success: !err`). Half require thinking — they uncover that the call site was relying on the loose shape in ways the type system can now see.

Plan for this:

- **Budget the migration as part of the lift, not after.** A lift that lands as a one-file diff plus fifteen "follow-up" fixes is fifteen places the lift can rot before the follow-up.
- **Migrate call sites in the same PR as the lift.** The PR is bigger; the codebase is never in a half-lifted state.
- **Provide narrow helpers for common patterns.** If every fixture constructs a fake handler, ship a `fakeHandler()` and `fakeBashHandler()` so the migration is a rename, not a redesign.
- **Expect the build to fail in unrelated test files.** A type lift through a heavily-used contract will reveal handler-shaped object literals nobody remembered existed. Search the entire codebase, not just the directly-modified files.

The economics still favor the lift — a structurally impossible bug is worth fifteen one-time migrations. But framing the lift as "small change" is misleading. Frame it as **one small change plus its blast radius**.

---

## 5. Documentation that doesn't rot — the mixed-enforceability failure

The first essay's T/E/F classification is right. The failure mode it doesn't name is the worst one: **docs where enforced and unenforced claims are interleaved without labels**.

In a doc like that, an agent has no way to tell which claims to trust. The structurally enforced rule "no other file may import this SDK" and the folklore rule "prefer batched writes" look identical. The agent learns to discount all of them, including the ones that would have saved it.

The fix is structural separation within every orientation doc:

```markdown
## Purpose

One paragraph. What is this place. Where does it start. Unenforceable;
this is orientation, not a rule.

## Enforced invariants

- **Constraint X.** _Enforced by type:_ `Thing` is a discriminated union;
  the illegal combination is a compile error.
- **Constraint Y.** _Enforced by test:_ `test/unit/arch/...test.ts` —
  "imports from `@vendor/sdk` are confined to the adapter."
- **Constraint Z.** _Enforced by test:_ `test/integration/...test.ts` —
  property test fuzzing the failure mix.

If a claim doesn't end in "Enforced by type" or "Enforced by test"
naming a file, it does not belong in this section.

## Rationale ("don't") — advisory

The unenforceable guidance that stops plausible-looking bad changes.

- **Don't widen the handler annotation to the union type.** The narrow
  type is what makes the `?: never` guarantees bite; the union accepts
  any branch.
- **Don't move `X` to its natural home in folder `Y`.** The arch test
  in folder `Z` forbids `Y → Z` and the indirection is intentional.

These are advisory. An agent can follow them or not; no test catches
the violation. They are kept because deleting them produces predictable
regressions, not because they are enforceable.

## Procedure — adding a new Foo

1. New file `foos/<name>.ts` exporting a `FooHandler`.
2. Add a `FOO_NAMES.<Name>` entry.
3. Register in `FooRegistry`.
4. Add `test/unit/foos/<name>.test.ts`.

Not enforced; this is a checklist for the multi-file change. The
individual rules in the checklist may be individually enforced by
other tests.
```

Four sections. Each one labeled. An agent that wants only the enforced contract reads "Enforced invariants" and can act on it with the same confidence as a type signature. An agent that wants to add a feature reads "Procedure." Neither has to guess.

Two rules for keeping this honest:

- **Every claim under "Enforced invariants" cites a file.** If you can't cite a test, the claim doesn't go there. This is the discipline that prevents folklore from creeping back in.
- **The "Rationale" section explains _why_, not _what_.** The "what" is in the code. Rationale that paraphrases the code is the same rot the first essay warned about; rationale that explains the historical decision or the rejected alternative is load-bearing.

The audit-and-prune loop from the first essay still applies, but now it has a clearer target: **claims under "Enforced invariants" that no longer cite a real test**. Those are the rot. Folklore in the "Rationale" section is not rot — it's the unliftable content, kept on purpose.

---

## 6. The maturity ladder is per-subsystem

A real codebase has subsystems at different levels. The first essay's single-number ladder hides this. A more useful version:

For each major subsystem (provider, security, persistence, UI, tool registry, …) ask:

- **L0 (folklore)** — rules live in comments and tribal knowledge. No orientation doc.
- **L1 (orientation)** — has an `AGENTS.md` or `README.md` with purpose and file map. Rules still mostly folklore.
- **L2 (tested)** — unit tests cover behavior. Some arch tests exist.
- **L3 (arch-enforced)** — meaningful arch-test coverage of layering and cross-cutting contracts. Orientation doc separates enforced from advisory.
- **L4 (type-enforced)** — every liftable rule is a type. The arch tests catch the rest. The orientation doc cites a test for every enforced claim.

Now: the codebase isn't an L2. The codebase has one L4 subsystem (the tool contract), one L3 (modular boundaries between top-level folders), one L1 (an older subsystem with a stale README), and three L0s (the ones nobody has touched in months).

The actionable question is not "raise the whole codebase a level." It's **"which L0 or L1 subsystem gets the most agent traffic?"** That's where the next lift returns the most safety per unit of work. A subsystem nobody touches can sit at L0 forever; an L4 subsystem with no edit traffic is a curio.

Track per-subsystem level. Track edit traffic per subsystem (PR count, file-touch count over the last quarter). Lift in order of traffic, not in order of how bad the current level is.

---

## 7. Pre-validated splits as queued agent tasks

A pattern that emerges from working on agent-friendly codebases for any length of time: **comments that name a future refactor are valuable in a way the first essay doesn't capture**.

```ts
// eslint-disable-next-line max-lines-per-function --
// TODO(split): extract per-stage handlers (setup, run, teardown).
```

This is not a regular `TODO`. It's a pre-validated split — someone has already decided the function should be split, articulated the split direction, and accepted the lint disable as a temporary debt. An agent picking this up has:

- A bounded task (one function, one file).
- A clear direction (the comment says how).
- A clear definition of done (the `eslint-disable` comes off).
- Locally testable scope (existing tests cover the function's behavior).

This is roughly the ideal shape of an agent task. The pattern: **when you can't split a function in the PR you're in, leave a precise `TODO(split)` instead of a vague `TODO`**. The precise version converts a vague "this is messy" into a queued task.

Keep an honest count of these. They're a kind of structured technical debt — debt that lists its own remediation. Agents do well on them; humans do well on them; nobody has to re-derive the split.

The general form: any rule that says "do X eventually" should name X concretely enough that the eventual doer doesn't have to redo the analysis. `TODO(split)`, `TODO(types)`, `TODO(arch-test)`, `TODO(security)` — the bracketed tag tells the next reader what kind of work is queued.

---

## 8. The cost ledger

The first essay's economics section makes a fair case (edits are cheaper, context is expensive, long-tail bugs scale). One number it doesn't put on the table: **the cost of a _bad_ lift**.

A lift that goes wrong looks like this:

- The new type is over-constrained. Legitimate cases now fail to typecheck and require `as unknown as` casts.
- The casts spread. Each one is documented locally; collectively they undermine the lift.
- Six months later, half the call sites are working around the type system. The lift produced more confusion than it prevented.

The countermeasure is not to lift less; it's to lift the right things. The properties of a lift that's worth doing:

- The matrix being lifted is **exhaustive in the current code**. You know every valid combination. There aren't legitimate edge cases the types will reject.
- The matrix has **a small number of variants** (typically 2–5). Larger matrices tend to discover combinations during the lift and force the design wider.
- The contract is **load-bearing**. Multiple consumers branch on the field. A loose contract here has cost a real bug.
- The migration cost is **bounded and known**. You've grepped the consumers before starting.

A lift that fails one of these tests is a candidate for an arch test instead. Arch tests are weaker than types but cheaper to relax later; types are stronger but more expensive to undo. **When in doubt, arch-test first, type-lift later.**

The `as unknown as` count in the repo is a useful health indicator. A growing count is a sign of lifts that overshot. A decreasing count is a sign of lifts that found their proper shape.

---

## 9. Where to start, revised

The first essay's "where to start" sequence is workable but undifferentiated. A better-prioritized version:

1. **Measure first.** Count `AGENTS.md` / `README.md` files per significant directory. Count arch tests. Count `as unknown as` casts. Count `TODO(split)`-style markers. These four numbers tell you which subsystems are at which level.
2. **Pick the highest-traffic subsystem at L0 or L1.** Add an orientation doc with the four-section template above. Cite tests where you can; label the rest as rationale.
3. **Convert the two or three folklore rules in that doc that read most like "remember to."** "Remember to call X before Y" → capability token. "No file may import Z outside W" → arch test. The pattern from the first essay's section 4 still applies; the new discipline is **convert them in the doc-writing PR**, not as separate follow-ups.
4. **Audit the existing `as unknown as` casts in the subsystem.** Each one is either a justified third-party boundary (annotate with a disable comment that says so) or an unfinished lift (file a `TODO(types)` with the specific reshape needed).
5. **Pick one pre-validated split. Do it.** This is the easiest agent task in the repo. It establishes that the queued-task pattern works and gives you a calibration point for how the codebase responds to splits.
6. **Repeat from step 2 on the next-highest-traffic L0 or L1 subsystem.** The work compounds: each per-subsystem lift makes the next one easier because shared infrastructure (the arch-test framework, the type patterns, the orientation template) is already in place.

Step 1 is the addition that the first essay's sequence skips. Without it, "where to start" reduces to taste. With it, the next move is mechanical.

---

## 10. The honest closing

The first essay closes with "most of these techniques are also better for humans." Mostly true.

The honest qualifier: **the priority order is genuinely different**. A human reading `class FooService extends AbstractServiceBase implements ServiceMixin<Foo>` mildly groans and reads the parent class. An agent silently does a worse job because the inheritance is invisible in the context window. A human reading a `success: boolean` with five optional flags learns the matrix once and remembers it. An agent re-derives the matrix from comments every session and gets it wrong some fraction of the time.

The patterns that look like over-engineering in a human-only codebase are often the same patterns. What changes is the multiplier on the cost of _not_ having them. In a codebase edited a thousand times a year by agents, that multiplier is roughly three orders of magnitude larger than it used to be.

So the work is real. The framing — "incremental, per-subsystem, traffic-prioritized, with the migration cost budgeted" — is what makes it tractable. Pick one subsystem. Write the four-section orientation doc. Lift the two rules that the doc tells you are folklore-pretending-to-be-rules. Land it with the migration. Move on.

The codebase improves one subsystem at a time. None of it requires permission, none of it is a rewrite, and each step pays off independently — including when you stop.
