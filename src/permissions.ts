import { evaluateBash, type BashRule, type BashEvaluation } from './security/bash-rules.js';

export type PermissionDecision = 'allow' | 'deny' | 'allow-all' | 'allow-domain';

/** Result of evaluating whether a tool call needs to prompt the user. */
export type PermissionEvaluation =
  | { kind: 'allow'; source: string }
  | { kind: 'deny'; reason: string; source: string }
  | { kind: 'prompt' };

export class PermissionManager {
  private allowedTools: Set<string> = new Set();
  /** Hostnames the user has whitelisted for WebFetch this session. Distinct
   *  from `allowedTools`: a hostname here doesn't auto-allow the WebFetch
   *  tool overall; it just suppresses the prompt for matching URLs. */
  private allowedDomains: Set<string> = new Set();
  private bashRules: BashRule[] = [];

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
    // bashRules are policy, not session permissions, and persist across
    // reset(). They're cleared explicitly via clearBashRules() or by
    // re-loading from config.
  }

  // ---------- Bash policy ----------

  setBashRules(rules: BashRule[]): void {
    this.bashRules = [...rules];
  }

  addBashRule(rule: BashRule): void {
    this.bashRules.push(rule);
  }

  clearBashRules(): void {
    this.bashRules = [];
  }

  getBashRules(): readonly BashRule[] {
    return this.bashRules;
  }

  /**
   * Run the Bash policy: built-in forbidden patterns first (hard-deny,
   * cannot be bypassed by allow-all), then user rules (first match wins),
   * then fall back to allow-all / prompt.
   */
  evaluateBashCommand(command: string): PermissionEvaluation {
    const evalResult: BashEvaluation = evaluateBash(command, this.bashRules);
    if (evalResult.decision === 'deny') {
      return { kind: 'deny', reason: evalResult.reason ?? 'denied', source: evalResult.source };
    }
    if (evalResult.decision === 'allow') {
      return { kind: 'allow', source: evalResult.source };
    }
    // 'prompt' from policy → defer to allow-all, otherwise prompt the user.
    if (this.isAutoAllowed('Bash')) {
      return { kind: 'allow', source: 'allow-all' };
    }
    return { kind: 'prompt' };
  }

  /**
   * Evaluate a generic (non-Bash) tool call. For now this just maps onto
   * isAutoAllowed/prompt — file tools enforce path policy inside their
   * execute() so denial happens at the I/O boundary regardless of caller.
   */
  evaluateTool(toolName: string): PermissionEvaluation {
    if (this.isAutoAllowed(toolName)) {
      return { kind: 'allow', source: 'allow-all' };
    }
    return { kind: 'prompt' };
  }
}
