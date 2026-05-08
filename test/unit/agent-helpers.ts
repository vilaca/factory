// Shared test helpers for the agent-loop test suite. Not a *.test.ts file,
// so the test runner glob (`test/unit/*.test.ts`) won't pick it up.

import type {
  Provider,
  ChatMessage,
  ChatChunk,
  ToolDefinition,
  ProviderCapabilities,
} from '../../src/providers/types.js';
import type { AgentEvent, PermissionDecision } from '../../src/core/agent-types.js';
import { Conversation } from '../../src/core/conversation.js';
import { PermissionManager } from '../../src/permissions.js';
import { defaultRegistry } from '../../src/tools/index.js';
import { runAgent } from '../../src/core/agent.js';

export interface MockResponse {
  content?: string;
  tool_calls?: Array<
    { function: { name: string; arguments: Record<string, unknown> } } | undefined
  >;
  /** When set, chat() throws this Error message on this queue slot (chatNoStream consumes the next slot). */
  streamError?: string;
}

export function createMockProvider(responses: MockResponse[]): Provider {
  const queue = [...responses];

  return {
    name: 'mock',
    async listModels() {
      return ['mock-model'];
    },
    getCapabilities(): ProviderCapabilities {
      return {
        contextWindow: 8192,
        maxOutputTokens: 4096,
        toolSupport: 'native',
        parallelToolCalls: false,
        streaming: true,
        tokenCounting: 'estimated',
        modelTier: 'strong',
      };
    },
    async *chat(
      _model: string,
      _messages: ChatMessage[],
      _tools?: ToolDefinition[],
    ): AsyncGenerator<ChatChunk> {
      const resp = queue.shift() ?? { content: 'No mock response.' };
      if (resp.streamError) {
        throw new Error(resp.streamError);
      }
      if (resp.content) {
        // Stream word by word like the real mock server.
        const words = resp.content.split(' ');
        for (const word of words) {
          yield { content: word + ' ' };
        }
      }
      if (resp.tool_calls) {
        yield { tool_calls: resp.tool_calls as any, done: true };
      } else {
        yield { done: true };
      }
    },
    async chatNoStream(
      _model: string,
      _messages: ChatMessage[],
      _tools?: ToolDefinition[],
    ): Promise<ChatChunk> {
      const resp = queue.shift() ?? { content: 'No mock response.' };
      return {
        content: resp.content,
        tool_calls: resp.tool_calls as any,
        done: true,
      };
    },
  };
}

export async function collectEvents(
  input: string,
  provider: Provider,
  opts?: {
    permissions?: PermissionManager;
    signal?: AbortSignal;
    onPermission?: (toolName: string) => PermissionDecision;
    enableCorrector?: boolean;
  },
): Promise<AgentEvent[]> {
  const conversation = new Conversation('You are a test assistant.');
  const permissions = opts?.permissions ?? new PermissionManager();
  const events: AgentEvent[] = [];

  const agent = runAgent(input, {
    provider,
    model: 'mock-model',
    conversation,
    permissions,
    toolRegistry: defaultRegistry,
    signal: opts?.signal,
    // Default off in tests so the corrector doesn't consume mock responses
    // unexpectedly. Specific corrector tests opt in.
    enableCorrector: opts?.enableCorrector ?? false,
  });

  for await (const event of agent) {
    events.push(event);
    if (event.type === 'permission-request') {
      const decision = opts?.onPermission?.(event.toolName) ?? 'allow';
      event.respond(decision);
    }
  }

  return events;
}

export function findEvents(events: AgentEvent[], type: string): AgentEvent[] {
  return events.filter(e => e.type === type);
}
