import { describe, it } from 'node:test';
import assert from 'node:assert';
import { projectFiles } from 'archunit';

// Architectural safeguards for the module boundaries documented in
// ARCHITECTURE.md. Each rule is run through ArchUnitTS's framework-agnostic
// `.check()` and is expected to return an empty violations list.

async function expectNoViolations(rule: { check: () => Promise<unknown[]> }, label: string) {
  const violations = await rule.check();
  assert.deepStrictEqual(
    violations,
    [],
    `${label} — ${violations.length} violation(s):\n${JSON.stringify(violations, null, 2)}`,
  );
}

describe('architecture: module boundaries', () => {
  it('src/** has no cyclic imports', async () => {
    const rule = projectFiles().inFolder('src/**').should().haveNoCycles();
    await expectNoViolations(rule, 'cycles in src/**');
  });

  it('src/core/** must not depend on src/ui/**', async () => {
    const rule = projectFiles()
      .inFolder('src/core/**')
      .shouldNot()
      .dependOnFiles()
      .inFolder('src/ui/**');
    await expectNoViolations(rule, 'core → ui');
  });

  it('src/core/** must not depend on src/cli/**', async () => {
    const rule = projectFiles()
      .inFolder('src/core/**')
      .shouldNot()
      .dependOnFiles()
      .inFolder('src/cli/**');
    await expectNoViolations(rule, 'core → cli');
  });

  it('src/security/** is a primitive — must not depend on any sibling top-level folder', async () => {
    for (const upstream of [
      'src/providers/**',
      'src/ui/**',
      'src/core/**',
      'src/mcp/**',
      'src/tools/**',
      'src/cli/**',
    ]) {
      const rule = projectFiles()
        .inFolder('src/security/**')
        .shouldNot()
        .dependOnFiles()
        .inFolder(upstream);
      await expectNoViolations(rule, `security → ${upstream}`);
    }
  });

  it('src/utils/** must not depend on any sibling top-level folder', async () => {
    for (const upstream of [
      'src/core/**',
      'src/ui/**',
      'src/cli/**',
      'src/tools/**',
      'src/security/**',
      'src/mcp/**',
      'src/providers/**',
    ]) {
      const rule = projectFiles()
        .inFolder('src/utils/**')
        .shouldNot()
        .dependOnFiles()
        .inFolder(upstream);
      await expectNoViolations(rule, `utils → ${upstream}`);
    }
  });

  it('src/providers/** must not depend on src/ui/, src/tools/, src/core/, src/mcp/, or src/cli/', async () => {
    for (const upstream of [
      'src/ui/**',
      'src/tools/**',
      'src/core/**',
      'src/mcp/**',
      'src/cli/**',
    ]) {
      const rule = projectFiles()
        .inFolder('src/providers/**', {
          except: ['src/providers/registry.ts', 'src/providers/copilot/auth.ts'],
        })
        .shouldNot()
        .dependOnFiles()
        .inFolder(upstream);
      await expectNoViolations(rule, `providers → ${upstream}`);
    }
  });

  it('src/mcp/** must not depend on src/ui/**', async () => {
    const rule = projectFiles()
      .inFolder('src/mcp/**')
      .shouldNot()
      .dependOnFiles()
      .inFolder('src/ui/**');
    await expectNoViolations(rule, 'mcp → ui');
  });

  it('src/providers/openai/** is an internal adapter — no external importers', async () => {
    const rule = projectFiles()
      .inFolder('src/**', { except: 'src/providers/**' })
      .shouldNot()
      .dependOnFiles()
      .inFolder('src/providers/openai/**');
    await expectNoViolations(rule, 'openai adapter is internal to providers');
  });

  it('src/ui/headless.ts must not depend on the TUI tree', async () => {
    const rule = projectFiles()
      .inFolder('src/ui/**', { except: 'src/ui/tui/**' })
      .shouldNot()
      .dependOnFiles()
      .inFolder('src/ui/tui/**');
    await expectNoViolations(rule, 'headless → tui');
  });

  it('src/ui/** must not depend on src/mcp/**', async () => {
    const rule = projectFiles()
      .inFolder('src/ui/**')
      .shouldNot()
      .dependOnFiles()
      .inFolder('src/mcp/**');
    await expectNoViolations(rule, 'ui → mcp');
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

  it('src/ui/** must not import network SDK packages directly', async () => {
    const bannedSdks = [
      '@anthropic-ai/sdk',
      '@huggingface/inference',
      '@modelcontextprotocol/sdk',
      'ollama',
      'google-auth-library',
    ];
    const importRegex = /(?:from|require\()\s*['"]([^'"]+)['"]/g;
    const rule = projectFiles()
      .inFolder('src/ui/**')
      .should()
      .adhereTo(file => {
        for (const m of file.content.matchAll(importRegex)) {
          if (bannedSdks.includes(m[1])) return false;
        }
        return true;
      }, 'UI files must not import LLM/network SDKs directly — go through src/providers/registry');
    await expectNoViolations(rule, 'ui → SDK packages');
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
    const importRegex = /(?:from|require\()\s*['"](@modelcontextprotocol\/sdk[^'"]*)['"]/g;
    const rule = projectFiles()
      .inFolder('src/**')
      .should()
      .adhereTo(file => {
        if (allowed.has(file.path)) return true;
        for (const _m of file.content.matchAll(importRegex)) {
          return false;
        }
        return true;
      }, 'MCP SDK imports are confined to src/mcp/client.ts and src/mcp/adapter.ts');
    await expectNoViolations(rule, 'MCP SDK scoping');
  });

  it('src/ui/** must not import node networking or child-process modules directly', async () => {
    const bannedNodeModules = [
      'node:http',
      'node:https',
      'node:net',
      'node:dgram',
      'node:child_process',
      'http',
      'https',
      'net',
      'dgram',
      'child_process',
    ];
    const importRegex = /(?:from|require\()\s*['"]([^'"]+)['"]/g;
    const rule = projectFiles()
      .inFolder('src/ui/**')
      .should()
      .adhereTo(file => {
        for (const m of file.content.matchAll(importRegex)) {
          if (bannedNodeModules.includes(m[1])) return false;
        }
        return true;
      }, 'UI files must not perform direct HTTP or process IO — go through providers/tools');
    await expectNoViolations(rule, 'ui → node network/process modules');
  });

  // Prime-before-use contract for providers.
  //
  // Background: cf880ed fixed a bug where swap.ts called
  // `getCapabilities()` on a freshly-minted provider whose model-info
  // cache was empty — Anthropic's getCapabilities throws on a cache
  // miss. The same shape existed at several other call sites
  // (`compaction-resolver.ts`, `run-loop.ts`, `headless.ts`,
  // `Session.tsx`, `cli/startup/phases.ts`).
  //
  // The primary gate is now structural: `createProvider` returns
  // `UnprimedProvider` (see src/providers/types.ts and
  // src/providers/prime.ts), so calling `getCapabilities` /
  // `chat` / `chatNoStream` on a freshly-minted provider is a
  // compile error. This arch test is a belt-and-braces grep check
  // for the same shape: any file that BOTH mints a provider via
  // `createProvider(` AND reads capabilities via `getCapabilities(`
  // on the local scope must also call `prime(`, `listModels(`, or
  // `primeModelCache(` somewhere in the same file. `prime(` covers
  // the canonical post-split priming call; the other two are
  // grandfathered for files that call those methods directly
  // (e.g. priming via a separate explicit listModels).
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
  // TokenUsage field-plucking contract.
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

  it('files must not pair loadGlobalConfig with saveGlobalConfig — use updateGlobalConfig (f848472 contract)', async () => {
    const rule = projectFiles()
      .inFolder('src/**', { except: ['src/core/config/index.ts'] })
      .should()
      .adhereTo(file => {
        const src = file.content;
        const loads = /\bloadGlobalConfig\b/.test(src);
        const saves = /\bsaveGlobalConfig\b/.test(src);
        return !(loads && saves);
      }, 'loadGlobalConfig + saveGlobalConfig in the same file is RMW — use updateGlobalConfig');
    await expectNoViolations(rule, 'config RMW via load+save');
  });

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
    const rule = projectFiles()
      .inFolder('src/**', { except: ['src/tools/index.ts'] })
      .should()
      .adhereTo(file => {
        // Strip comments + string literals — doc comments that mention
        // the deprecated name (e.g. "@deprecated; use toolRegistry not
        // defaultRegistry") are legitimate and shouldn't trip the rule.
        // Mirrors the comment-stripper used in the status-bar contract
        // above. The remaining match is on bare identifier usage —
        // imports, references, anywhere in actual code.
        const code = file.content
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
          .replace(/"(?:\\.|[^"\\])*"/g, '""')
          .replace(/'(?:\\.|[^'\\])*'/g, "''");
        return !/\bdefaultRegistry\b/.test(code);
      }, 'defaultRegistry is a tests-only convenience — production must use options.toolRegistry');
    await expectNoViolations(rule, 'defaultRegistry singleton');
  });

  // console.* boundary.
  //
  // Background: agent output is streamed through `AgentEvent` and rendered
  // by the TUI; rogue `console.log` calls bypass that pipeline and either
  // corrupt the terminal (TUI mode) or appear out-of-band with no event-
  // log record (headless / session-log mode). Two legitimate consumers
  // exist:
  //
  //   - `src/cli/**` and `src/index.ts`: process startup before the TUI
  //     mounts. Direct stdio writes are the only thing that works pre-TUI.
  //   - `src/mcp/client.ts`: surfaces MCP connection failures during
  //     `connectAll()`, which runs at startup before any TUI is up. The
  //     error never has a corresponding `AgentEvent` because no agent is
  //     running yet.
  //
  // Every other source file routing through console.* is drift. Add the
  // file to the allowlist below only with the same kind of pre-TUI
  // justification, and update the comment block above to match.
  it('console.* writes are confined to startup files and the MCP connection surface', async () => {
    const allowed = new Set([
      'src/index.ts',
      'src/mcp/client.ts',
      'src/cli/args.ts',
      'src/cli/auth/flows.ts',
      'src/cli/auth/index.ts',
      'src/cli/prompts.ts',
      'src/cli/startup/phase-model-selection.ts',
      'src/cli/startup/phase-provider-connect.ts',
      'src/cli/startup/phase-rotation.ts',
      'src/cli/startup/phase-runtime-lifecycle.ts',
      'src/cli/startup/phase-trust-and-subagent.ts',
    ]);
    const consoleRegex = /\bconsole\.(log|error|warn|info|debug|trace|dir|table|group|groupEnd|time|timeEnd|count|assert)\b/;
    const rule = projectFiles()
      .inFolder('src/**')
      .should()
      .adhereTo(file => {
        if (allowed.has(file.path)) return true;
        // Strip comments + string literals so docs that mention `console.log`
        // in a JSDoc comment don't trip the rule. Mirrors the strip used in
        // the defaultRegistry test above.
        const code = file.content
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
          .replace(/"(?:\\.|[^"\\])*"/g, '""')
          .replace(/'(?:\\.|[^'\\])*'/g, "''")
          .replace(/`(?:\\.|[^`\\])*`/g, '``');
        return !consoleRegex.test(code);
      }, 'console.* must go through AgentEvent / session log — startup files and MCP client are the only allowed boundary');
    await expectNoViolations(rule, 'console.* boundary');
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
});
