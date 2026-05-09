import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createProvider, listProviderNames } from '../../../src/providers/registry.js';

describe('createProvider', () => {
  it('throws "Unknown provider" with the bad name when the provider is not registered', () => {
    assert.throws(
      () => createProvider('foobar'),
      (err: unknown) => {
        assert.ok(err instanceof Error, 'expected an Error');
        assert.match(err.message, /Unknown provider/);
        assert.match(err.message, /foobar/);
        return true;
      },
    );
  });

  it('lists at least the providers referenced in the unknown-provider error message', () => {
    const names = listProviderNames();
    for (const expected of ['ollama', 'huggingface', 'anthropic', 'copilot']) {
      assert.ok(names.includes(expected), `expected ${expected} in listProviderNames()`);
    }
  });
});
