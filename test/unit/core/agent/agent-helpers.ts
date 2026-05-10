// Shared test helpers for the agent-loop test suite. Not a *.test.ts file,
// so the test runner glob (`test/unit/*.test.ts`) won't pick it up.

import type {
  Provider,
  ChatMessage,
  ChatChunk,
  ToolDefinition,
  ProviderCapabilities,
} from '../../../../src/providers/types.js';
import type { AgentEvent, PermissionDecision } from '../../../../src/core/agent/types.js';
import type { ContextManager } from '../../../../src/core/context/context-manager.js';
import { Conversation } from '../../../../src/core/context/conversation.js';
import { PermissionManager } from '../../../../src/security/permissions.js';
import { defaultRegistry } from '../../../../src/tools/index.js';
import { runAgent } from '../../../../src/core/agent/run-agent.js';

export interface MockResponse {
  content?: string;
  tool_calls?: Array<
    { function: { name: string; arguments: Record<string, unknown> } } | undefined
  >;
  /** When set, chat() throws this Error message on this queue slot (chatNoStream consumes the next slot). */
  streamError?: string;
  /** When set, the terminal chunk carries this `doneReason` so tests can
   *  exercise run-agent's branches on `length`, `content_filter`, `refusal`,
   *  etc. Mirrors what real providers surface via the same field. */
  doneReason?: string;
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
      // run-agent's `output-cap-reached` branch gates on `lastUsage`, so
      // attach a minimal usage chunk when the test exercises a doneReason —
      // existing tests don't set doneReason and stay byte-stable.
      const usage = resp.doneReason
        ? { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
        : undefined;
      if (resp.tool_calls) {
        yield {
          tool_calls: resp.tool_calls as any,
          done: true,
          ...(resp.doneReason ? { doneReason: resp.doneReason } : {}),
          ...(usage ? { usage } : {}),
        };
      } else {
        yield {
          done: true,
          ...(resp.doneReason ? { doneReason: resp.doneReason } : {}),
          ...(usage ? { usage } : {}),
        };
      }
    },
    async chatNoStream(
      _model: string,
      _messages: ChatMessage[],
      _tools?: ToolDefinition[],
    ): Promise<ChatChunk> {
      const resp = queue.shift() ?? { content: 'No mock response.' };
      const usage = resp.doneReason
        ? { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
        : undefined;
      return {
        content: resp.content,
        tool_calls: resp.tool_calls as any,
        done: true,
        ...(resp.doneReason ? { doneReason: resp.doneReason } : {}),
        ...(usage ? { usage } : {}),
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

/** Build a fake `ContextManager` with no-op methods, overridable per test.
 *  Tests that drive `runAgent` and only care about the compaction surface
 *  (shouldCompact / compact / getUsagePercent) can pass overrides for
 *  just those methods. The cast to `ContextManager` is safe as long as
 *  the test sticks to methods exercised by the agent loop. */
export function makeFakeCM(overrides: Partial<ContextManager> = {}): ContextManager {
  const base: Partial<ContextManager> = {
    refreshEstimate: () => {},
    recordPromptUsage: () => {},
    ageOldToolResults: () => 0,
    shouldCompact: () => false,
    compact: async () => null,
    getUsagePercent: () => 0,
    getTokenEstimate: () => 0,
  };
  return { ...base, ...overrides } as unknown as ContextManager;
}
