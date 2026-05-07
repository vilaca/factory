import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Provider, ProviderCapabilities, ChatChunk } from '../../src/providers/types.js';
import { Conversation } from '../../src/core/conversation.js';
import { ContextManager } from '../../src/core/context-manager.js';

const capabilities: ProviderCapabilities = {
  contextWindow: 8192,
  maxOutputTokens: 4096,
  toolSupport: 'native',
  parallelToolCalls: false,
  streaming: true,
  tokenCounting: 'estimated',
  modelTier: 'strong',
};

function noopProvider(): Provider {
  return {
    name: 'noop',
    async listModels() {
      return [];
    },
    getCapabilities() {
      return capabilities;
    },
    async *chat() {
      yield { done: true } as ChatChunk;
    },
    async chatNoStream() {
      return { done: true } as ChatChunk;
    },
  };
}

describe('ContextManager.compact (aggressive)', () => {
  it('keeps a small recency window so the active task survives', async () => {
    const conv = new Conversation('SYSTEM');
    conv.addUser('original task: refactor the agent loop');
    conv.addAssistant('looking at agent.ts');
    conv.addUser('do a thing');
    conv.addAssistant('done');
    conv.addUser('latest active topic — the actual subject');
    conv.addAssistant('the assistant said something specific');

    const cm = new ContextManager(conv, capabilities);
    const result = await cm.compact(noopProvider(), 'm', undefined, { aggressive: true });

    assert.ok(result, 'compaction should run');
    const msgs = conv.getMessages();
    assert.strictEqual(msgs[0].role, 'system');
    assert.strictEqual(msgs[1].role, 'user');
    assert.ok(msgs[1].content.startsWith('[Previous conversation summary]\n'));
    assert.strictEqual(msgs[2].role, 'assistant');
    assert.strictEqual(msgs[2].content, 'Continuing from the summary above.');
    assert.strictEqual(msgs[msgs.length - 2].content, 'latest active topic — the actual subject');
    assert.strictEqual(msgs[msgs.length - 1].content, 'the assistant said something specific');
  });

  it('mechanical summary captures latest user request and assistant reply', async () => {
    const conv = new Conversation('SYSTEM');
    conv.addUser('first');
    conv.addAssistant('first reply');
    conv.addUser('the active topic the user cares about');
    conv.addAssistant('a substantive assistant answer');
    conv.addUser('do this last thing');
    conv.addAssistant('ok');

    const cm = new ContextManager(conv, capabilities);
    await cm.compact(noopProvider(), 'm', undefined, { aggressive: true });

    const summary = conv.getMessages()[1].content;
    assert.match(summary, /Latest user request: the active topic the user cares about/);
    assert.match(summary, /Latest assistant reply: a substantive assistant answer/);
  });

  it('truncates long latest-user and latest-assistant content with ellipsis', async () => {
    const longUser = 'x'.repeat(800);
    const longAssistant = 'y'.repeat(500);
    const conv = new Conversation('SYSTEM');
    conv.addUser(longUser);
    conv.addAssistant(longAssistant);
    conv.addUser('recent 1');
    conv.addAssistant('recent 2');

    const cm = new ContextManager(conv, capabilities);
    await cm.compact(noopProvider(), 'm', undefined, { aggressive: true });

    const summary = conv.getMessages()[1].content;
    assert.match(summary, /Latest user request: x{500} …/);
    assert.match(summary, /Latest assistant reply: y{300} …/);
  });

  it('skips auto-retry-injected user messages when finding latest user request', async () => {
    const conv = new Conversation('SYSTEM');
    conv.addUser('the real user request');
    conv.addAssistant('working on it');
    conv.addUser(
      'Your last tool call failed with: "ENOENT". Diagnose the cause and emit a corrected tool call now. Do not reply with prose.',
    );
    conv.addAssistant('retried');
    conv.addUser('end1');
    conv.addAssistant('end2');

    const cm = new ContextManager(conv, capabilities);
    await cm.compact(noopProvider(), 'm', undefined, { aggressive: true });

    const summary = conv.getMessages()[1].content;
    assert.match(summary, /Latest user request: the real user request/);
    assert.doesNotMatch(summary, /Latest user request: Your last tool call failed/);
  });

  it('skips empty assistant content (pure tool-call turns) when finding latest assistant reply', async () => {
    const conv = new Conversation('SYSTEM');
    conv.addUser('do a tool call');
    conv.addAssistant('here is the answer in text');
    conv.addUser('and another thing');
    conv.addAssistant('', [{ function: { name: 'Read', arguments: { file_path: '/x' } } }]);
    conv.addToolResult('contents');
    conv.addUser('end1');
    conv.addAssistant('end2');

    const cm = new ContextManager(conv, capabilities);
    await cm.compact(noopProvider(), 'm', undefined, { aggressive: true });

    const summary = conv.getMessages()[1].content;
    assert.match(summary, /Latest assistant reply: here is the answer in text/);
  });

  it('records tools used and files accessed', async () => {
    const conv = new Conversation('SYSTEM');
    conv.addUser('do stuff');
    conv.addAssistant('using tools', [
      { function: { name: 'Read', arguments: { file_path: '/a.ts' } } },
      { function: { name: 'Grep', arguments: { pattern: 'foo', path: '/b' } } },
    ]);
    conv.addToolResult('contents of a');
    conv.addToolResult('grep results');
    conv.addUser('end1');
    conv.addAssistant('end2');

    const cm = new ContextManager(conv, capabilities);
    await cm.compact(noopProvider(), 'm', undefined, { aggressive: true });

    const summary = conv.getMessages()[1].content;
    assert.match(summary, /Tools used: Read, Grep/);
    assert.match(summary, /Files accessed: \/a\.ts, \/b/);
  });

  it('carries forward prior summary on cascaded compaction', async () => {
    const conv = new Conversation('SYSTEM');
    conv.addUser(
      '[Previous conversation summary]\nConversation summary (10 messages compacted):\nLatest user request: original task\nTools used: Read',
    );
    conv.addAssistant('Continuing from the summary above.');
    conv.addUser('next user question');
    conv.addAssistant('next assistant answer');
    conv.addUser('end1');
    conv.addAssistant('end2');

    const cm = new ContextManager(conv, capabilities);
    await cm.compact(noopProvider(), 'm', undefined, { aggressive: true });

    const summary = conv.getMessages()[1].content;
    assert.match(summary, /original task/);
    assert.match(summary, /Conversation summary \(10 messages compacted\)/);
  });

  it('returns null when there are not enough messages to summarize', async () => {
    const conv = new Conversation('SYSTEM');
    conv.addUser('a');
    conv.addAssistant('b');

    const cm = new ContextManager(conv, capabilities);
    const result = await cm.compact(noopProvider(), 'm', undefined, { aggressive: true });

    assert.strictEqual(result, null);
  });
});

