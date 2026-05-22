import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '../../../../src/core/agent/types.js';
import { Conversation } from '../../../../src/core/context/conversation.js';
// AgentEvent kept for type clarity in collected event arrays
import { PermissionManager } from '../../../../src/security/permissions.js';
import { defaultRegistry } from '../../../../src/tools/index.js';
import { runAgent } from '../../../../src/core/agent/run-agent.js';
import { createMockProvider } from './agent-helpers.js';
import { TOOL_NAMES } from '../../../../src/utils/tool-names.js';
import { _resetActivationLogForTests } from '../../../../src/core/agent/reliability-config.js';

test('agent loop: premature terminal triggers step nudge', async () => {
  _resetActivationLogForTests();
  // Turn 1: model calls Respond before Glob → step nudge injected.
  // Turn 2: model calls Glob → records the step.
  // Turn 3: model emits plain text → natural turn-complete.
  const provider = createMockProvider([
    {
      tool_calls: [{ function: { name: TOOL_NAMES.Respond, arguments: { message: 'too soon' } } }],
    },
    { tool_calls: [{ function: { name: 'Glob', arguments: { pattern: '*.md' } } }] },
    { content: 'done' },
  ]);

  const conversation = new Conversation('You are a test assistant.');
  const permissions = new PermissionManager();
  permissions.allowAll('Glob');
  permissions.allowAll('Respond');
  const events: AgentEvent[] = [];
  const agent = runAgent('please list files then respond', {
    provider,
    model: 'mock-model',
    conversation,
    permissions,
    toolRegistry: defaultRegistry,
    enableCorrector: false,
    requiredSteps: ['Glob'],
    terminalTools: [TOOL_NAMES.Respond],
  });
  for await (const ev of agent) events.push(ev);

  const tagged = conversation.getMessagesWithMeta();
  const nudges = tagged.filter(m => m.metadata?.type === 'step_nudge');
  assert.equal(nudges.length, 1, 'one step nudge injected');
});

test('agent loop: prerequisite_nudge fires when Edit declared a Read prereq it didn\'t honor', async () => {
  _resetActivationLogForTests();
  // We don't permanently mutate defaultRegistry — declare a temp tool
  // with prerequisites and register/unregister around the run.
  const tmpTool = {
    name: 'TmpEdit',
    description: 'Test tool',
    category: 'write' as const,
    definition: {
      type: 'function' as const,
      function: {
        name: 'TmpEdit',
        description: 'test',
        parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
      },
      prerequisites: ['TmpRead'],
    },
    async execute() {
      return { success: true, output: 'edited' };
    },
  };
  const tmpRead = {
    name: 'TmpRead',
    description: 'Test read',
    category: 'read-only' as const,
    definition: {
      type: 'function' as const,
      function: {
        name: 'TmpRead',
        description: 'test',
        parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
      },
    },
    async execute() {
      return { success: true, output: 'read content' };
    },
  };

  defaultRegistry.register(tmpRead);
  defaultRegistry.register(tmpTool);
  try {
    const provider = createMockProvider([
      { tool_calls: [{ function: { name: 'TmpEdit', arguments: { file_path: '/x' } } }] },
      { content: 'done' },
    ]);
    const conversation = new Conversation('sys');
    const permissions = new PermissionManager();
    permissions.allowAll('TmpEdit');
    permissions.allowAll('TmpRead');
    const events: AgentEvent[] = [];
    const agent = runAgent('edit /x', {
      provider,
      model: 'mock-model',
      conversation,
      permissions,
      toolRegistry: defaultRegistry,
      enableCorrector: false,
    });
    for await (const ev of agent) events.push(ev);
    const tagged = conversation.getMessagesWithMeta();
    const nudges = tagged.filter(m => m.metadata?.type === 'prerequisite_nudge');
    assert.equal(nudges.length, 1, 'one prerequisite nudge injected');
    assert.ok(nudges[0]!.content.includes('TmpRead'));
  } finally {
    defaultRegistry.unregister('TmpEdit');
    defaultRegistry.unregister('TmpRead');
  }
});
