import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../../../../src/core/context/conversation.js';
import { PermissionManager } from '../../../../src/security/permissions.js';
import { defaultRegistry } from '../../../../src/tools/index.js';
import { runAgent } from '../../../../src/core/agent/run-agent.js';
import { ToolResolutionError } from '../../../../src/tools/errors.js';
import { ToolExecutionError } from '../../../../src/core/agent/errors.js';
import { createMockProvider } from './agent-helpers.js';
import type { AgentEvent } from '../../../../src/core/agent/types.js';

function makeResolvingTool(state: { calls: Array<Record<string, unknown>> }) {
  return {
    name: 'TmpResolveTool',
    description: 'echoes or raises ToolResolutionError on missing service',
    category: 'read-only' as const,
    definition: {
      type: 'function' as const,
      function: {
        name: 'TmpResolveTool',
        description: 'echoes or raises ToolResolutionError on missing service',
        parameters: { type: 'object', properties: { service: { type: 'string' } } },
      },
    },
    async execute(args: Record<string, unknown>) {
      state.calls.push(args);
      const service = args.service as string;
      if (service !== 'payments-service') {
        throw new ToolResolutionError(`No alert found for service '${service}'`);
      }
      return { success: true, output: 'CRITICAL: db slow' };
    },
  };
}

function makeHardThrowingTool() {
  return {
    name: 'TmpHardTool',
    description: 'always throws a hard error',
    category: 'read-only' as const,
    definition: {
      type: 'function' as const,
      function: {
        name: 'TmpHardTool',
        description: 'always throws a hard error',
        parameters: { type: 'object', properties: {} },
      },
    },
    async execute(): Promise<{ success: boolean; output: string }> {
      throw new Error('catastrophic disk failure');
    },
  };
}

test('ToolResolutionError feeds back as tool result without bumping hard-error counter', async () => {
  const state = { calls: [] as Array<Record<string, unknown>> };
  const tool = makeResolvingTool(state);
  defaultRegistry.register(tool);
  try {
    // Model tries 3 wrong service names, then the right one — each
    // wrong attempt produces a ToolResolutionError. The hard-error
    // counter (max 2) should NOT trip because these are soft errors.
    const provider = createMockProvider([
      {
        tool_calls: [{ function: { name: 'TmpResolveTool', arguments: { service: 'payments' } } }],
      },
      {
        tool_calls: [
          { function: { name: 'TmpResolveTool', arguments: { service: 'payments-svc' } } },
        ],
      },
      {
        tool_calls: [
          { function: { name: 'TmpResolveTool', arguments: { service: 'paymentsvc' } } },
        ],
      },
      {
        tool_calls: [
          { function: { name: 'TmpResolveTool', arguments: { service: 'payments-service' } } },
        ],
      },
      { content: 'done' },
    ]);
    const permissions = new PermissionManager();
    permissions.allowAll('TmpResolveTool');
    const conversation = new Conversation('sys');
    const events: AgentEvent[] = [];
    const agent = runAgent('find the alert', {
      provider,
      model: 'mock-model',
      conversation,
      permissions,
      toolRegistry: defaultRegistry,
      enableCorrector: false,
    });
    for await (const ev of agent) events.push(ev);

    const errors = events.filter(e => e.type === 'error');
    assert.equal(errors.length, 0, 'no error events — soft errors do not trip the hard counter');
    // The model successfully called the tool 4 times.
    assert.equal(state.calls.length, 4);
    // Resolution messages are visible to the model — the tool_result
    // for the three soft failures contains the resolution string.
    const tagged = conversation.getMessagesWithMeta();
    const toolResults = tagged.filter(m => m.metadata?.type === 'tool_result');
    const resolutionResults = toolResults.filter(m => m.content.includes('No alert found'));
    assert.equal(resolutionResults.length, 3);
  } finally {
    defaultRegistry.unregister('TmpResolveTool');
  }
});

test('hard tool exception bumps consecutiveHardToolErrors and bails after budget', async () => {
  const tool = makeHardThrowingTool();
  defaultRegistry.register(tool);
  try {
    // Model calls TmpHardTool 4 times in a row — each throws a hard
    // error. After the 3rd consecutive hard error (budget=2), the
    // ToolExecutionError bailout should fire.
    const provider = createMockProvider([
      { tool_calls: [{ function: { name: 'TmpHardTool', arguments: {} } }] },
      { tool_calls: [{ function: { name: 'TmpHardTool', arguments: {} } }] },
      { tool_calls: [{ function: { name: 'TmpHardTool', arguments: {} } }] },
      { tool_calls: [{ function: { name: 'TmpHardTool', arguments: {} } }] },
      { content: 'done' },
    ]);
    const permissions = new PermissionManager();
    permissions.allowAll('TmpHardTool');
    const conversation = new Conversation('sys');
    const events: AgentEvent[] = [];
    const agent = runAgent('do the thing', {
      provider,
      model: 'mock-model',
      conversation,
      permissions,
      toolRegistry: defaultRegistry,
      enableCorrector: false,
    });
    for await (const ev of agent) events.push(ev);
    const errEvents = events.filter(
      e => e.type === 'error' && (e as { error: Error }).error instanceof ToolExecutionError,
    );
    assert.equal(errEvents.length, 1, 'one ToolExecutionError event when budget exhausts');
  } finally {
    defaultRegistry.unregister('TmpHardTool');
  }
});