describe('ContextManager — token-weighted recency window', () => {
  it('expands the recency window past recencyWindow when messages are tiny', async () => {
    const conv = new Conversation('SYSTEM');
    // 30 short messages; recencyWindow=6 would normally keep just 6, but a
    // 4000-token budget should expand to keep most/all of the conversation.
    for (let i = 0; i < 30; i++) {
      if (i % 2 === 0) conv.addUser(`q${i}`);
      else conv.addAssistant(`a${i}`);
    }
    const cm = new ContextManager(conv, capabilities, {
      compactionThreshold: 0.0001,
      recencyWindow: 6,
      recencyTokens: 4000,
    });
    const before = conv.getMessages().length;
    await cm.compact(noopProvider(), 'm', undefined);
    // With 30 tiny messages well under 4000 tokens, compact should have
    // declined (kept all messages → no compaction).
    const after = conv.getMessages().length;
    assert.strictEqual(after, before);
  });

  it('keeps the recencyWindow floor when token budget is set to 0', async () => {
    const conv = new Conversation('SYSTEM');
    for (let i = 0; i < 30; i++) {
      if (i % 2 === 0) conv.addUser(`q${i}`);
      else conv.addAssistant(`a${i}`);
    }
    const cm = new ContextManager(conv, capabilities, {
      compactionThreshold: 0.0001,
      recencyWindow: 6,
      recencyTokens: 0,
    });
    cm.updateUsage(undefined);
    await cm.compact(noopProvider(), 'm', undefined);
    // With token budget disabled, count-only behavior: 6 kept + 2 synthetic
    // (summary user + ack assistant) = 8 total.
    const msgs = conv.getMessages();
    assert.strictEqual(msgs.length, 1 + 2 + 6); // system + summary pair + 6 kept
  });
});

