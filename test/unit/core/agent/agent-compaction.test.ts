import { describe, it } from 'node:test';
import assert from 'node:assert';
import type {
  Provider,
  ChatChunk,
  ProviderCapabilities,
} from '../../../../src/providers/types.js';
import type { AgentEvent } from '../../../../src/core/agent/types.js';
import type { ContextManager } from '../../../../src/core/context/context-manager.js';
import { Conversation } from '../../../../src/core/context/conversation.js';
import { PermissionManager } from '../../../../src/security/permissions.js';
import { defaultRegistry } from '../../../../src/tools/index.js';
import { runAgent } from '../../../../src/core/agent/run-agent.js';
import { createMockProvider, findEvents } from './agent-helpers.js';

describe('Agent loop — compaction', () => {
  it('yields a compaction event when ContextManager.shouldCompact is true', async () => {
    const cm = {
      updateUsage: () => {},
      ageOldToolResults: () => 0,
      shouldCompact: () => true,
      compact: async () => ({ oldCount: 5, newCount: 2 }),
      getUsagePercent: () => 0.5,
      getTokenEstimate: () => 100,
    } as unknown as ContextManager;

    const provider = createMockProvider([{ content: 'hi' }]);
    const conversation = new Conversation('system');
    const permissions = new PermissionManager();

    const events: AgentEvent[] = [];
    const agent = runAgent('hello', {
      provider,
      model: 'mock',
      conversation,
      permissions,
      toolRegistry: defaultRegistry,
      contextManager: cm,
      enableCorrector: false,
    });
    for await (const ev of agent) events.push(ev);

    const compactions = findEvents(events, 'compaction');
    assert.strictEqual(compactions.length, 1);
    assert.strictEqual((compactions[0] as any).oldMessages, 5);
    assert.strictEqual((compactions[0] as any).newMessages, 2);

    const complete = findEvents(events, 'turn-complete');
    assert.strictEqual((complete[0] as any).stopReason, 'completed');
  });

  it('halts with token-limit when usage stays above 0.9 after compaction', async () => {
    const cm = {
      updateUsage: () => {},
      ageOldToolResults: () => 0,
      shouldCompact: () => true,
      compact: async () => ({ oldCount: 5, newCount: 2 }),
      getUsagePercent: () => 0.95,
      getTokenEstimate: () => 100,
    } as unknown as ContextManager;

    const provider = createMockProvider([{ content: 'hi' }]);
    const conversation = new Conversation('system');
    const permissions = new PermissionManager();

    const events: AgentEvent[] = [];
    const agent = runAgent('hello', {
      provider,
      model: 'mock',
      conversation,
      permissions,
      toolRegistry: defaultRegistry,
      contextManager: cm,
      enableCorrector: false,
    });
    for await (const ev of agent) events.push(ev);

    const compactions = findEvents(events, 'compaction');
    assert.strictEqual(compactions.length, 1);

    const complete = findEvents(events, 'turn-complete');
    assert.strictEqual(complete.length, 1);
    assert.strictEqual((complete[0] as any).stopReason, 'token-limit');
  });

  it('escalates to aggressive compaction when normal pass leaves usage above 0.9', async () => {
    // Normal compact frees some space but not enough; aggressive (recencyWindow=0,
    // mechanical-only) brings usage back under the hard ceiling.
    const compactCalls: Array<{ aggressive: boolean }> = [];
    let usagePercent = 0.95;

    const cm = {
      updateUsage: () => {},
      ageOldToolResults: () => 0,
      shouldCompact: () => true,
      compact: async (
        _provider: unknown,
        _model: unknown,
        _signal: unknown,
        opts?: { aggressive?: boolean },
      ) => {
        const aggressive = opts?.aggressive ?? false;
        compactCalls.push({ aggressive });
        if (aggressive) {
          usagePercent = 0.4;
          return { oldCount: 8, newCount: 2 };
        }
        // Normal pass returned but didn't free enough.
        usagePercent = 0.92;
        return { oldCount: 30, newCount: 8 };
      },
      getUsagePercent: () => usagePercent,
      getTokenEstimate: () => 100,
    } as unknown as ContextManager;

    const provider = createMockProvider([{ content: 'all good' }]);
    const conversation = new Conversation('system');
    const permissions = new PermissionManager();

    const events: AgentEvent[] = [];
    const agent = runAgent('hello', {
      provider,
      model: 'mock',
      conversation,
      permissions,
      toolRegistry: defaultRegistry,
      contextManager: cm,
      enableCorrector: false,
    });
    for await (const ev of agent) events.push(ev);

    // Both passes ran, in the right order, with the right flags.
    assert.deepStrictEqual(compactCalls, [{ aggressive: false }, { aggressive: true }]);

    // One cumulative compaction event reports old from the first pass and new from the last.
    const compactions = findEvents(events, 'compaction');
    assert.strictEqual(compactions.length, 1);
    assert.strictEqual((compactions[0] as any).oldMessages, 30);
    assert.strictEqual((compactions[0] as any).newMessages, 2);

    // Aggressive pass freed enough room — turn completes and the model gets called.
    const complete = findEvents(events, 'turn-complete');
    assert.strictEqual(complete.length, 1);
    assert.strictEqual((complete[0] as any).stopReason, 'completed');

    const done = findEvents(events, 'text-done');
    assert.strictEqual(done.length, 1);
    assert.strictEqual((done[0] as any).fullContent.trim(), 'all good');
  });

  it('yields user-abort when AbortError propagates out of compaction', async () => {
    // Simulates ESC during the compaction summary call: chatNoStream throws
    // AbortError → compact() re-throws it → agent loop catches it → user-abort
    // (NOT mechanical-summary fallback that silently completes against intent).
    let chatCalled = false;
    const provider: Provider = {
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
      async *chat(): AsyncGenerator<ChatChunk> {
        chatCalled = true;
        yield { content: 'should never run', done: true };
      },
      async chatNoStream(): Promise<ChatChunk> {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    };

    // Real ContextManager so compact() actually runs the chatNoStream path
    // and we exercise the catch block.
    const conversation = new Conversation('system');
    conversation.addUser('one');
    conversation.addAssistant('two');
    conversation.addUser('three');
    conversation.addAssistant('four');
    conversation.addUser('five');
    conversation.addAssistant('six');
    conversation.addUser('seven');
    conversation.addAssistant('eight');
    conversation.addUser('nine');
    conversation.addAssistant('ten');
    const { ContextManager } = await import('../../../../src/core/context/context-manager.js');
    const cm = new ContextManager(conversation, provider.getCapabilities('mock-model'), {
      compactionThreshold: 0.0001, // force shouldCompact=true
      recencyWindow: 2,
      // Disable the token-weighted expansion so the test's tiny messages
      // don't expand the keep window past the conversation length and
      // skip compaction entirely.
      recencyTokens: 0,
    });

    const permissions = new PermissionManager();
    const events: AgentEvent[] = [];
    const agent = runAgent('hello', {
      provider,
      model: 'mock-model',
      conversation,
      permissions,
      toolRegistry: defaultRegistry,
      contextManager: cm,
      enableCorrector: false,
    });
    for await (const ev of agent) events.push(ev);

    // The model never got called because compaction aborted first.
    assert.strictEqual(chatCalled, false);

    const complete = findEvents(events, 'turn-complete');
    assert.strictEqual(complete.length, 1);
    assert.strictEqual((complete[0] as any).stopReason, 'user-abort');

    // No compaction event should have been emitted because compact() threw
    // before mutating the conversation.
    const compactions = findEvents(events, 'compaction');
    assert.strictEqual(compactions.length, 0);
  });

  it("halts with token-limit when even aggressive compaction can't free enough", async () => {
    const compactCalls: Array<{ aggressive: boolean }> = [];

    const cm = {
      updateUsage: () => {},
      ageOldToolResults: () => 0,
      shouldCompact: () => true,
      compact: async (
        _provider: unknown,
        _model: unknown,
        _signal: unknown,
        opts?: { aggressive?: boolean },
      ) => {
        compactCalls.push({ aggressive: opts?.aggressive ?? false });
        return { oldCount: 5, newCount: 3 };
      },
      // Stays pinned above the hard ceiling regardless of compaction.
      getUsagePercent: () => 0.97,
      getTokenEstimate: () => 100,
    } as unknown as ContextManager;

    const provider = createMockProvider([{ content: 'never seen' }]);
    const conversation = new Conversation('system');
    const permissions = new PermissionManager();

    const events: AgentEvent[] = [];
    const agent = runAgent('hello', {
      provider,
      model: 'mock',
      conversation,
      permissions,
      toolRegistry: defaultRegistry,
      contextManager: cm,
      enableCorrector: false,
    });
    for await (const ev of agent) events.push(ev);

    // Both passes ran before halting.
    assert.deepStrictEqual(compactCalls, [{ aggressive: false }, { aggressive: true }]);

    const complete = findEvents(events, 'turn-complete');
    assert.strictEqual(complete.length, 1);
    assert.strictEqual((complete[0] as any).stopReason, 'token-limit');

    // Halt happened before the model was called — no streamed text.
    const chunks = findEvents(events, 'text-chunk');
    assert.strictEqual(chunks.length, 0);
  });
});
