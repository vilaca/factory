import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseRotationEntry, parseRotationChain } from '../../src/cli/parse-rotation.js';

describe('parseRotationEntry', () => {
  it('parses a simple <provider>:<model>', () => {
    assert.deepStrictEqual(parseRotationEntry('anthropic:claude-haiku-4-5'), {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });
  });

  it('tolerates whitespace', () => {
    assert.deepStrictEqual(parseRotationEntry('  anthropic : claude-haiku-4-5  '), {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });
  });

  it('splits on the first colon — model may contain colons', () => {
    assert.deepStrictEqual(parseRotationEntry('workersai:@cf/llama:variant-1'), {
      provider: 'workersai',
      model: '@cf/llama:variant-1',
    });
  });

  it('returns null for missing colon', () => {
    assert.strictEqual(parseRotationEntry('claude-haiku-4-5'), null);
  });

  it('returns null for empty parts', () => {
    assert.strictEqual(parseRotationEntry(':claude'), null);
    assert.strictEqual(parseRotationEntry('anthropic:'), null);
    assert.strictEqual(parseRotationEntry(':'), null);
  });

  it('returns null for empty string', () => {
    assert.strictEqual(parseRotationEntry(''), null);
    assert.strictEqual(parseRotationEntry('   '), null);
  });
});

describe('parseRotationChain', () => {
  it('parses a comma-separated list', () => {
    assert.deepStrictEqual(parseRotationChain('anthropic:claude-haiku-4-5,groq:llama-3.3-70b'), [
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      { provider: 'groq', model: 'llama-3.3-70b' },
    ]);
  });

  it('skips empty entries from trailing commas', () => {
    assert.deepStrictEqual(parseRotationChain('anthropic:a,,groq:b,'), [
      { provider: 'anthropic', model: 'a' },
      { provider: 'groq', model: 'b' },
    ]);
  });

  it('throws on the first malformed entry', () => {
    assert.throws(
      () => parseRotationChain('anthropic:a,bad-entry,groq:b'),
      /Invalid rotation entry "bad-entry"/,
    );
  });

  it('returns an empty array for an empty string', () => {
    assert.deepStrictEqual(parseRotationChain(''), []);
    assert.deepStrictEqual(parseRotationChain(',,,'), []);
  });
});
