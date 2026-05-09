# Security

Built-in protections that apply to every session, regardless of provider.

- **Path jail** rejects access to known secret paths (`~/.ssh`, `~/.aws`, `~/.gnupg`, `/etc/shadow`, etc.) before any I/O. Symlinks are resolved before the check. Built-ins can't be overridden, only extended.
- **Bash deny list** rejects `rm -rf /`, fork bombs, `curl ... | sh`, raw-device writes, force-push to protected branches. Cannot be bypassed by `allow-all`.
- **Env scrubbing** for spawned bash subprocesses — only a small safe-vars allowlist is forwarded. Provider API keys, GitHub tokens, AWS credentials and similar in your shell are NOT visible to model-driven commands.
- Bash, Edit, and Write run with your user permissions. Use `--plan` for untrusted models.

Configure additional bash patterns, path denies, and env-var allowlists via `permissions.bashRules` and `security.{bashEnv,paths}` in your config file. See [configuration.md](./configuration.md).

For the security disclosure process and what's in/out of scope, see [SECURITY.md](../SECURITY.md).
