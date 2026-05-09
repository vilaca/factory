import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  applyCliRotationOverrides,
  buildExperimentalConfig,
  canResumeLastSession,
} from '../../../src/cli/startup-config.js';
import type { StartupProviderName } from '../../../src/providers/descriptors.js';
import type { RotationEntry } from '../../../src/core/config/types.js';

describe('canResumeLastSession', () => {
  it('returns true when the descriptor resolves and the model is in the probe', () => {
    const probed = new Map<StartupProviderName, string[] | null>([
      ['anthropic', ['claude-sonnet-4-6', 'claude-haiku-4-5']],
    ]);
    assert.strictEqual(
      canResumeLastSession({ provider: 'anthropic', model: 'claude-sonnet-4-6' }, probed),
      true,
    );
  });

  it('returns false when the provider name is unknown', () => {
    const probed = new Map<StartupProviderName, string[] | null>();
    assert.strictEqual(
      canResumeLastSession({ provider: 'no-such-provider', model: 'foo' }, probed),
      false,
    );
  });

  it('returns false when the probe entry is null (provider unreachable)', () => {
    const probed = new Map<StartupProviderName, string[] | null>([['anthropic', null]]);
    assert.strictEqual(
      canResumeLastSession({ provider: 'anthropic', model: 'claude-sonnet-4-6' }, probed),
      false,
    );
  });

  it('returns false when the model is not in the probed list', () => {
    const probed = new Map<StartupProviderName, string[] | null>([
      ['anthropic', ['claude-haiku-4-5']],
    ]);
    assert.strictEqual(
      canResumeLastSession({ provider: 'anthropic', model: 'nonexistent-model' }, probed),
      false,
    );
  });

  it('resolves provider via descriptor alias', () => {
    // 'claude' is an alias for 'anthropic' per descriptors.ts.
    const probed = new Map<StartupProviderName, string[] | null>([
      ['anthropic', ['claude-sonnet-4-6']],
    ]);
    assert.strictEqual(
      canResumeLastSession({ provider: 'claude', model: 'claude-sonnet-4-6' }, probed),
      true,
    );
  });
});

describe('applyCliRotationOverrides', () => {
  const okChain: RotationEntry[] = [
    { provider: 'anthropic', model: 'claude-haiku-4-5' },
    { provider: 'groq', model: 'llama-3.3-70b' },
  ];
  const stubParse = (_spec: string): RotationEntry[] => okChain;

  it('returns the existing config unchanged when no flags are set', () => {
    const existing = { keys: true, models: true, default: [] };
    const got = applyCliRotationOverrides(existing, {}, stubParse);
    assert.deepStrictEqual(got, existing);
  });

  it('handles undefined existing config without crashing', () => {
    const got = applyCliRotationOverrides(undefined, {}, stubParse);
    assert.deepStrictEqual(got, {});
  });

  it('--rotate sets the default chain via parseChain', () => {
    const got = applyCliRotationOverrides(undefined, { rotate: 'a:b,c:d' }, stubParse);
    assert.deepStrictEqual(got.default, okChain);
  });

  it('--no-rotate disables both tiers', () => {
    const got = applyCliRotationOverrides({}, { noRotate: true }, stubParse);
    assert.strictEqual(got.keys, false);
    assert.strictEqual(got.models, false);
  });

  it('--no-rotate-keys disables only key rotation', () => {
    const got = applyCliRotationOverrides({}, { noRotateKeys: true }, stubParse);
    assert.strictEqual(got.keys, false);
    assert.strictEqual(got.models, undefined);
  });

  it('--no-rotate-models disables only model rotation', () => {
    const got = applyCliRotationOverrides({}, { noRotateModels: true }, stubParse);
    assert.strictEqual(got.models, false);
    assert.strictEqual(got.keys, undefined);
  });

  it('--rotate combined with --no-rotate-keys applies both', () => {
    const got = applyCliRotationOverrides(
      undefined,
      { rotate: 'a:b', noRotateKeys: true },
      stubParse,
    );
    assert.deepStrictEqual(got.default, okChain);
    assert.strictEqual(got.keys, false);
    assert.strictEqual(got.models, undefined);
  });

  it('preserves existing fields not touched by flags', () => {
    const existing = { keys: true, models: true, overrides: { 'a:b': [{ provider: 'g', model: 'm' }] } };
    const got = applyCliRotationOverrides(existing, { noRotateKeys: true }, stubParse);
    assert.deepStrictEqual(got.overrides, existing.overrides);
    assert.strictEqual(got.models, true); // preserved
  });

  it('parseChain throws propagate to caller', () => {
    const throwingParse = (_: string): RotationEntry[] => {
      throw new Error('bad spec');
    };
    assert.throws(
      () => applyCliRotationOverrides(undefined, { rotate: 'garbage' }, throwingParse),
      /bad spec/,
    );
  });

  it('does not call parseChain when --rotate is unset', () => {
    let called = false;
    const guarded = (_: string): RotationEntry[] => {
      called = true;
      return [];
    };
    applyCliRotationOverrides({}, { noRotate: true }, guarded);
    assert.strictEqual(called, false);
  });
});

