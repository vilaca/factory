import type { AgentEvent } from '../../core/agent-types.js';

export interface ToolCallSummary {
  toolName: string;
  args: Record<string, unknown>;
}

export type DisplayItem =
  | { kind: 'user-input'; id: number; text: string }
  | { kind: 'assistant-text'; id: number; text: string; streaming: boolean }
  | { kind: 'tool-call'; id: number; toolName: string; args: Record<string, unknown> }
  | { kind: 'tool-result'; id: number; toolName: string; output: string; success: boolean; empty?: boolean }
  | { kind: 'tool-denied'; id: number; toolName: string }
  | { kind: 'tool-planned'; id: number; toolName: string; args: Record<string, unknown> }
  | { kind: 'notice'; id: number; text: string; level: 'info' | 'warn' | 'danger' | 'cyan' }
  | { kind: 'permission-prompt'; id: number; toolName: string; args: Record<string, unknown> }
  | { kind: 'status'; id: number; turnsUsed: number; usage?: { totalTokens: number } };

export interface AppState {
  items: DisplayItem[];
  inputQueue: string[];
  state: 'idle' | 'running' | 'awaiting-permission';
  plannedCalls: ToolCallSummary[];
  planMode: boolean;
  enableCorrector: boolean;
  useTextToolFallback: boolean;
  nativeToolSupport: boolean;
  model: string;
  sessionTurns: number;
  sessionToolCalls: number;
  lastUsage?: { totalTokens?: number; completionTokens?: number };
  contextWindow: number;
  permissionRequest?: {
    toolName: string;
    args: Record<string, unknown>;
    resolve: (decision: 'allow' | 'deny' | 'allow-all') => void;
  };
  consecutiveStuckTurns: number;
  lastSubstantivePrompt: string | null;
  replayCounts: Map<string, number>;
}

export type AgentEventType = AgentEvent['type'];
