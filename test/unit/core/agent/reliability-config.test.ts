import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Provider, ProviderCapabilities, ModelTier } from '../../../../src/providers/types.js';
import { autoEnableForModel } from '../../../../src/core/agent/reliability-config.js';

function mkProvider(name: string, tier: ModelTier): Provider {
  const caps: ProviderCapabilities = {
    contextWindow: 8192,
    maxOutputTokens: 2048,
    toolSupport: 'native',
    parallelToolCalls: true,
    streaming: true,
    tokenCounting: 'exact',
    modelTier: tier,
  };
  return {
    name,
    getCapabilities: () => caps,
  } as unknown as Provider;
}

describe('autoEnableForModel', () => {
  it('weak tier → useRespondTool=true', () => {
    const r = autoEnableForModel(mkProvider('ollama', 'weak'), 'random-7b');
    assert.equal(r.useRespondTool, true);
  });

  it('strong tier without sampling profile → useRespondTool=false', () => {
    const r = autoEnableForModel(mkProvider('anthropic', 'strong'), 'claude-opus-4-7');
    assert.equal(r.useRespondTool, false);
  });

  it('medium tier without sampling profile → useRespondTool=false', () => {
    const r = autoEnableForModel(mkProvider('openai', 'medium'), 'gpt-4o-mini');
    assert.equal(r.useRespondTool, false);
  });

  it('strong tier but has sampling profile → useRespondTool=true (table entry wins)', () => {
    // ministral-3-reasoning has a per-model sampling entry; even if the
    // provider mislabels its tier as strong, the table opts it into the stack.
    const r = autoEnableForModel(mkProvider('ollama', 'strong'), 'ministral-3-reasoning-q4');
    assert.equal(r.useRespondTool, true);
  });

  it('forceToolCall only fires for weak-tier Anthropic', () => {
    assert.equal(
      autoEnableForModel(mkProvider('anthropic', 'weak'), 'claude-haiku-4-5').forceToolCall,
      true,
    );
    assert.equal(
      autoEnableForModel(mkProvider('anthropic', 'strong'), 'claude-opus-4-7').forceToolCall,
      false,
    );
    assert.equal(
      autoEnableForModel(mkProvider('ollama', 'weak'), 'random-7b').forceToolCall,
      false,
    );
    // Sampling-profile-driven activation does NOT trigger forceToolCall — only weak tier does.
    assert.equal(
      autoEnableForModel(mkProvider('anthropic', 'strong'), 'ministral-3-reasoning-q4')
        .forceToolCall,
      false,
    );
  });
});
