export type PermissionDecision = 'allow' | 'deny' | 'allow-all' | 'allow-domain';

export class PermissionManager {
  private allowedTools: Set<string> = new Set();
  /** Hostnames the user has whitelisted for WebFetch this session. Distinct
   *  from `allowedTools`: a hostname here doesn't auto-allow the WebFetch
   *  tool overall; it just suppresses the prompt for matching URLs. */
  private allowedDomains: Set<string> = new Set();

  isAutoAllowed(toolName: string): boolean {
    return this.allowedTools.has(toolName.toLowerCase());
  }

  allowAll(toolName: string): void {
    this.allowedTools.add(toolName.toLowerCase());
  }

  /** True when `hostname` is in the per-session WebFetch whitelist.
   *  Compares case-insensitively; pass an already-parsed URL.hostname. */
  isDomainAllowed(hostname: string): boolean {
    return this.allowedDomains.has(hostname.toLowerCase());
  }

  /** Add a hostname to the per-session WebFetch whitelist. Idempotent. */
  allowDomain(hostname: string): void {
    this.allowedDomains.add(hostname.toLowerCase());
  }

  /** Read-only snapshot of the WebFetch whitelist. Used at startup to log
   *  pre-seeded domains so the user can audit what's allowed. */
  listAllowedDomains(): string[] {
    return Array.from(this.allowedDomains).sort();
  }

  reset(): void {
    this.allowedTools.clear();
    this.allowedDomains.clear();
  }

  // TODO: pattern-based allow/deny for Bash (and possibly Write/Edit
  // path patterns).
  // Motivation:
  //   - allow-all on Bash is currently all-or-nothing: approving once
  //     means every later command — including 'rm -rf', 'curl | sh',
  //     'git push --force' — runs unprompted.
  //   - Users either over-prompt (re-approve every safe command) or
  //     over-trust (allow-all and lose any guardrail on destructive
  //     commands). Neither is good.
  // Shape:
  //   - Per-tool ruleset: ordered list of { pattern, decision } where
  //     decision ∈ 'allow' | 'deny' | 'prompt'. First match wins.
  //   - Patterns: simple glob/prefix match on the command string for
  //     Bash ('git status*', 'npm run *'); path glob for Write/Edit
  //     ('src/**', deny '/etc/**', '~/.ssh/**').
  //   - Persist user-confirmed rules across sessions (opt-in, like
  //     Claude Code's settings.json permissions).
  //   - Built-in deny list for obviously dangerous patterns ('rm -rf /',
  //     'curl ... | sh', ':(){ :|:& };:') that bypasses allow-all.
  // Detection: even when a command is auto-allowed by pattern, log when
  // it matches a 'risky' heuristic (sudo, network fetch piped to shell,
  // recursive force-delete) so the user sees it in the session log.
}
