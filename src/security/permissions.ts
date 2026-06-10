import { evaluateBash, type BashRule, type BashEvaluation } from './bash-rules.js';
import { TOOL_NAMES } from '../utils/tool-names.js';

export type PermissionDecision = 'allow' | 'deny' | 'allow-all' | 'allow-domain';

/** Result of evaluating whether a tool call needs to prompt the user. */
type PermissionEvaluation =
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
  /** Stack of disallowed-tool sets pushed by skill permission scopes. */
  private disallowedScopeStack: Set<string>[] = [];

  isAutoAllowed(toolName: string): boolean {
    return this.allowedTools.has(toolName.toLowerCase());
  }

  allowAll(toolName: string): void {
    this.allowedTools.add(toolName.toLowerCase());
  }

  /** Remove a previously-added allow-all entry. Used by skill scope pop. */
  revokeAllowed(toolName: string): void {
    this.allowedTools.delete(toolName.toLowerCase());
  }

  /** Push a set of tool names that are denied for the duration of a skill
   *  invocation. Stacks — nested pushes each add a frame. */
  pushDisallowedScope(toolNames: string[]): void {
    this.disallowedScopeStack.push(new Set(toolNames.map(t => t.toLowerCase())));
  }

  /** Remove the most-recently-pushed disallowed scope frame. */
  popDisallowedScope(): void {
    this.disallowedScopeStack.pop();
  }

  /** True when `toolName` is explicitly denied by any active skill scope. */
  isScopeDenied(toolName: string): boolean {
    const lower = toolName.toLowerCase();
    return this.disallowedScopeStack.some(s => s.has(lower));
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
    this.disallowedScopeStack = [];
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
    if (this.isScopeDenied(TOOL_NAMES.Bash)) {
      return { kind: 'deny', reason: 'disallowed by active skill scope', source: 'skill-scope' };
    }
    const evalResult: BashEvaluation = evaluateBash(command, this.bashRules);
    if (evalResult.decision === 'deny') {
      return { kind: 'deny', reason: evalResult.reason ?? 'denied', source: evalResult.source };
    }
    if (evalResult.decision === 'allow') {
      return { kind: 'allow', source: evalResult.source };
    }
    // 'prompt' from policy → defer to allow-all, otherwise prompt the user.
    if (this.isAutoAllowed(TOOL_NAMES.Bash)) {
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
    if (this.isScopeDenied(toolName)) {
      return { kind: 'deny', reason: 'disallowed by active skill scope', source: 'skill-scope' };
    }
    if (this.isAutoAllowed(toolName)) {
      return { kind: 'allow', source: 'allow-all' };
    }
    return { kind: 'prompt' };
  }
}
