import type { PermissionManager } from '../../security/permissions.js';

export interface SkillPermissionScope {
  allowed: string[];
  disallowed: string[];
}

/**
 * Push a skill-scoped permission frame onto `PermissionManager`.
 * While the frame is active, every tool in `allowed` is auto-allowed
 * (additive) and every tool in `disallowed` is hard-denied regardless
 * of the global allow-all state.
 *
 * Returns a `pop` function; invoke it inside a `finally` block so the
 * frame is always removed even if the skill body throws:
 *
 *   const pop = pushSkillScope(mgr, skill);
 *   try { ... } finally { pop(); }
 *
 * Stack-based: nested pushes compose correctly — each push/pop pair is
 * independent.
 */
export function pushSkillScope(mgr: PermissionManager, scope: SkillPermissionScope): () => void {
  const { allowed, disallowed } = scope;

  // Record which names we added so we can remove exactly those on pop.
  const addedAllow = new Set<string>();
  for (const tool of allowed) {
    const lower = tool.toLowerCase();
    if (!mgr.isAutoAllowed(lower)) {
      mgr.allowAll(lower);
      addedAllow.add(lower);
    }
  }

  const disallowedLower = disallowed.map(t => t.toLowerCase());
  mgr.pushDisallowedScope(disallowedLower);

  return function pop() {
    mgr.popDisallowedScope();
    for (const tool of addedAllow) {
      mgr.revokeAllowed(tool);
    }
  };
}
