import { describe, it } from 'node:test';
import assert from 'node:assert';
import { projectFiles } from 'archunit';
import { expectNoViolations, getMorphProject, relPath } from './_helpers.js';

// §C Runtime Safety / Policy rules. Invariants the type system can't
// express on its own — things like "this function may not read
// process.env" or "this module must not be a process-global mutable
// singleton". Includes the §F regression contracts that reinforce
// runtime invariants (44aeb26, f848472).
// See MODULARITY_RULES.md §C.

describe('architecture §C: runtime contracts', () => {
  // Security primitives are shaped as pure functions of (input, policy).
  //
  // src/security/{paths,env,bash-rules,permissions}.ts take policy
  // objects (PathPolicy, EnvPolicy, BashRule[]) as arguments. The caller
  // computes the snapshot once at a session / turn boundary and threads
  // it through. A security function that reads `process.cwd()` or
  // `process.env` directly bypasses the policy it was handed and
  // substitutes whatever the parent process happens to have — which
  // defeats the only enforcement the boundary provides.
  //
  // The case that matters most today: `env.ts` exists specifically to
  // gate which env vars a subprocess can inherit, because process.env
  // contains every secret in the user's shell (provider keys, GitHub
  // tokens, AWS credentials). A security function that reads process.env
  // directly silently makes everything visible regardless of what
  // EnvPolicy permitted. The cwd case is the same shape but lower-
  // impact in practice — Bash runs each command in its own subshell so
  // `cd` inside a tool call doesn't actually mutate the parent's cwd.
  //
  // Future scenarios where the snapshot discipline starts mattering more:
  // multi-session daemons (two sessions can hold different cwds in the
  // same process) and parallel subagents (each scoped to a different
  // working set). The architecture is shaped for both; the arch test
  // keeps the security layer ready for them without requiring a future
  // audit.
  //
  // Zero current violations. Comment-only mentions of process.cwd /
  // process.env in JSDoc (e.g. the threat-model note in env.ts) are
  // exempted via the strip-comments pass mirrored from the
  // defaultRegistry contract above.
  it('src/security/** must read policy snapshots, not process.cwd() / process.env directly', async () => {
    const banned = /\bprocess\.(cwd|env)\b/;
    const rule = projectFiles()
      .inFolder('src/security/**')
      .should()
      .adhereTo(file => {
        const code = file.content
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
          .replace(/"(?:\\.|[^"\\])*"/g, '""')
          .replace(/'(?:\\.|[^'\\])*'/g, "''")
          .replace(/`(?:\\.|[^`\\])*`/g, '``');
        return !banned.test(code);
      }, 'security primitives must accept PathPolicy / EnvPolicy as arguments — direct process.cwd() / process.env reads bypass the policy snapshot the caller passed in');
    await expectNoViolations(rule, 'security process-state isolation');
  });

  // defaultRegistry singleton contract.
  //
  // Background: src/tools/index.ts exports a `defaultRegistry` populated
  // with the built-in tools. Production code used to import it directly
  // and mutate it at CLI startup (registering MCP and subagent tools);
  // that turned the registry into process-global state and foreclosed on
  // any feature that wants per-session tool sets (multi-session daemon,
  // parallel subagents with different scopes, dynamic plug-in/out).
  //
  // Production code now constructs `new ToolRegistry()` in src/index.ts
  // and threads it through `appOptions.toolRegistry`. `defaultRegistry`
  // is kept ONLY as a tests convenience. Enforce: no source file under
  // src/** (other than the file that defines it) imports defaultRegistry.
  it('production code outside src/tools/index.ts must not import defaultRegistry', async () => {
    const violations: string[] = [];
    for (const sf of getMorphProject().getSourceFiles()) {
      const rel = relPath(sf.getFilePath());
      if (!rel.startsWith('src/') || rel === 'src/tools/index.ts') continue;
      if (
        sf
          .getImportDeclarations()
          .some(d => d.getNamedImports().some(n => n.getName() === 'defaultRegistry'))
      ) {
        violations.push(rel);
      }
    }
    assert.deepStrictEqual(
      violations,
      [],
      `defaultRegistry singleton — ${violations.length} violation(s):\n${JSON.stringify(violations, null, 2)}`,
    );
  });

  // Config RMW contract.
  //
  // Background: f848472 fixed a race where `Session` did
  // `read-config → mutate → write-config` without holding the config
  // mutex. Two tabs hitting rate limits would clobber each other's
  // writes. The fix routed all dependent updates through
  // `updateGlobalConfig(fn)`, which holds the mutex across the read,
  // transform, and write.
  //
  // The contract: when a new value depends on the prior value, callers
  // MUST use `updateGlobalConfig`. `loadGlobalConfig` + `saveGlobalConfig`
  // is reserved for unconditional updates (token saves, auth-mode flag,
  // etc.). We can't fully verify "depends on prior" statically, but we
  // can catch the necessary condition: any file that imports BOTH
  // `loadGlobalConfig` AND `saveGlobalConfig` is almost certainly doing
  // RMW — flag it.
  //
  // The one legitimate exception is `src/core/config/index.ts` itself
  // (the migration code path calls saveGlobalConfig from inside
  // loadGlobalConfigUncached). It's allowlisted.
  it('files must not pair loadGlobalConfig with saveGlobalConfig — use updateGlobalConfig (f848472 contract)', async () => {
    const violations: string[] = [];
    for (const sf of getMorphProject().getSourceFiles()) {
      const rel = relPath(sf.getFilePath());
      if (!rel.startsWith('src/') || rel === 'src/core/config/index.ts') continue;
      const imported = new Set(
        sf.getImportDeclarations().flatMap(d => d.getNamedImports().map(n => n.getName())),
      );
      if (imported.has('loadGlobalConfig') && imported.has('saveGlobalConfig'))
        violations.push(rel);
    }
    assert.deepStrictEqual(
      violations,
      [],
      `config RMW via load+save — ${violations.length} violation(s):\n${JSON.stringify(violations, null, 2)}`,
    );
  });

  // TokenUsage field-plucking contract.
  //
  // ACTIVE GUARANTEE: this arch test is the load-bearing guard.
  // contextFillTokens() returns a plain `number`, indistinguishable
  // at the type level from `TokenUsage.totalTokens` — TypeScript
  // permits both. A structural upgrade to a branded type
  // (`ContextFillTokens = number & { readonly __brand: unique symbol }`)
  // would make the wrong assignment a compile error and let this
  // rule retire. Deferred; see MODULARITY_RULES.md §F.
  //
  // Background: 44aeb26 fixed a status-bar bug where the
  // context-fullness gauge fed `totalTokens` (= prompt + completion)
  // into the numerator. The figure jittered downward each turn
  // because completion tokens fold into the next prompt as a small
  // assistant message, not the full verbatim completion. The right
  // metric is `promptTokens`. `src/providers/usage.ts:contextFillTokens`
  // owns the answer.
  //
  // Enforce that the status-bar component (and any future similar
  // gauge) doesn't read TokenUsage fields directly — it must route
  // through contextFillTokens. We can't easily distinguish "reading
  // for context fullness" from "reading for cost analytics", so the
  // narrowest enforceable rule is: status-bar.tsx must not name
  // `totalTokens`, `completionTokens`, or `reasoningTokens` literally.
  // (`promptTokens` is permitted — it's the field the gauge cares
  // about, and contextFillTokens itself reads it.)
  it('status-bar.tsx must read TokenUsage only via contextFillTokens (44aeb26 contract)', async () => {
    const rule = projectFiles()
      .inFolder('src/ui/tui/components/**')
      .should()
      .adhereTo(file => {
        if (!file.path.endsWith('status-bar.tsx')) return true;
        // Strip comments + strings before the field-access check, so
        // mentions in docstrings ("see TokenUsage.totalTokens for why")
        // and string literals don't trip the rule. This is a
        // coarse-but-honest comment stripper — multi-line `/* */`,
        // single-line `//`, and double-quoted string literals — which
        // matches what status-bar.tsx actually uses.
        const code = file.content
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
          .replace(/"(?:\\.|[^"\\])*"/g, '""')
          .replace(/'(?:\\.|[^'\\])*'/g, "''");
        // Forbid plucking fields that have ever been mistaken for
        // "context fullness" (totalTokens being the original bug, the
        // others being the obvious next-wrong-guess). The StatusBar's
        // local variable named `totalTokens` is fine — it's the
        // displayed figure, not a `usage.totalTokens` field read — so
        // we only flag dotted member access (`something.totalTokens`).
        const fieldAccess = /\.(totalTokens|completionTokens|reasoningTokens)\b/;
        return !fieldAccess.test(code);
      }, 'status-bar.tsx reads TokenUsage fields directly — use contextFillTokens (44aeb26)');
    await expectNoViolations(rule, 'status-bar field-plucking');
  });
});
