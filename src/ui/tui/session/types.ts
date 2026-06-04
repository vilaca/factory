import type { Provider } from '../../../providers/types.js';
import type { AgentConfig } from '../../../core/config/types.js';
import type { ToolRegistry } from '../../../tools/registry.js';

export interface SessionProps {
  model: string;
  systemPrompt: string;
  provider: Provider;
  /** Per-session tool registry threaded through from startup. */
  toolRegistry: ToolRegistry;
  /** Id of the multi-key-store entry the launch provider was built with.
   *  Forwarded to useAgentLoop so the first turn's success is attributed
   *  to the right key in /keys. */
  keyId?: string;
  agentConfig?: AgentConfig;
  autoAllowTools?: string[];
  useTextToolFallback?: boolean;
  nativeToolSupport?: boolean;
  enableSessionLog?: boolean;
  strictLogging?: boolean;
  planMode?: boolean;
  enableCorrector?: boolean;
  mcpInfo?: { servers: string[]; toolCount: number };
  gitBranch?: string;
  gitDirty?: boolean | null;
  validationWarning?: string;
  isActive?: boolean;
  tabId?: number;
  tabLabel?: string;
}
