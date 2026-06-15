import { describe, it } from 'node:test';
import assert from 'node:assert';
import { projectFiles } from 'archunit';
import { expectNoViolations, getMorphProject, relPath } from './_helpers.js';

// §A Layer Dependency rules. Folder-level "X ↛ Y" boundaries.
// See MODULARITY_RULES.md §A.

describe('architecture §A: layer dependencies', () => {
  // Providers are HTTP adapters; arbitrary filesystem reads belong in
  // core/config or tools. The two allowlisted files read on-disk auth
  // tokens written by external CLIs (gh, gcloud) — that's a legitimate
  // boundary read and the only reason providers ever need `fs`. A new
  // `node:fs` import elsewhere under src/providers/** almost always
  // means a config-style concern has leaked into an HTTP adapter.
  it('src/providers/** must not import node:fs outside the auth-token allowlist', async () => {
    const allowed = new Set([
      'src/providers/copilot/auth.ts',
      'src/providers/googleaistudio/auth.ts',
    ]);
    const fsImport = /(?:from|require\()\s*['"](node:)?fs(\/promises)?['"]/;
    const rule = projectFiles()
      .inFolder('src/providers/**')
      .should()
      .adhereTo(file => {
        if (allowed.has(file.path)) return true;
        return !fsImport.test(file.content);
      }, 'providers are HTTP adapters — filesystem reads belong in core/config or tools (auth-token readers are the allowlisted exception)');
    await expectNoViolations(rule, 'providers → node:fs');
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

  // core → providers boundary.
  //
  // src/core/ houses the agent loop and all orchestration logic. It must
  // depend on providers only through declared contracts:
  //
  //   - types.ts    : Provider interface + shared value types (permanent)
  //   - prime.ts    : UnprimedProvider → Provider bridge (permanent)
  //   - usage.ts    : contextFillTokens selector (permanent)
  //   - sampling-defaults.ts : model sampling table shared by both layers (permanent)
  //
  // Remaining entries are TODOs — each allowlist entry is a tracked
  // violation to be removed as the corresponding fix lands:
  //
  //   - auth-modes.ts  : TODO inline GoogleAiStudioAuthMode as 'oauth'|'api-key'
  //                      literal in core/config/types.ts
  //   - registry.ts    : TODO hardcode LEGACY_TOKEN_KEY in core/auth/credentials.ts
  //                      (remove DESCRIPTOR_LIST import) and move ProviderDescriptor
  //                      type from registry.ts → providers/types.ts
  it('src/core/** must not depend on src/providers/** (except permitted contracts)', async () => {
    const rule = projectFiles()
      .inFolder('src/core/**')
      .shouldNot()
      .dependOnFiles()
      .inFolder('src/providers/**', {
        except: [
          'src/providers/types.ts',
          'src/providers/prime.ts',
          'src/providers/usage.ts',
          'src/providers/sampling-defaults.ts',
        ],
      });
    await expectNoViolations(rule, 'core → providers concrete impls');
  });

  // Tool seam: core/ may reach tools/ only through src/tools/host.ts.
  // host.ts surfaces a read-only ToolHost interface plus the type
  // re-exports (ToolHandler, ToolResult, ToolContext, ToolDefinition,
  // TOOL_NAMES, ToolResolutionError) that core needs to invoke tools.
  // Concrete impls (types.ts, registry.ts, errors.ts, every handler
  // file) are off-limits. The matching reverse rule below blocks
  // tools/ from reaching back into core/.
  it('src/core/** must depend on src/tools/** only through tools/host.ts', async () => {
    const rule = projectFiles()
      .inFolder('src/core/**')
      .shouldNot()
      .dependOnFiles()
      .inFolder('src/tools/**', {
        except: ['src/tools/host.ts'],
      });
    await expectNoViolations(rule, 'core → tools only via host.ts');
  });

  // Orchestration-tool exception: src/tools/delegate.ts and
  // src/tools/invoke-skill.ts are not leaf tools — they are wire-level
  // façades over core capabilities (subagent runner, skill invocation)
  // and must drive core directly. Every OTHER file in tools/ is a leaf
  // and is blocked from importing core/.
  //
  // Exit condition: if a future refactor moves the delegate/skill
  // entrypoints onto the seam (e.g. by injecting them through
  // ToolHost), these allowlist entries can be removed.
  it('src/tools/** must not depend on src/core/** (except orchestration tools)', async () => {
    const rule = projectFiles()
      .inFolder('src/tools/**', {
        except: ['src/tools/delegate.ts', 'src/tools/invoke-skill.ts'],
      })
      .shouldNot()
      .dependOnFiles()
      .inFolder('src/core/**');
    await expectNoViolations(rule, 'tools ↛ core (seam is one-way; orchestration tools exempted)');
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
        .inFolder('src/providers/**')
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

  // System never imports UI. Mirrors the existing core/providers/mcp
  // rules; codifies the AgentEvent invariant (UI consumes events from
  // system, never the reverse). True today; this rule makes drift fail
  // CI rather than waiting for review to catch it.
  it('src/tools/** must not depend on src/ui/**', async () => {
    const rule = projectFiles()
      .inFolder('src/tools/**')
      .shouldNot()
      .dependOnFiles()
      .inFolder('src/ui/**');
    await expectNoViolations(rule, 'tools → ui');
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

  // src/index.ts is the entry-point bootstrap. Cross-layer wiring lives
  // in src/cli/startup/main.ts (and the phase helpers it composes).
  // index.ts should only:
  //   - import the runMain orchestrator and the error renderer
  //   - install top-level process error handlers
  //   - call runMain()
  //
  // Codifying the thinness as line count is crude but effective: any
  // future drift that puts wiring back into index.ts will trip this
  // rule and force the work back into cli/startup/. The cap matches
  // what the current bootstrap needs with comments stripped.
  it('src/index.ts is a thin bootstrap (no startup wiring)', async () => {
    const project = getMorphProject();
    const indexFile = project.getSourceFile('src/index.ts');
    assert.ok(indexFile, 'src/index.ts must exist');
    const stripped = indexFile
      .getFullText()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
    const MAX_NON_TRIVIAL_LINES = 30;
    assert.ok(
      stripped.length <= MAX_NON_TRIVIAL_LINES,
      `src/index.ts has ${stripped.length} non-trivial lines (max ${MAX_NON_TRIVIAL_LINES}). Wiring belongs in src/cli/startup/main.ts.`,
    );
    // Index must not reach into core/providers/tools/mcp/security
    // directly — that's startup's job. It may import from ui/ (renderer)
    // and utils/ (error formatting) only.
    const FORBIDDEN_LAYERS = [
      'src/core/',
      'src/providers/',
      'src/tools/',
      'src/mcp/',
      'src/security/',
    ];
    const violations: string[] = [];
    for (const decl of indexFile.getImportDeclarations()) {
      const target = decl.getModuleSpecifierSourceFile();
      if (!target) continue;
      const targetPath = relPath(target.getFilePath());
      for (const layer of FORBIDDEN_LAYERS) {
        if (targetPath.startsWith(layer)) {
          violations.push(
            `${targetPath} (import in src/index.ts must go through src/cli/startup/)`,
          );
        }
      }
    }
    assert.deepStrictEqual(
      violations,
      [],
      `src/index.ts must not reach into system layers directly:\n${violations.join('\n')}`,
    );
  });
});