describe('buildExperimentalConfig', () => {
  it('returns built-in defaults when nothing is set', () => {
    const got = buildExperimentalConfig(undefined, {});
    assert.deepStrictEqual(got, {
      bashDedup: false,
      readCache: true,
      lineCountHint: true,
      subagents: true,
      skills: true,
      hooks: true,
    });
  });

  it('config-file experimental overrides defaults', () => {
    const got = buildExperimentalConfig({ bashDedup: true, skills: false }, {});
    assert.strictEqual(got.bashDedup, true);
    assert.strictEqual(got.skills, false);
    // Other defaults preserved.
    assert.strictEqual(got.readCache, true);
    assert.strictEqual(got.hooks, true);
  });

  it('CLI flags override config-file values', () => {
    // Config says bashDedup=true, CLI passes --no-bash-dedup.
    const got = buildExperimentalConfig({ bashDedup: true }, { noBashDedup: true });
    assert.strictEqual(got.bashDedup, false);
  });

  it('--bash-dedup activates an opt-in feature', () => {
    const got = buildExperimentalConfig(undefined, { bashDedup: true });
    assert.strictEqual(got.bashDedup, true);
  });

  it('--no-skills disables a default-on feature', () => {
    const got = buildExperimentalConfig(undefined, { noSkills: true });
    assert.strictEqual(got.skills, false);
  });

  it('--no-hooks disables hooks', () => {
    const got = buildExperimentalConfig(undefined, { noHooks: true });
    assert.strictEqual(got.hooks, false);
  });

  it('--no-subagents disables subagents', () => {
    const got = buildExperimentalConfig(undefined, { noSubagents: true });
    assert.strictEqual(got.subagents, false);
  });

  it('multiple CLI flags compose', () => {
    const got = buildExperimentalConfig(undefined, {
      bashDedup: true,
      noSkills: true,
      noHooks: true,
    });
    assert.strictEqual(got.bashDedup, true);
    assert.strictEqual(got.skills, false);
    assert.strictEqual(got.hooks, false);
    assert.strictEqual(got.subagents, true); // default-on, untouched
  });

  it('--no-X wins over --X when both are set (no-form is checked second)', () => {
    // Both flags would normally be mutually exclusive at parse time,
    // but if both somehow arrive, the negative should override per the
    // ordering in buildExperimentalConfig.
    const got = buildExperimentalConfig(undefined, { bashDedup: true, noBashDedup: true });
    assert.strictEqual(got.bashDedup, false);
  });

  it('positive CLI flag wins over a config-file false setting', () => {
    const got = buildExperimentalConfig({ skills: false }, { skills: true });
    assert.strictEqual(got.skills, true);
  });
});
