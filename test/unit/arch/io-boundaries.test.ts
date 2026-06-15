import { describe, it } from 'node:test';
import { projectFiles } from 'archunit';
import { expectNoViolations } from './_helpers.js';

// §D IO / Integration Boundary rules. Restricts which modules can
// perform raw IO — direct network SDK use, node networking/child-process
// modules, and console.* writes. The TUI/headless boundary is the
// canonical channel for output; raw IO outside startup is drift.
// See MODULARITY_RULES.md §D.

describe('architecture §D: IO boundaries', () => {
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
      'src/cli/startup/main.ts',
      'src/cli/startup/phase-model-selection.ts',
      'src/cli/startup/phase-provider-connect.ts',
      'src/cli/startup/phase-rotation.ts',
      'src/cli/startup/phase-runtime-lifecycle.ts',
      'src/cli/startup/phase-trust-and-subagent.ts',
    ]);
    const consoleRegex =
      /\bconsole\.(log|error|warn|info|debug|trace|dir|table|group|groupEnd|time|timeEnd|count|assert)\b/;
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

  // process.exit boundary.
  //
  // Background: process.exit kills the process synchronously, dropping
  // any in-flight session-log writes and bypassing the cleanup phase
  // wired in src/cli/startup/phase-runtime-lifecycle.ts. The two
  // legitimate consumers are:
  //
  //   - startup / shutdown: src/index.ts, src/cli/**, and the phase
  //     files compose process lifetime explicitly.
  //   - headless mode: src/ui/headless/** owns the non-TUI exit code
  //     contract (strict-log failures, EOF on stdin), and src/ui/tui/**
  //     has two narrow uses — the App-level grace exit and the strict-
  //     logging init guard. Both run after a clean teardown.
  //
  // Anything else routing through process.exit is drift. AGENTS.md in
  // src/cli/startup/ codifies the inverse rule for phase code ("don't
  // call process.exit from a phase") — this test locks the boundary at
  // the file level.
  it('process.exit is confined to startup, headless, and the two TUI exit sites', async () => {
    const allowed = new Set([
      'src/index.ts',
      'src/cli/args.ts',
      'src/cli/prompts.ts',
      'src/cli/startup/main.ts',
      'src/cli/startup/phase-model-selection.ts',
      'src/cli/startup/phase-provider-connect.ts',
      'src/cli/startup/phase-rotation.ts',
      'src/cli/startup/phase-runtime-lifecycle.ts',
      'src/ui/headless/index.ts',
      'src/ui/headless/setup.ts',
      'src/ui/tui/App.tsx',
      'src/ui/tui/agent-loop/init.ts',
      'src/ui/tui/slash/handlers/tabs.ts',
    ]);
    const exitRegex = /\bprocess\.exit\s*\(/;
    const rule = projectFiles()
      .inFolder('src/**')
      .should()
      .adhereTo(file => {
        if (allowed.has(file.path)) return true;
        const code = file.content
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
          .replace(/"(?:\\.|[^"\\])*"/g, '""')
          .replace(/'(?:\\.|[^'\\])*'/g, "''")
          .replace(/`(?:\\.|[^`\\])*`/g, '``');
        return !exitRegex.test(code);
      }, 'process.exit drops in-flight session-log writes — route through the runtime-lifecycle cleanup or throw and let the top-level handler decide the exit code');
    await expectNoViolations(rule, 'process.exit boundary');
  });

  // process.stdout / process.stderr direct-write boundary.
  //
  // Mirrors the console.* rule above — otherwise the console boundary
  // is trivially bypassable by switching to `process.stdout.write`.
  // The same logic applies: agent output is streamed through AgentEvent
  // and rendered by the TUI; raw stdio writes corrupt the TUI or appear
  // out-of-band in headless mode.
  //
  // The allowlist is wider than console.* because headless mode is
  // exactly the surface that must write directly (no TUI, stdout is
  // the protocol). The legitimate consumers are:
  //
  //   - startup / shutdown surfaces (same as the console.* allowlist).
  //   - src/ui/headless/** — the protocol surface for non-TUI mode.
  //   - src/ui/logo.ts — pre-TUI splash; writes before ink mounts.
  //   - src/ui/diagnostics.ts — accepts an injectable `writeLine`; the
  //     default points at stderr for tests / one-off scripts.
  //   - src/utils/debug.ts — FACTORY_DEBUG gated debug channel.
  //   - src/core/config/validate.ts — startup-time config errors that
  //     fire before any TUI exists.
  //   - src/core/session/session-log/writer.ts — last-resort surface
  //     when the session log itself can't be written.
  //   - src/providers/instrument.ts — FACTORY_PROVIDER_TRACE diagnostic
  //     channel, opt-in via env var.
  it('process.stdout/stderr.write is confined to the headless protocol surface and pre-TUI startup', async () => {
    const allowed = new Set([
      'src/cli/startup/main.ts',
      'src/cli/startup/menu.tsx',
      'src/cli/startup/phase-runtime-lifecycle.ts',
      'src/core/config/validate.ts',
      'src/core/session/session-log/writer.ts',
      'src/providers/instrument.ts',
      'src/ui/agent-events/render.ts',
      'src/ui/diagnostics.ts',
      'src/ui/headless/event-handler.ts',
      'src/ui/headless/index.ts',
      'src/ui/headless/setup.ts',
      'src/ui/headless/teardown.ts',
      'src/ui/logo.ts',
      'src/utils/debug.ts',
    ]);
    const stdioRegex = /\bprocess\.(stdout|stderr)\.(write|cork|uncork)\b/;
    const rule = projectFiles()
      .inFolder('src/**')
      .should()
      .adhereTo(file => {
        if (allowed.has(file.path)) return true;
        const code = file.content
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
          .replace(/"(?:\\.|[^"\\])*"/g, '""')
          .replace(/'(?:\\.|[^'\\])*'/g, "''")
          .replace(/`(?:\\.|[^`\\])*`/g, '``');
        return !stdioRegex.test(code);
      }, 'direct stdio writes bypass the AgentEvent pipeline — route through events, or add the file to the allowlist with a pre-TUI / headless-protocol justification');
    await expectNoViolations(rule, 'process.stdout/stderr.write boundary');
  });
});