describe('ContextManager — summary routes to weak-tier when available', () => {
  it('calls the provider summary on the mapped weak-tier model', async () => {
    let summaryModelSeen: string | undefined;
    const provider: Provider = {
      name: 'anthropic',
      async listModels() {
        return [];
      },
      getCapabilities(model: string): ProviderCapabilities {
        // Both strong-tier (sonnet) and weak-tier (haiku) report capabilities.
        const isHaiku = model.includes('haiku');
        return {
          contextWindow: 200000,
          maxOutputTokens: isHaiku ? 8192 : 16000,
          toolSupport: 'native',
          parallelToolCalls: true,
          streaming: true,
          tokenCounting: 'exact',
          modelTier: isHaiku ? 'medium' : 'strong',
        };
      },
      async *chat() {
        yield { done: true } as ChatChunk;
      },
      async chatNoStream(model: string) {
        summaryModelSeen = model;
        return { content: 'a summary string', done: true } as ChatChunk;
      },
    };

    const conv = new Conversation('SYSTEM');
    for (let i = 0; i < 12; i++) {
      conv.addUser(`q${i}`);
      conv.addAssistant(`a${i}`);
    }
    const cm = new ContextManager(conv, provider.getCapabilities('claude-sonnet-4-6'), {
      compactionThreshold: 0.0001,
      recencyWindow: 4,
      recencyTokens: 0,
    });
    cm.updateUsage(undefined);
    await cm.compact(provider, 'claude-sonnet-4-6', undefined);

    assert.strictEqual(summaryModelSeen, 'claude-haiku-4-5-20251001');
  });

  it('falls back to the primary model when no weak-tier mapping exists', async () => {
    let summaryModelSeen: string | undefined;
    const provider: Provider = {
      name: 'cohere',
      async listModels() {
        return [];
      },
      getCapabilities() {
        return {
          contextWindow: 128000,
          maxOutputTokens: 4096,
          toolSupport: 'native',
          parallelToolCalls: false,
          streaming: true,
          tokenCounting: 'estimated',
          modelTier: 'strong',
        };
      },
      async *chat() {
        yield { done: true } as ChatChunk;
      },
      async chatNoStream(model: string) {
        summaryModelSeen = model;
        return { content: 'a summary string', done: true } as ChatChunk;
      },
    };

    const conv = new Conversation('SYSTEM');
    for (let i = 0; i < 12; i++) {
      conv.addUser(`q${i}`);
      conv.addAssistant(`a${i}`);
    }
    const cm = new ContextManager(conv, provider.getCapabilities('command-r-plus'), {
      compactionThreshold: 0.0001,
      recencyWindow: 4,
      recencyTokens: 0,
    });
    cm.updateUsage(undefined);
    await cm.compact(provider, 'command-r-plus', undefined);

    assert.strictEqual(summaryModelSeen, 'command-r-plus');
  });
});

describe('ContextManager — summary marks cacheBoundary', () => {
  it('marks the assistant ack of the summary pair with cacheBoundary: true', async () => {
    const conv = new Conversation('SYSTEM');
    conv.addUser('first');
    conv.addAssistant('reply 1');
    conv.addUser('second');
    conv.addAssistant('reply 2');
    conv.addUser('third');
    conv.addAssistant('reply 3');
    conv.addUser('fourth');
    conv.addAssistant('reply 4');

    const cm = new ContextManager(conv, capabilities);
    await cm.compact(noopProvider(), 'm', undefined, { aggressive: true });

    const msgs = conv.getMessages();
    // Layout: [system, user-summary, assistant-ack, ...kept]
    assert.strictEqual(msgs[1].role, 'user');
    assert.ok(msgs[1].content.startsWith('[Previous conversation summary]\n'));
    assert.strictEqual(msgs[2].role, 'assistant');
    assert.strictEqual(msgs[2].content, 'Continuing from the summary above.');
    assert.strictEqual(msgs[2].cacheBoundary, true);
  });
});

describe('ContextManager.ageOldToolResults', () => {
  it('drops the token estimate after aging old tool results', () => {
    const conv = new Conversation('SYSTEM');
    // 8 turns, each with a sizeable tool result. Aging the older 5 should
    // shrink the estimate noticeably.
    for (let i = 1; i <= 8; i++) {
      conv.addUser(`prompt ${i}`);
      conv.addAssistant('', [{ id: `c${i}`, function: { name: 'Read', arguments: {} } }]);
      conv.addToolResult('A'.repeat(2000), `c${i}`, 'Read');
      conv.addAssistant(`reply ${i}`);
    }
    const cm = new ContextManager(conv, capabilities, { toolResultAgingTurns: 3 });
    cm.updateUsage(undefined);
    const before = cm.getTokenEstimate();
    const aged = cm.ageOldToolResults();
    assert.strictEqual(aged, 5);
    const after = cm.getTokenEstimate();
    assert.ok(after < before, `expected token estimate to drop, got ${before} → ${after}`);
  });

  it('returns 0 and leaves estimate untouched when there are too few turns', () => {
    const conv = new Conversation('SYSTEM');
    conv.addUser('a');
    conv.addAssistant('b');
    const cm = new ContextManager(conv, capabilities, { toolResultAgingTurns: 6 });
    cm.updateUsage(undefined);
    const before = cm.getTokenEstimate();
    const aged = cm.ageOldToolResults();
    assert.strictEqual(aged, 0);
    assert.strictEqual(cm.getTokenEstimate(), before);
  });
});
