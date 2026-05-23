import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  parseModelSpec,
  type DescriptorResolver,
} from '../../../../src/core/selection/parse-model-spec.js';
import type { ProviderDescriptor } from '../../../../src/providers/registry.js';

// The parser owns the colon-handling rule that was previously inlined at
// the one swap.ts call site. These tests pin the contract directly,
// independent of swap.ts; the swap suite still covers end-to-end routing.

function fakeDescriptor(name: string): ProviderDescriptor {
  return { name } as unknown as ProviderDescriptor;
}

/** Resolver that recognizes exactly the names in `known`. */
function resolverFor(known: string[]): DescriptorResolver {
  const set = new Set(known);
  return alias => (set.has(alias) ? fakeDescriptor(alias) : undefined);
}

describe('parseModelSpec', () => {
  it('returns bare-model for inputs with no colon', () => {
    const spec = parseModelSpec('gpt-4o', resolverFor(['openai']));
    assert.deepEqual(spec, { kind: 'bare-model', model: 'gpt-4o' });
  });

  it('returns provider-model when the prefix is a known alias', () => {
    const spec = parseModelSpec(
      'anthropic:claude-3-5-sonnet',
      resolverFor(['anthropic', 'openai']),
    );
    assert.deepEqual(spec, {
      kind: 'provider-model',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
    });
  });

  it('preserves trailing colons in the model when prefix is a known alias (Ollama tag)', () => {
    // Regression: `ollama:llama3.1:8b` must split on FIRST colon only, so
    // the Ollama tag `llama3.1:8b` is not mangled.
    const spec = parseModelSpec('ollama:llama3.1:8b', resolverFor(['ollama']));
    assert.deepEqual(spec, {
      kind: 'provider-model',
      provider: 'ollama',
      model: 'llama3.1:8b',
    });
  });

  it('treats unknown-prefix colon-form as a bare model (Ollama tagged names)', () => {
    // The original 6287738 bug: `deepseek-coder:33b-instruct` was misparsed
    // as provider=deepseek-coder, model=33b-instruct. With no alias matching
    // `deepseek-coder`, the whole string is a bare model on the current
    // provider.
    const spec = parseModelSpec('deepseek-coder:33b-instruct', resolverFor(['ollama', 'openai']));
    assert.deepEqual(spec, {
      kind: 'bare-model',
      model: 'deepseek-coder:33b-instruct',
    });
  });

  it('treats `:<tag>` (empty prefix) as a bare model', () => {
    const spec = parseModelSpec(':33b-instruct', resolverFor(['ollama']));
    assert.deepEqual(spec, { kind: 'bare-model', model: ':33b-instruct' });
  });

  it('treats `<known>:` (empty model) as a bare model', () => {
    // A trailing colon with no model can't be a provider-model spec —
    // there's no model to switch to. Hand it back as bare; the caller's
    // validation pipeline will report it.
    const spec = parseModelSpec('ollama:', resolverFor(['ollama']));
    assert.deepEqual(spec, { kind: 'bare-model', model: 'ollama:' });
  });

  it('returns bare-model with empty string for empty input', () => {
    const spec = parseModelSpec('', resolverFor(['ollama']));
    assert.deepEqual(spec, { kind: 'bare-model', model: '' });
  });

  it('does not call the resolver when there is no colon', () => {
    let calls = 0;
    const resolver: DescriptorResolver = alias => {
      calls += 1;
      return alias === 'openai' ? fakeDescriptor('openai') : undefined;
    };
    parseModelSpec('gpt-4o', resolver);
    assert.equal(calls, 0);
  });
});
