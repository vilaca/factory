# Security Policy

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Use GitHub's [private vulnerability reporting](https://github.com/vilaca/factory/security/advisories/new) to disclose privately. Include:

- A description of the issue and its impact
- Steps to reproduce
- Affected version / commit
- Any suggested mitigation

You can expect an initial response within a few days. Coordinated disclosure is appreciated — please give us a reasonable window to ship a fix before any public write-up.

## Scope

In scope:

- The `factory` CLI and its bundled tools (Read, Write, Edit, Bash, Glob, Grep)
- Provider integrations in `src/providers/`
- Credential handling and on-disk storage (`~/.factory/config.json`)

Out of scope:

- Vulnerabilities in upstream provider APIs, model weights, or third-party services
- Issues that require an attacker to already have local code execution as the user
- Risks already documented in [docs/security.md](docs/security.md) (e.g. the Bash tool executes shell commands by design)
