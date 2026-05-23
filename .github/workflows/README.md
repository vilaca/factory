# GitHub Actions Workflows

Each test script and each validation runs as its own workflow so failures
are surfaced and re-runnable independently in the PR checks list.

Validations (run on push to `main` and on PR):

- `lint.yml` — `eslint`.
- `typecheck.yml` — `tsc --noEmit`.
- `format-check.yml` — `prettier --check` (advisory; the workflow reports failure on drift but should not be marked required in branch protection).
- `knip.yml` — unused-export / dependency check (advisory; the workflow reports failure on issues but should not be marked required in branch protection).

Tests (run on push to `main` and on PR):

- `test-unit-providers.yml` — `npm run test:unit:providers` (gating).
- `test-unit-core.yml` — `npm run test:unit:core` (gating).
- `test-unit-rest.yml` — `npm run test:unit:rest` (gating; arch/cli/mcp/security/tools/ui/utils).
- `test-unit-coverage.yml` — `npm run coverage` (advisory threshold check; runs the full unit suite under c8).
- `test-e2e-mocks.yml` — `npm run test:e2e:mocks`.
- `test-e2e-no-mocks.yml` — `npm run test:e2e:no-mocks`.
- `test-e2e-headless.yml` — `npm run test:e2e:headless` (headless CLI/tools/hooks/mcp/etc.).
- `test-e2e-pty.yml` — `npm run test:e2e:pty` (slash-commands/tabs/picker/plan-mode).

Docs:

- `docs.yml` — builds and deploys the VitePress site to GitHub Pages.
