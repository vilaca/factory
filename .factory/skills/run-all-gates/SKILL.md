---
name: run-all-gates
description: Run all tests and quality gates on the project.
when_to_use: When you need to validate the project's code quality, run tests, check for TypeScript errors, linting violations, unused code, and formatting issues.
argument-hint: ''
allowed-tools:
  - Bash(npm *)
  - Bash(npx *)
disable-model-invocation: false
user-invocable: true
context: current
shell: bash
alwaysOn: false
---

Run all quality gates in sequence using the Bash tool. Run each command, show its output, then report a final summary of which passed and which failed.

1. `npm run check:types`
2. `npm run lint`
3. `npm run test:unit`
4. `npm run knip`
5. `npm run check-circular`
6. `npm run format:check`
