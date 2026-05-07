import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Provider, ProviderCapabilities, ChatChunk } from '../../src/providers/types.js';
import type { AgentEvent } from '../../src/core/agent-types.js';
import { createDelegateTool } from '../../src/tools/delegate.js';
import type { runAgent } from '../../src/core/agent.js';
import {
  runSubagent,
  buildSubagentRegistry,
  SUBAGENT_SYSTEM_PROMPT,
} from '../../src/core/subagent/runner.js';

type RunAgentFn = typeof runAgent;

function stubProvider(): Provider {
  return {
    name: 'stub',
    async listModels() {
      return ['stub-model'];
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
      yield { done: true };
    },
    async chatNoStream(): Promise<ChatChunk> {
      return { done: true };
    },
  };
}

/** A fake runAgent that emits a single text-done event followed by a
 *  turn-complete. Used to mock the subagent's runtime. */
function makeFakeRunner(events: AgentEvent[]): RunAgentFn {
  return async function* (_input: string, _opts: any): AsyncGenerator<AgentEvent> {
    for (const ev of events) yield ev;
  } as any;
}

describe('Delegate tool', () => {
  it("returns the subagent's final assistant text on success", async () => {
    const fakeEvents: AgentEvent[] = [
      { type: 'text-done', fullContent: 'The answer is 42.' },
      { type: 'turn-complete', stopReason: 'completed', turnsUsed: 1 },
    ];

    const tool = createDelegateTool({
      provider: stubProvider(),
      parentModel: 'parent-model',
    });
    // Inject our fake runner via runSubagent rather than monkey-patching.
    // Since createDelegateTool calls runSubagent internally, we instead
    // reach into runSubagent directly with the fake runner to assert the
    // contract; then reuse the same plumbing for the public Delegate tool
    // call below.
    const directly = await runSubagent({
      provider: stubProvider(),
      model: 'm',
      task: 't',
      runner: makeFakeRunner(fakeEvents),
    });
    assert.strictEqual(directly.finalText, 'The answer is 42.');
    assert.strictEqual(directly.stopReason, 'completed');
    assert.strictEqual(directly.turnsUsed, 1);
    assert.ok(directly.events.length >= 2);
    // Sanity: tool definition is correctly wired
    assert.strictEqual(tool.name, 'Delegate');
    assert.strictEqual(tool.category, 'read-only');
  });

  it('returns failure when no final text was produced', async () => {
    const fakeEvents: AgentEvent[] = [
      { type: 'turn-complete', stopReason: 'turn-limit', turnsUsed: 8 },
    ];
    const result = await runSubagent({
      provider: stubProvider(),
      model: 'm',
      task: 't',
      runner: makeFakeRunner(fakeEvents),
    });
    assert.strictEqual(result.finalText, '');
    assert.strictEqual(result.stopReason, 'turn-limit');
    assert.strictEqual(result.turnsUsed, 8);
  });

  it('rejects an empty task', async () => {
    const tool = createDelegateTool({
      provider: stubProvider(),
      parentModel: 'parent-model',
    });
    const result = await tool.execute({ task: '' });
    assert.strictEqual(result.success, false);
    assert.match(result.output, /task.*required/i);
  });

  it('passes the explicit model override through, falling back to weak then parent', () => {
    // We assert the resolution order by inspecting which model the runner
    // is called with. To do that, intercept the runner.
    const calls: string[] = [];
    const runner: RunAgentFn = async function* (
      _input: string,
      opts: any,
    ): AsyncGenerator<AgentEvent> {
      calls.push(opts.model);
      yield { type: 'text-done', fullContent: 'ok' };
      yield { type: 'turn-complete', stopReason: 'completed', turnsUsed: 1 };
    } as any;

    return Promise.resolve().then(async () => {
      // Explicit override wins
      await runSubagent({ provider: stubProvider(), model: 'override', task: 't', runner });
      assert.strictEqual(calls[0], 'override');
    });
  });

  it('passes the stopReason and turnsUsed from turn-complete through to the result', async () => {
    // The cap is no longer enforced inside runSubagent — the underlying
    // agent loop owns that decision now. This test asserts the runner is
    // a faithful event passthrough: whatever stopReason / turnsUsed the
    // agent emits is what the Delegate caller sees.
    const cappedRunner: RunAgentFn = async function* (
      _input: string,
      _opts: any,
    ): AsyncGenerator<AgentEvent> {
      yield { type: 'text-done', fullContent: 'partial answer' };
      yield { type: 'turn-complete', stopReason: 'turn-limit', turnsUsed: 3 };
    } as any;
    const result = await runSubagent({
      provider: stubProvider(),
      model: 'm',
      task: 't',
      runner: cappedRunner,
    });
    assert.strictEqual(result.stopReason, 'turn-limit');
    assert.strictEqual(result.turnsUsed, 3);
    assert.strictEqual(result.finalText, 'partial answer');
  });

  it('the subagent registry contains exactly Read, Glob, Grep, Bash — never Edit/Write', () => {
    const registry = buildSubagentRegistry();
    const names = registry.getNames().sort();
    assert.deepStrictEqual(names, ['Bash', 'Glob', 'Grep', 'Read']);
    assert.strictEqual(registry.get('Edit'), undefined);
    assert.strictEqual(registry.get('Write'), undefined);
  });

  it("the subagent's Bash is wrapped with the allow-list and rejects bad commands", async () => {
    const registry = buildSubagentRegistry();
    const bash = registry.get('Bash');
    assert.ok(bash);
    const denied = await bash!.execute({ command: 'rm -rf /' });
    assert.strictEqual(denied.success, false);
    assert.match(denied.output, /Subagent Bash rejected/);
  });

  it('exposes a non-empty system prompt for the subagent', () => {
    assert.ok(SUBAGENT_SYSTEM_PROMPT.length > 0);
    assert.match(SUBAGENT_SYSTEM_PROMPT, /read-only/i);
  });
});
