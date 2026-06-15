import { describe, it } from 'node:test';
import { projectFiles } from 'archunit';
import { expectNoViolations } from './_helpers.js';

// §E Structural Hygiene rules. Prevents long-term drift: no import
// cycles, every provider class is reachable from the registry, no
// external CLI argv library sneaks in, production code never imports
// compiled output, and shared event-render helpers stay in their
// canonical file.
// See MODULARITY_RULES.md §E.

describe('architecture §E: structural hygiene', () => {
  it('src/** has no cyclic imports', async () => {
    const rule = projectFiles().inFolder('src/**').should().haveNoCycles();
    await expectNoViolations(rule, 'cycles in src/**');
  });

  // Provider registration contract.
  //
  // Background: src/providers/registry.ts owns the canonical list of
  // providers — `DESCRIPTORS` plus the startup picker, alias resolution,
  // token discovery, and `createProvider()` factory routing. A new
  // Provider class file under src/providers/ that doesn't get added to
  // `DESCRIPTORS` is invisible to:
  //
  //   - the startup picker (`listProviderNames()`)
  //   - alias resolution (`descriptorByAlias()`)
  //   - `createProvider()` — the only way to mint a provider through the
  //     canonical mint → prime → use contract (cf880ed)
  //
  // The drift is silent: the class compiles, tests of the class itself
  // pass, but `--provider <new-name>` returns "Unknown provider" at
  // runtime. Lock the structural invariant: every provider class file
  // must be referenced from registry.ts.
  //
  // Heuristic: a "provider class file" is any `src/providers/**/*.ts`
  // that exports a class whose name ends in `Provider`. Sub-helpers
  // (auth modes, capabilities tables, request shapers) are exempted by
  // not matching the class-export pattern.
  it('every Provider class under src/providers/** is referenced from registry.ts', async () => {
    // Read registry.ts once for the membership check.
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const registrySource = await readFile(
      resolve(process.cwd(), 'src/providers/registry.ts'),
      'utf8',
    );
    const providerClassExport = /^export\s+class\s+([A-Z][A-Za-z0-9]*Provider)\b/m;
    const rule = projectFiles()
      .inFolder('src/providers/**')
      .should()
      .adhereTo(file => {
        // The registry itself is the membership store.
        if (file.path === 'src/providers/registry.ts') return true;
        const match = providerClassExport.exec(file.content);
        if (!match) return true; // not a Provider class file
        const className = match[1]!;
        // Two acceptable forms: a direct `import { Foo } from './foo.js'`
        // line, or a re-export aggregator that pulls the class in. We
        // just check for the identifier as a token in registry.ts; the
        // identifier is the load-bearing reference (used in the factory
        // body) so a stale comment can't satisfy the rule.
        const identifierRegex = new RegExp(`\\b${className}\\b`);
        return identifierRegex.test(registrySource);
      }, 'every Provider class file must be referenced from src/providers/registry.ts (add a DESCRIPTORS entry + import)');
    await expectNoViolations(rule, 'provider registration');
  });

  it('src/** must not import a CLI argument-parsing library', async () => {
    const bannedCliLibs = [
      'commander',
      'yargs',
      'yargs/yargs',
      'yargs/helpers',
      'meow',
      'minimist',
      'arg',
      'cmd-ts',
      'sade',
      'mri',
      'cac',
    ];
    const importRegex = /(?:from|require\()\s*['"]([^'"]+)['"]/g;
    const rule = projectFiles()
      .inFolder('src/**')
      .should()
      .adhereTo(file => {
        for (const m of file.content.matchAll(importRegex)) {
          if (bannedCliLibs.includes(m[1])) return false;
        }
        return true;
      }, 'CLI argument parsing is hand-rolled in src/cli/args.ts — do not introduce a parsing library');
    await expectNoViolations(rule, 'src → CLI parsing library');
  });

  it('production code must not import from dist or dist-test', async () => {
    const importRegex = /(?:from|require\(\))\s*['\"]([^'\"]+)['\"]/g;
    const rule = projectFiles()
      .inFolder('src/**')
      .should()
      .adhereTo(file => {
        for (const m of file.content.matchAll(importRegex)) {
          const importPath = m[1];
          if (importPath.includes('/dist/') || importPath.includes('/dist-test/')) {
            return false;
          }
        }
        return true;
      }, 'production code must import from source files, not compiled dist output');
    await expectNoViolations(rule, 'src → dist');
  });

  // `export *` widens a module's public surface without the author
  // listing what's now exposed. The §B boundary-surface rules pin
  // specific seam files (e.g. src/tools/host.ts) to a declared type
  // set; an `export * from './internal-thing.js'` in a seam silently
  // re-exports every symbol from the internal module and quietly
  // expands the seam set. Currently zero violations under src/**;
  // keep it that way so the seam allowlists stay meaningful.
  //
  // Type-only re-exports (`export type * from ...`) are equally
  // problematic for the same reason — banned by the same regex.
  it('src/** must not use `export *` re-exports', async () => {
    const reexportRegex = /^\s*export\s+(type\s+)?\*\s+from\b/m;
    const rule = projectFiles()
      .inFolder('src/**')
      .should()
      .adhereTo(
        file => !reexportRegex.test(file.content),
        "export * re-exports silently widen a module's public surface — list named exports instead so the seam stays auditable",
      );
    await expectNoViolations(rule, 'export * re-exports');
  });

  // Shared agent-event renderer contract.
  //
  // Background: src/ui/headless.ts and src/ui/tui/agent-loop/event-handler.ts
  // used to duplicate rotation/fingerprint/hook formatting — a divergence
  // would silently produce mismatched labels across surfaces. The helpers
  // now live in src/ui/agent-events/render.ts; both surfaces import from
  // there. Forbid any other source file from declaring a function with
  // those names (catches the most likely regression: someone reintroduces
  // the inline helper instead of importing).
  it('describeRotationReason / fingerprintLabel / formatHookDisplay must live only in src/ui/agent-events/render.ts', async () => {
    const rule = projectFiles()
      .inFolder('src/**', { except: ['src/ui/agent-events/render.ts'] })
      .should()
      .adhereTo(file => {
        // Allow imports — only forbid local declarations.
        const src = file.content;
        const localDecl =
          /\b(?:function|const|let|var)\s+(describeRotationReason|fingerprintLabel|formatHookDisplay)\b/;
        return !localDecl.test(src);
      }, 'shared event-render helpers must be imported from src/ui/agent-events/render.ts');
    await expectNoViolations(rule, 'shared renderer helpers');
  });
});
