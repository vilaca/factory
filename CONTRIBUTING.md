# Contributing to factory

Thanks for considering a contribution. This guide covers everything you need to develop, test, and submit changes.

## Setup

Requirements: Node 22+, npm 10+. The repo pins Node via `.nvmrc`, so `nvm use` picks the right version.

```bash
git clone https://github.com/vilaca/factory.git
cd factory
nvm use            # picks Node 22 from .nvmrc
npm install
npm link           # makes `factory` available on PATH for local testing
```

To run a development build with auto-rebuild on save:

```bash
npm run dev
```

To run the binary directly without `npm link`:

```bash
node dist/index.js [...flags]
```

## Branch and commit conventions

- Branch from `main`. Use a feature-style name: `feature/<short-slug>`, `fix/<short-slug>`, `docs/<short-slug>`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`). The commit history shows the style this project uses.
- Keep commits focused. A bug fix is one commit; refactors that touch many files can be split per concern.
- One commit per feature on `main` (squash-on-merge is the project default).

## Testing

```bash
npm test              # full suite: lint + typecheck + unit + e2e
npm run test:unit     # unit tests only (fast, ~6s)
npm run test:e2e      # end-to-end tests via PTY harness
npm run test:e2e:fast # skip the tsc compile step (only valid after a recent build)
npm run coverage      # generates HTML + lcov coverage in coverage/
```

The unit tests use `node:test` (Node's built-in runner). E2E tests spawn the compiled binary in a real PTY via `test/cli-harness.ts`. Mock servers for Ollama and GitHub Copilot live in `test/mock-*.ts`.

Before opening a PR, run `npm run lint && npx tsc --noEmit && npm test`.

## Adding a provider

The codebase lives in `src/providers/`. There are two cases.

**OpenAI-compatible** (most providers — Cerebras, Groq, Mistral, Vercel, OpenRouter, Workers AI, etc.):

1. Implement the `Provider` interface from `src/providers/types.ts` using the shared helpers in `src/providers/_openai/`. Look at `src/providers/cerebras.ts` for a minimal example.
2. Add an entry to `src/providers/descriptors.ts` with label, aliases, env-var names, and default host.
3. Wire up the factory in `src/providers/registry.ts`.
4. Add unit tests in `test/unit/<provider>-provider.test.ts`. Follow the patterns in the existing provider tests.
5. Document the provider's env vars in `docs/providers.md` and add an example to `--help` in `src/cli/args.ts:printUsage`.

**Native protocol** (Anthropic, Ollama, HuggingFace, Cohere, Google AI Studio):

These don't share the OpenAI surface and have their own request/response shapes. Look at `src/providers/anthropic.ts` for the cleanest example. Define narrow types for the SDK responses; do not use `any` (the lint rule rejects it).

## Filing issues

Use the issue templates in `.github/ISSUE_TEMPLATE/`. For bug reports, include:

- `factory --version` output
- Operating system and Node version
- Provider and model
- Repro steps
- Relevant excerpt from the session log (`~/.factory/sessions/`) — redact tokens

For security issues, **do not open a public issue**. See [SECURITY.md](SECURITY.md) for the disclosure process.

## Versioning

The project follows [Semantic Versioning](https://semver.org/). Pre-1.0, breaking changes still bump the minor version (0.x.0); patch versions are reserved for non-breaking fixes. Tag releases as `vX.Y.Z`.

## Code style

- TypeScript strict mode is on, plus `noUncheckedIndexedAccess` and `noImplicitReturns`. Treat warnings from `tsc --noEmit` as errors.
- ESLint enforces complexity ceilings (`max-lines: 700`, `max-lines-per-function: 300`, `max-statements: 60`, `complexity: 25`, `cognitive-complexity: 30`). Functions that exceed limits use `// eslint-disable-next-line ... -- TODO(complexity): <plan>`. Don't add new debt.
- `any` is `error` in `src/`. Use proper types or narrow `unknown`. Tests are allowed to use `any` for mocks.
- Prefer editing existing files over creating new ones. New helper modules need a clear domain reason.

## Architecture overview

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full module map and data-flow walkthrough.
