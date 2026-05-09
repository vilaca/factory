export interface ToolCallSummary {
  toolName: string;
  args: Record<string, unknown>;
}

export type DisplayItem =
  | { kind: 'user-input'; id: number; text: string }
  | { kind: 'assistant-text'; id: number; text: string; streaming: boolean }
  | {
      kind: 'tool-call';
      id: number;
      toolName: string;
      args: Record<string, unknown>;
      status?: 'ok' | 'denied';
    }
  | {
      kind: 'tool-result';
      id: number;
      toolName: string;
      output: string;
      outputFull?: string;
      success: boolean;
      empty?: boolean;
    }
  | { kind: 'tool-planned'; id: number; toolName: string; args: Record<string, unknown> }
  | { kind: 'notice'; id: number; text: string; level: 'info' | 'warn' | 'danger' | 'cyan' }
  | {
      kind: 'notice-block';
      id: number;
      lines: { text: string; level: 'info' | 'warn' | 'danger' | 'cyan'; bold?: boolean }[];
    }
  | { kind: 'permission-prompt'; id: number; toolName: string; args: Record<string, unknown> }
  | { kind: 'status'; id: number; turnsUsed: number; usage?: { totalTokens: number } };
