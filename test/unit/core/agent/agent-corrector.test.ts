import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type {
  Provider,
  ChatChunk,
  ProviderCapabilities,
} from '../../../../src/providers/types.js';
import type { AgentEvent } from '../../../../src/core/agent-types.js';
import { Conversation } from '../../../../src/core/conversation.js';
import { PermissionManager } from '../../../../src/permissions.js';
import { defaultRegistry } from '../../../../src/tools/index.js';
import { runAgent } from '../../../../src/core/agent/run-agent.js';
import { createMockProvider, collectEvents, findEvents } from './agent-helpers.js';

describe('Agent loop — corrector integration', () => {
  it('invokes the corrector after a tool failure and runs the corrected call', async () => {
    const permissions = new PermissionManager();
    permissions.allowAll('Read');

    const tmpFp = path.join(os.tmpdir(), `oc-corr-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(tmpFp, 'corrected file content');

    try {
      const provider = createMockProvider([
        // Turn 1: model emits a Read on a missing file (will fail).
        {
          tool_calls: [
            {
              function: {
                name: 'Read',
                arguments: { file_path: '/definitely-does-not-exist-zzz' },
              },
            },
          ],
        },
        // Corrector chatNoStream: returns JSON proposing a corrected Read.
        { content: `{"name":"Read","arguments":{"file_path":${JSON.stringify(tmpFp)}}}` },
        // Turn 2: model wraps up.
        { content: 'Done.' },
      ]);

      const events = await collectEvents('read it', provider, {
        permissions,
        enableCorrector: true,
      });

      const corrected = findEvents(events, 'tool-call-corrected');
      assert.strictEqual(corrected.length, 1, 'expected one tool-call-corrected event');

      const results = findEvents(events, 'tool-call-result');
      // First call fails, second call (corrected) succeeds.
      assert.strictEqual(results.length, 2);
      assert.strictEqual((results[0] as any).result.success, false);
      assert.strictEqual((results[1] as any).result.success, true);
      assert.ok((results[1] as any).result.output.includes('corrected file content'));

      const complete = findEvents(events, 'turn-complete');
      assert.strictEqual(complete.length, 1);
      assert.strictEqual((complete[0] as any).stopReason, 'completed');
    } finally {
      try {
        fs.unlinkSync(tmpFp);
      } catch {
        /* ignore */
      }
    }
  });

  it('routes the corrector call to the weak-tier model on the same provider when available', async () => {
    // Anthropic strong-tier (sonnet) + WEAK_TIER_MAP[anthropic] = haiku.
    // The primary turn must keep using sonnet; only the corrector
    // sub-call hops to haiku.
    const permissions = new PermissionManager();
    permissions.allowAll('Read');

    const tmpFp = path.join(os.tmpdir(), `oc-tier-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(tmpFp, 'corrected content');

    const primaryModelCalls: string[] = [];
    const correctorModelCalls: string[] = [];
    const provider: Provider = {
      name: 'anthropic',
      async listModels() {
        return ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
      },
      getCapabilities(model: string): ProviderCapabilities {
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
      async *chat(model: string): AsyncGenerator<ChatChunk> {
        primaryModelCalls.push(model);
        // Two streaming chunks across the two primary turns.
        if (primaryModelCalls.length === 1) {
          yield {
            tool_calls: [
              {
                function: {
                  name: 'Read',
                  arguments: { file_path: '/definitely-does-not-exist-zzz' },
                },
              },
            ],
          };
          yield { done: true };
        } else {
          yield { content: 'Done.', done: true };
        }
      },
      async chatNoStream(model: string) {
        // Only the corrector goes through chatNoStream.
        correctorModelCalls.push(model);
        return {
          content: `{"name":"Read","arguments":{"file_path":${JSON.stringify(tmpFp)}}}`,
          done: true,
        };
      },
    };

    try {
      const conversation = new Conversation('You are a test assistant.');
      const events: AgentEvent[] = [];
      const agent = runAgent('read it', {
        provider,
        model: 'claude-sonnet-4-6',
        conversation,
        permissions,
        toolRegistry: defaultRegistry,
        enableCorrector: true,
      });
      for await (const ev of agent) {
        events.push(ev);
        if (ev.type === 'permission-request') ev.respond('allow');
      }

      const corrected = findEvents(events, 'tool-call-corrected');
      assert.strictEqual(corrected.length, 1, 'expected the corrector to fire');
      // Primary stream calls used sonnet on every turn.
      for (const m of primaryModelCalls) {
        assert.strictEqual(m, 'claude-sonnet-4-6');
      }
      // Corrector chatNoStream went to haiku (the weak-tier mapping).
      assert.strictEqual(correctorModelCalls.length, 1);
      assert.strictEqual(correctorModelCalls[0], 'claude-haiku-4-5-20251001');
    } finally {
      try {
        fs.unlinkSync(tmpFp);
      } catch {
        /* ignore */
      }
    }
  });

  it('records exactly one tool_result keyed to the original tool_use id after correction', async () => {
    // Anthropic rejects requests where a tool_result has no matching
    // tool_use in the previous assistant message. Before the fix, the
    // corrector path appended a second tool_result (for the substituted
    // call) on top of the failed call's tool_result, which violated that
    // invariant. This test pins the fix.
    const permissions = new PermissionManager();
    permissions.allowAll('Read');

    const tmpFp = path.join(os.tmpdir(), `oc-corr2-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(tmpFp, 'corrected file content');

    try {
      const provider = createMockProvider([
        {
          tool_calls: [
            {
              // Provider-supplied id, like the real Anthropic stream.
              id: 'toolu_test_orig_id',
              function: {
                name: 'Read',
                arguments: { file_path: '/definitely-does-not-exist-zzz' },
              },
            } as any,
          ],
        },
        { content: `{"name":"Read","arguments":{"file_path":${JSON.stringify(tmpFp)}}}` },
        { content: 'Done.' },
      ]);

      const conversation = new Conversation('You are a test assistant.');
      const events: AgentEvent[] = [];
      const agent = runAgent('read it', {
        provider,
        model: 'mock-model',
        conversation,
        permissions,
        toolRegistry: defaultRegistry,
        enableCorrector: true,
      });
      for await (const ev of agent) {
        events.push(ev);
        if (ev.type === 'permission-request') ev.respond('allow');
      }

      const corrected = findEvents(events, 'tool-call-corrected');
      assert.strictEqual(corrected.length, 1);

      const msgs = conversation.getMessages();
      const toolMsgs = msgs.filter(m => m.role === 'tool');
      assert.strictEqual(toolMsgs.length, 1, 'expected a single tool_result after correction');
      assert.strictEqual(toolMsgs[0].tool_call_id, 'toolu_test_orig_id');
      assert.ok(
        (toolMsgs[0].content as string).includes('corrected file content'),
        'tool_result should carry the substituted output',
      );
      assert.ok(
        (toolMsgs[0].content as string).includes('Tool corrector'),
        'tool_result should carry the substitution preamble',
      );
    } finally {
      try {
        fs.unlinkSync(tmpFp);
      } catch {
        /* ignore */
      }
    }
  });
});
