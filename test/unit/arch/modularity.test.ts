import { describe, it } from 'node:test';
import assert from 'node:assert';
import { projectFiles } from 'archunit';

// Architectural safeguards for the module boundaries documented in
// ARCHITECTURE.md. Each rule is run through ArchUnitTS's framework-agnostic
// `.check()` and is expected to return an empty violations list.

async function expectNoViolations(
  rule: { check: () => Promise<unknown[]> },
  label: string,
) {
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
    for (const upstream of ['src/ui/**', 'src/tools/**', 'src/core/**', 'src/mcp/**', 'src/cli/**']) {
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
        except: [
          'src/tools/types.ts',
          'src/tools/registry.ts',
          'src/tools/index.ts',
        ],
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
      .adhereTo((file) => {
        for (const m of file.content.matchAll(importRegex)) {
          if (bannedSdks.includes(m[1])) return false;
        }
        return true;
      }, 'UI files must not import LLM/network SDKs directly — go through src/providers/registry');
    await expectNoViolations(rule, 'ui → SDK packages');
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
      .adhereTo((file) => {
        for (const m of file.content.matchAll(importRegex)) {
          if (bannedNodeModules.includes(m[1])) return false;
        }
        return true;
      }, 'UI files must not perform direct HTTP or process IO — go through providers/tools');
    await expectNoViolations(rule, 'ui → node network/process modules');
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
      .adhereTo((file) => {
        for (const m of file.content.matchAll(importRegex)) {
          if (bannedCliLibs.includes(m[1])) return false;
        }
        return true;
      }, 'CLI argument parsing is hand-rolled in src/cli/args.ts — do not introduce a parsing library');
    await expectNoViolations(rule, 'src → CLI parsing library');
  });
});
