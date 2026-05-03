export type PermissionDecision = 'allow' | 'deny' | 'allow-all';

export class PermissionManager {
  private allowedTools: Set<string> = new Set();

  isAutoAllowed(toolName: string): boolean {
    return this.allowedTools.has(toolName.toLowerCase());
  }

  allowAll(toolName: string): void {
    this.allowedTools.add(toolName.toLowerCase());
  }

  reset(): void {
    this.allowedTools.clear();
  }
}
