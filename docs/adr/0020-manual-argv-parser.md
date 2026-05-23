# 0020 — Manual argv parser; no `commander` / `yargs`

- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

CLI argument parsing is a solved problem with multiple mature libraries. The cost of pulling one in, however, is structural: every CLI library brings opinions about help formatting, subcommand routing, async lifecycle, and validation, and those opinions silently shape what the CLI surface can look like later. A flag that doesn't fit the library's pattern requires a workaround; the workaround accumulates until the library becomes part of the maintenance burden it was supposed to reduce.

The argv surface here is small — a flat set of flags, no nested subcommands, no plugin architecture — and the codebase has a stated preference for low-dependency, well-understood implementations (`README.md` lists the entire dependency footprint deliberately).

## Decision

`src/cli/args.ts` implements its own argv parser. It is a flat scan: known flags consume their argument (if any), unknown flags fail fast with a helpful message, and `--help` / `--version` are intercepted before any other parsing. `printUsage()` and `printVersion()` live in the same file. The CLI does not depend on `commander`, `yargs`, `meow`, or any other parsing library.

## Consequences

**Easier.**

- The CLI surface is what the parser implements — no library-imposed structure to work around.
- The full parsing logic fits on one screen; behavior under unusual inputs (`--flag=`, `--flag value`, `--`) is grep-visible.
- Zero parsing dependency means zero parsing transitive supply-chain surface.

**Harder.**

- Subcommands, if they ever happen, are extra work. The current surface doesn't have any and the project does not anticipate them; if it ever does, the parser grows or is replaced — but that's a decision that gets its own ADR.
- Help formatting is hand-rolled. New flag additions must update both the parser and `printUsage()` in lock-step; a flag that parses but doesn't appear in `--help` is a documentation regression caught only by review or e2e tests.

**Invariants future contributors must preserve.**

- No CLI parsing library. If the surface ever outgrows the manual parser, write a new ADR superseding this one and replace the parser wholesale; do not paper over with a library that handles only some flags.
- Every new flag updates `printUsage()` and ideally also the e2e tests that snapshot `--help` output.
- `--help` and `--version` are intercepted first. Order matters because `--debug` and other side-effecting flags would otherwise fire before help is printed.

## Enforcement

`test/unit/arch/modularity.test.ts` — the `src/** must not import a CLI argument-parsing library` rule fails CI if any file under `src/` imports one of `commander`, `yargs`, `yargs/yargs`, `yargs/helpers`, `meow`, `minimist`, `arg`, `cmd-ts`, `sade`, `mri`, or `cac`. Same shape as the SDK and Node-module deny lists in [ADR 0008](0008-ui-is-presentation-only.md). If a future ADR overturns this decision, narrow the rule with an `except: [...]` carve-out rather than removing it.
