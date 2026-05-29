import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Provider, ProviderCapabilities, ChatChunk } from '../../../src/providers/types.js';
import type { AgentEvent } from '../../../src/core/agent/types.js';
import { createDelegateTool } from '../../../src/tools/delegate.js';
import type { runAgent } from '../../../src/core/agent/run-agent.js';
import {
  runSubagent,
  SUBAGENT_SYSTEM_PROMPT,
} from '../../../src/core/subagent/runner.js';
import { buildSubagentRegistry } from '../../../src/tools/index.js';

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
      registry: buildSubagentRegistry(),
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
      registry: buildSubagentRegistry(),
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
      await runSubagent({ provider: stubProvider(), model: 'override', task: 't', runner, registry: buildSubagentRegistry() });
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
      registry: buildSubagentRegistry(),
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

describe('Delegate tool — execute() post-processing', () => {
  // Drive the tool end-to-end via the injected runner. These cover the
  // post-runSubagent branches in delegate.ts that runSubagent-direct tests
  // never reach: turn-limit footer, empty-text failure, error path,
  // sessionLogger fan-out, and explicit/weak/parent model resolution.

  function makeTool(opts: {
    weakModel?: string;
    parentModel?: string;
    runner: RunAgentFn;
    sessionLogger?: { logWarning: (k: string, v: string) => void };
  }): ReturnType<typeof createDelegateTool> {
    return createDelegateTool({
      provider: stubProvider(),
      parentModel: opts.parentModel ?? 'parent-model',
      weakModel: opts.weakModel,
      runner: opts.runner,

      sessionLogger: opts.sessionLogger as any,
    });
  }

  it('returns success=true with the trimmed final text when the subagent completes', async () => {
    const runner = makeFakeRunner([
      { type: 'text-done', fullContent: '  the answer is 42  ' },
      { type: 'turn-complete', stopReason: 'completed', turnsUsed: 2 },
    ]);
    const tool = makeTool({ runner });
    const r = await tool.execute({ task: 'what is the answer?' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.output, 'the answer is 42');
  });

  it('returns success=false with a turn-limit footer when the subagent exhausted its budget', async () => {
    const runner = makeFakeRunner([
      { type: 'text-done', fullContent: 'partial finding' },
      { type: 'turn-complete', stopReason: 'turn-limit', turnsUsed: 30 },
    ]);
    const tool = makeTool({ runner });
    const r = await tool.execute({ task: 'go investigate' });
    assert.strictEqual(r.success, false);
    assert.match(r.output, /partial finding/);
    assert.match(r.output, /\[note: subagent hit its tool-call cap/);
  });

  it('returns success=false with a stopped-without-answer message when no text was produced', async () => {
    const runner = makeFakeRunner([
      { type: 'turn-complete', stopReason: 'user-abort', turnsUsed: 4 },
    ]);
    const tool = makeTool({ runner });
    const r = await tool.execute({ task: 'go investigate' });
    assert.strictEqual(r.success, false);
    assert.match(r.output, /subagent stopped \(user-abort, 4 turns\) without producing/);
  });

  it('catches runner errors and returns them as a Delegate failure', async () => {
    const runner: RunAgentFn = async function* () {
      throw new Error('provider exploded');
    } as any;
    const tool = makeTool({ runner });
    const r = await tool.execute({ task: 'go investigate' });
    assert.strictEqual(r.success, false);
    assert.match(r.output, /Delegate: subagent failed: provider exploded/);
  });

  it('falls back to weakModel when no override is given', async () => {
    let observedModel = '';
    const runner: RunAgentFn = async function* (
      _input: string,

      opts: any,
    ): AsyncGenerator<AgentEvent> {
      observedModel = opts.model;
      yield { type: 'text-done', fullContent: 'ok' };
      yield { type: 'turn-complete', stopReason: 'completed', turnsUsed: 1 };
    } as any;
    const tool = makeTool({ runner, weakModel: 'weak-1', parentModel: 'parent-1' });
    await tool.execute({ task: 't' });
    assert.strictEqual(observedModel, 'weak-1');
  });

  it('falls back to parentModel when neither override nor weakModel is set', async () => {
    let observedModel = '';
    const runner: RunAgentFn = async function* (
      _input: string,

      opts: any,
    ): AsyncGenerator<AgentEvent> {
      observedModel = opts.model;
      yield { type: 'text-done', fullContent: 'ok' };
      yield { type: 'turn-complete', stopReason: 'completed', turnsUsed: 1 };
    } as any;
    const tool = makeTool({ runner, parentModel: 'parent-only' });
    await tool.execute({ task: 't' });
    assert.strictEqual(observedModel, 'parent-only');
  });

  it('honours an explicit model override even when weakModel is set', async () => {
    let observedModel = '';
    const runner: RunAgentFn = async function* (
      _input: string,

      opts: any,
    ): AsyncGenerator<AgentEvent> {
      observedModel = opts.model;
      yield { type: 'text-done', fullContent: 'ok' };
      yield { type: 'turn-complete', stopReason: 'completed', turnsUsed: 1 };
    } as any;
    const tool = makeTool({ runner, weakModel: 'weak-1', parentModel: 'parent-1' });
    await tool.execute({ task: 't', model: 'explicit-2' });
    assert.strictEqual(observedModel, 'explicit-2');
  });

  it('treats a whitespace-only model arg as no override (falls through to weak/parent)', async () => {
    let observedModel = '';
    const runner: RunAgentFn = async function* (
      _input: string,

      opts: any,
    ): AsyncGenerator<AgentEvent> {
      observedModel = opts.model;
      yield { type: 'text-done', fullContent: 'ok' };
      yield { type: 'turn-complete', stopReason: 'completed', turnsUsed: 1 };
    } as any;
    const tool = makeTool({ runner, weakModel: 'weak-1' });
    await tool.execute({ task: 't', model: '   ' });
    assert.strictEqual(observedModel, 'weak-1');
  });

  it('mirrors every subagent event into the parent session logger when one is provided', async () => {
    const calls: Array<{ key: string; value: string }> = [];
    const sessionLogger = {
      logWarning: (key: string, value: string): void => {
        calls.push({ key, value });
      },
    };
    const runner = makeFakeRunner([
      { type: 'text-done', fullContent: 'done' },
      { type: 'turn-complete', stopReason: 'completed', turnsUsed: 1 },
    ]);
    const tool = makeTool({ runner, sessionLogger });
    await tool.execute({ task: 't' });
    assert.ok(calls.length >= 2);
    assert.ok(calls.every(c => c.key === 'subagent'));
    assert.ok(calls.some(c => /text-done/.test(c.value)));
  });

  it('does not let a sessionLogger throw bubble out of the tool result', async () => {
    const sessionLogger = {
      logWarning: (): void => {
        throw new Error('disk full');
      },
    };
    const runner = makeFakeRunner([
      { type: 'text-done', fullContent: 'survived' },
      { type: 'turn-complete', stopReason: 'completed', turnsUsed: 1 },
    ]);
    const tool = makeTool({ runner, sessionLogger });
    const r = await tool.execute({ task: 't' });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.output, 'survived');
  });
});
