# GitHub Actions Workflows

Each test script and each validation runs as its own workflow so failures
are surfaced and re-runnable independently in the PR checks list.

Validations (run on push to `main` and on PR):

- `lint.yml` — `eslint`.
- `typecheck.yml` — `tsc --noEmit`.
- `format-check.yml` — `prettier --check` (advisory; the workflow reports failure on drift but should not be marked required in branch protection).
- `knip.yml` — unused-export / dependency check (advisory; the workflow reports failure on issues but should not be marked required in branch protection).

Tests (run on push to `main` and on PR):

- `test-unit.yml` — runs the unit suite as three parallel matrix shards (`providers`, `core`, `rest`), each gating. Each shard runs under c8, uploads its partial coverage as an artifact, and a downstream `coverage` job merges the artifacts and runs `c8 report --check-coverage` against the project thresholds (advisory; the report step is `continue-on-error`). The shard scripts and the merge step are also reproducible locally via `npm run coverage`.
- `test-e2e-mocks.yml` — `npm run test:e2e:mocks`.
- `test-e2e-no-mocks.yml` — `npm run test:e2e:no-mocks`.
- `test-e2e-headless.yml` — `npm run test:e2e:headless` (headless CLI/tools/hooks/mcp/etc.).
- `test-e2e-pty.yml` — `npm run test:e2e:pty` (slash-commands/tabs/picker/plan-mode).

Docs:

- `docs.yml` — builds and deploys the VitePress site to GitHub Pages.
