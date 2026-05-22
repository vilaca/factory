import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../../../../src/core/context/conversation.js';
import { ContextManager } from '../../../../src/core/context/context-manager.js';
import { PermissionManager } from '../../../../src/security/permissions.js';
import { defaultRegistry } from '../../../../src/tools/index.js';
import { runAgent } from '../../../../src/core/agent/run-agent.js';
import { createMockProvider, makeFakeCM } from './agent-helpers.js';
import type { AgentEvent } from '../../../../src/core/agent/types.js';

describe('ContextManager.checkThresholds', () => {
  it('returns null below all thresholds', () => {
    const conv = new Conversation('sys');
    const cm = new ContextManager(conv, {
      contextWindow: 1000,
      maxOutputTokens: 100,
      toolSupport: 'native',
      parallelToolCalls: false,
      streaming: true,
      tokenCounting: 'estimated',
      modelTier: 'strong',
    });
    // Default thresholds [0.65, 0.8]. Set usage to 50%.
    cm.recordPromptUsage({ promptTokens: 500, completionTokens: 0, totalTokens: 500 });
    cm.refreshEstimate([]);
    assert.equal(cm.checkThresholds(), null);
  });

  it('fires the higher threshold first when both crossed', () => {
    const conv = new Conversation('sys');
    const cm = new ContextManager(conv, {
      contextWindow: 1000,
      maxOutputTokens: 100,
      toolSupport: 'native',
      parallelToolCalls: false,
      streaming: true,
      tokenCounting: 'estimated',
      modelTier: 'strong',
    });
    cm.recordPromptUsage({ promptTokens: 850, completionTokens: 0, totalTokens: 850 });
    cm.refreshEstimate([]);
    const msg = cm.checkThresholds();
    assert.ok(msg);
    assert.ok(msg!.includes('nearly full'), `expected "nearly full" wording, got: ${msg}`);
  });

  it('fires each threshold at most once per pressure cycle', () => {
    const conv = new Conversation('sys');
    const cm = new ContextManager(conv, {
      contextWindow: 1000,
      maxOutputTokens: 100,
      toolSupport: 'native',
      parallelToolCalls: false,
      streaming: true,
      tokenCounting: 'estimated',
      modelTier: 'strong',
    });
    cm.recordPromptUsage({ promptTokens: 700, completionTokens: 0, totalTokens: 700 });
    cm.refreshEstimate([]);
    assert.ok(cm.checkThresholds());
    assert.equal(cm.checkThresholds(), null, 'second call returns null');
  });

  it('re-arms a threshold after usage drops below', () => {
    const conv = new Conversation('sys');
    const cm = new ContextManager(conv, {
      contextWindow: 1000,
      maxOutputTokens: 100,
      toolSupport: 'native',
      parallelToolCalls: false,
      streaming: true,
      tokenCounting: 'estimated',
      modelTier: 'strong',
    });
    cm.recordPromptUsage({ promptTokens: 700, completionTokens: 0, totalTokens: 700 });
    cm.refreshEstimate([]);
    assert.ok(cm.checkThresholds());
    // Usage drops (e.g. compaction freed budget)
    cm.recordPromptUsage({ promptTokens: 300, completionTokens: 0, totalTokens: 300 });
    cm.refreshEstimate([]);
    // Usage rises again
    cm.recordPromptUsage({ promptTokens: 700, completionTokens: 0, totalTokens: 700 });
    cm.refreshEstimate([]);
    assert.ok(cm.checkThresholds(), 'threshold re-fires after dropping and re-crossing');
  });
});

test('agent loop emits context-warning event and injects warning into outbound payload', async () => {
  let observedMessages: Array<{ role: string; content: string }> = [];
  const base = createMockProvider([{ content: 'ok' }]);
  const provider = {
    ...base,
    async *chat(model: string, messages: any[], tools: any) {
      observedMessages = messages.map(m => ({ role: m.role, content: m.content }));
      yield* base.chat(model, messages, tools);
    },
  } as typeof base;

  const cm = makeFakeCM({
    shouldCompact: () => false,
    getUsagePercent: () => 0.85,
    getTokenEstimate: () => 850,
    checkThresholds: () => 'Context is nearly full. ...',
  });

  const conversation = new Conversation('sys');
  const permissions = new PermissionManager();
  const events: AgentEvent[] = [];
  const agent = runAgent('hi', {
    provider,
    model: 'mock-model',
    conversation,
    permissions,
    toolRegistry: defaultRegistry,
    contextManager: cm,
    enableCorrector: false,
  });
  for await (const ev of agent) events.push(ev);

  const warnings = events.filter(e => e.type === 'context-warning');
  assert.equal(warnings.length, 1);
  // Outbound payload had the warning appended as a user message.
  const lastMsg = observedMessages[observedMessages.length - 1]!;
  assert.equal(lastMsg.role, 'user');
  assert.ok(lastMsg.content.includes('nearly full'));
  // The warning must NOT be persisted in the conversation history.
  const tagged = conversation.getMessagesWithMeta();
  const persistedWarnings = tagged.filter(m => m.content.includes('nearly full'));
  assert.equal(persistedWarnings.length, 0, 'warning is transient — never persisted');
});
