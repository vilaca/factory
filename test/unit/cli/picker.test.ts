import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildPickerOptions, findDefaultSelection } from '../../../src/cli/picker.js';
import type { StartupProviderName } from '../../../src/providers/descriptors.js';
import type { StartupCredentials } from '../../../src/cli/auth/index.js';

describe('buildPickerOptions', () => {
  it('returns one entry per descriptor, sorted alphabetically by label', () => {
    const probed = new Map<StartupProviderName, string[] | null>();
    const opts = buildPickerOptions(probed);
    const labels = opts.map(o => o.descriptor.label);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(labels, sorted);
    // Sanity-check known providers are present.
    assert.ok(labels.includes('Anthropic'));
    assert.ok(labels.includes('GitHub Copilot'));
    assert.ok(labels.includes('Ollama'));
  });

  it('marks `when-reachable` providers offline when their probe failed', () => {
    const probed = new Map<StartupProviderName, string[] | null>();
    probed.set('ollama', null); // probe attempted, returned null
    const opts = buildPickerOptions(probed);
    const ollama = opts.find(o => o.descriptor.name === 'ollama');
    assert.ok(ollama, 'expected ollama in picker options');
    assert.strictEqual(ollama!.offline, true);
    assert.strictEqual(ollama!.models, undefined);
  });

  it('marks `when-reachable` providers reachable when models were returned', () => {
    const probed = new Map<StartupProviderName, string[] | null>();
    probed.set('ollama', ['llama3:latest']);
    const opts = buildPickerOptions(probed);
    const ollama = opts.find(o => o.descriptor.name === 'ollama');
    assert.ok(ollama);
    assert.strictEqual(ollama!.offline, false);
    assert.deepStrictEqual(ollama!.models, ['llama3:latest']);
  });

  it('does not mark `always`-visible providers offline even when probe returned null', () => {
    const probed = new Map<StartupProviderName, string[] | null>();
    probed.set('anthropic', null);
    const opts = buildPickerOptions(probed);
    const anthropic = opts.find(o => o.descriptor.name === 'anthropic');
    assert.ok(anthropic);
    assert.strictEqual(anthropic!.offline, false);
  });
});

describe('findDefaultSelection', () => {
  const emptyCreds = new Map<StartupProviderName, StartupCredentials>();

  it('returns undefined when there is no last session', async () => {
    const probed = new Map<StartupProviderName, string[] | null>();
    const result = await findDefaultSelection(null, probed, {}, emptyCreds);
    assert.strictEqual(result, undefined);
  });

  it('returns undefined when last session references an unknown provider', async () => {
    const probed = new Map<StartupProviderName, string[] | null>();
    const result = await findDefaultSelection(
      { provider: 'made-up-provider', model: 'whatever' },
      probed,
      {},
      emptyCreds,
    );
    assert.strictEqual(result, undefined);
  });

  it('returns the last session selection when its model is in the probed list', async () => {
    const probed = new Map<StartupProviderName, string[] | null>();
    probed.set('anthropic', ['claude-sonnet-4-6', 'claude-opus-4-7']);
    const result = await findDefaultSelection(
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      probed,
      {},
      emptyCreds,
    );
    assert.deepStrictEqual(result, { provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  it("returns undefined when the last session's model is not in the probed list", async () => {
    const probed = new Map<StartupProviderName, string[] | null>();
    probed.set('anthropic', ['claude-sonnet-4-6']);
    const result = await findDefaultSelection(
      { provider: 'anthropic', model: 'claude-opus-3-old' },
      probed,
      {},
      emptyCreds,
    );
    assert.strictEqual(result, undefined);
  });

  it('returns undefined when no probe ran and provider has no creds (no on-demand probe)', async () => {
    const probed = new Map<StartupProviderName, string[] | null>();
    // copilot has probeAtStartup=false; without creds we expect no probe attempt.
    const result = await findDefaultSelection(
      { provider: 'copilot', model: 'gpt-4.1' },
      probed,
      {},
      emptyCreds,
    );
    assert.strictEqual(result, undefined);
  });
});
