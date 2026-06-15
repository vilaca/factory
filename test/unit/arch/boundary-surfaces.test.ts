import { describe, it } from 'node:test';
import assert from 'node:assert';
import { projectFiles } from 'archunit';
import { expectNoViolations, getMorphProject, relPath } from './_helpers.js';

// §B Boundary Surface rules. Locks the specific seam files that
// cross-layer imports must route through (and the regression contracts
// from §F that reinforce those seams).
// See MODULARITY_RULES.md §B.

describe('architecture §B: boundary surfaces', () => {
  it('src/providers/openai/** is an internal adapter — no external importers', async () => {
    const rule = projectFiles()
      .inFolder('src/**', { except: 'src/providers/**' })
      .shouldNot()
      .dependOnFiles()
      .inFolder('src/providers/openai/**');
    await expectNoViolations(rule, 'openai adapter is internal to providers');
  });

  it('src/ui/** must not import concrete provider implementations (only types/registry/descriptors)', async () => {
    const rule = projectFiles()
      .inFolder('src/ui/**')
      .shouldNot()
      .dependOnFiles()
      .inFolder('src/providers/**', {
        except: [
          'src/providers/types.ts',
          'src/providers/registry.ts',
          'src/providers/descriptors.ts',
          'src/providers/instrument.ts',
          // prime.ts is the canonical bridge from UnprimedProvider
          // (returned by createProvider) to Provider. UI call sites
          // that mint a provider must route through prime().
          'src/providers/prime.ts',
          // usage.ts is the canonical selector for "how full is my
          // next prompt?" — status-bar.tsx is the primary consumer.
          'src/providers/usage.ts',
        ],
      });
    await expectNoViolations(rule, 'ui → concrete provider impls');
  });

  it('src/ui/** must not import concrete tool handler files (only types/registry/index)', async () => {
    const rule = projectFiles()
      .inFolder('src/ui/**')
      .shouldNot()
      .dependOnFiles()
      .inFolder('src/tools/**', {
        except: ['src/tools/types.ts', 'src/tools/registry.ts', 'src/tools/index.ts'],
      });
    await expectNoViolations(rule, 'ui → concrete tool handlers');
  });

  // MCP SDK encapsulation contract.
  //
  // Background: the `@modelcontextprotocol/sdk` package owns the wire-
  // level Client/Transport types. Two MCP adapter files in this repo
  // (src/mcp/client.ts and src/mcp/adapter.ts) translate that surface
  // into a `ToolHandler[]` the agent loop consumes. Every other file
  // sees only `ToolHandler`/`McpManager` — the SDK types do not escape.
  //
  // If a future change imports `@modelcontextprotocol/sdk` from outside
  // those two files, the rest of the codebase grows a second pathway
  // into the SDK surface; the adapter stops being the sole boundary,
  // and bumping the SDK becomes an N-file refactor instead of a 2-file
  // one. Lock the boundary structurally.
  it('@modelcontextprotocol/sdk imports must be scoped to src/mcp/{client,adapter}.ts', async () => {
    const allowed = new Set(['src/mcp/client.ts', 'src/mcp/adapter.ts']);
    const violations: string[] = [];
    for (const sf of getMorphProject().getSourceFiles()) {
      const rel = relPath(sf.getFilePath());
      if (!rel.startsWith('src/') || allowed.has(rel)) continue;
      if (
        sf
          .getImportDeclarations()
          .some(d => d.getModuleSpecifierValue().startsWith('@modelcontextprotocol/sdk'))
      ) {
        violations.push(rel);
      }
    }
    assert.deepStrictEqual(
      violations,
      [],
      `MCP SDK scoping — ${violations.length} violation(s):\n${JSON.stringify(violations, null, 2)}`,
    );
  });

  // ModelSelection cross-cutting field contract.
  //
  // Background: 550f093 fixed a bug where `keyId` was silently dropped
  // at three intermediate hops between the picker and the agent loop.
  // The root cause: each hop had re-declared a `{ provider, model }`-
  // shaped DTO with a partial subset of the cross-cutting fields. Any
  // hop whose author forgot to copy a field on assignment silently
  // stripped it.
  //
  // The canonical record now lives in `src/core/selection/types.ts`
  // as `ModelSelection`. Adding a cross-cutting field there flows
  // through every hop automatically. To keep it that way, forbid new
  // type declarations whose body matches the `{ provider, model,
  // keyId? }` shape — they must alias or extend ModelSelection
  // instead.
  //
  // The check is a coarse regex on the file content (no AST), so it
  // can be fooled by creative formatting. It catches the obvious
  // case: a line containing `provider: string` followed within a few
  // lines by `model: string`. The selection module itself, and a few
  // legacy declarations with deliberately-different semantics (e.g.
  // `SessionStartMeta`, `ModelRequestMeta` — log records that
  // happen to contain provider+model but are NOT selections), are
  // allowlisted.
  it('files must not re-declare the {provider, model, keyId} shape — use ModelSelection (550f093 contract)', async () => {
    const allowlist = [
      // The canonical declaration.
      'src/core/selection/types.ts',
    ];
    const rule = projectFiles()
      .inFolder('src/**', { except: allowlist })
      .should()
      .adhereTo(file => {
        const src = file.content;
        // Catch the DTO shape — three field declarations
        // (`provider: string`, `model: string`, `keyId?: string` or
        // `keyId: string`) within a 5-line window. That window is
        // tight enough to skip false positives from positional
        // callback signatures (`onCommit: (provider: string, model:
        // string, keyId?: string) => void`) where `string` appears
        // inline as the parameter type, not as a property declaration.
        //
        // The regex matches DECLARATIONS only — `provider: string;`
        // at the start of a (whitespace-prefixed) line — not inline
        // function parameter types.
        const lines = src.split('\n');
        const fieldDecl = (name: string): RegExp =>
          new RegExp(`^\\s*${name}\\??\\s*:\\s*string\\s*[;,]?\\s*$`);
        for (let i = 0; i < lines.length; i++) {
          if (!fieldDecl('provider').test(lines[i] ?? '')) continue;
          const window = lines.slice(i, i + 6);
          const hasModel = window.some(l => fieldDecl('model').test(l));
          const hasKeyId = window.some(l => fieldDecl('keyId').test(l));
          if (hasModel && hasKeyId) return false;
        }
        return true;
      }, '{provider, model, keyId} shape re-declared — alias or extend ModelSelection (550f093)');
    await expectNoViolations(rule, 'ModelSelection re-declaration');
  });

  // Prime-before-use contract for providers.
  //
  // PRIMARY GUARANTEE (type system): `createProvider` returns
  // `UnprimedProvider` (see src/providers/types.ts and
  // src/providers/prime.ts), which omits `chat`, `chatNoStream`, and
  // `getCapabilities`. Calling any of those on a freshly-minted
  // provider is a compile error — the only way to acquire the full
  // `Provider` surface is to thread the value through `prime()`.
  //
  // THIS RULE (belt-and-braces): a grep-level cross-check that the
  // same shape isn't reintroduced by a future refactor that broadens
  // `createProvider`'s return type or adds a bypass that the type
  // system would no longer catch. It would also surface a file that
  // recreated the priming gap by aliasing through `any`/casts.
  //
  // Background: cf880ed fixed a bug where swap.ts called
  // `getCapabilities()` on a freshly-minted provider whose model-info
  // cache was empty — Anthropic's getCapabilities throws on a cache
  // miss. The same shape existed at several other call sites
  // (`compaction-resolver.ts`, `run-loop.ts`, `headless.ts`,
  // `Session.tsx`, `cli/startup/phases.ts`).
  //
  // Mechanics: any file that BOTH mints a provider via
  // `createProvider(` AND reads capabilities via `getCapabilities(`
  // on the local scope must also call `prime(`, `listModels(`, or
  // `primeModelCache(` somewhere in the same file. `prime(` covers
  // the canonical post-split priming call; the other two are
  // grandfathered for files that call those methods directly
  // (e.g. priming via a separate explicit listModels).
  it('files that mint a provider AND read capabilities must also prime via prime / listModels / primeModelCache', async () => {
    const rule = projectFiles()
      .inFolder('src/**')
      .should()
      .adhereTo(file => {
        const src = file.content;
        const mints = /\bcreateProvider\s*\(/.test(src);
        const reads = /\bgetCapabilities\s*\(/.test(src);
        if (!(mints && reads)) return true;
        const primes = /\b(prime|listModels|primeModelCache)\s*\(/.test(src);
        return primes;
      }, 'Provider mint + capability read without prime/listModels/primeModelCache priming (cf880ed contract)');
    await expectNoViolations(rule, 'prime-before-use on minted providers');
  });
});
