import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  DESCRIPTORS,
  DESCRIPTOR_LIST,
  descriptorByAlias,
  resolveToken,
} from '../../../src/providers/registry.js';
import type { Config } from '../../../src/core/config/types.js';

describe('DESCRIPTORS', () => {
  it('every entry has a non-empty name and label', () => {
    for (const descriptor of DESCRIPTOR_LIST) {
      assert.ok(descriptor.name, `descriptor missing name`);
      assert.ok(descriptor.label, `descriptor ${descriptor.name} missing label`);
    }
  });

  it('every aliases array is unique within itself', () => {
    for (const descriptor of DESCRIPTOR_LIST) {
      const seen = new Set<string>();
      for (const alias of descriptor.aliases) {
        assert.ok(!seen.has(alias), `descriptor ${descriptor.name} has duplicate alias "${alias}"`);
        seen.add(alias);
      }
    }
  });

  it('aliases do not collide across providers', () => {
    const owner = new Map<string, string>();
    for (const descriptor of DESCRIPTOR_LIST) {
      for (const alias of descriptor.aliases) {
        const previous = owner.get(alias);
        assert.ok(
          previous === undefined,
          `alias "${alias}" claimed by both ${previous} and ${descriptor.name}`,
        );
        owner.set(alias, descriptor.name);
      }
    }
  });

  it('descriptorByAlias resolves canonical names and aliases', () => {
    assert.strictEqual(descriptorByAlias('openrouter')?.name, 'openrouter');
    assert.strictEqual(descriptorByAlias('open-router')?.name, 'openrouter');
    assert.strictEqual(descriptorByAlias('OR')?.name, 'openrouter');
    assert.strictEqual(descriptorByAlias('GitHub Copilot')?.name, 'copilot');
    assert.strictEqual(descriptorByAlias('cloudflare')?.name, 'workersai');
    assert.strictEqual(descriptorByAlias('not-a-thing'), undefined);
  });
});

describe('resolveToken', () => {
  function withClearedEnv(vars: string[], fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const key of vars) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      fn();
    } finally {
      for (const key of vars) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  it('prefers cliToken over every other source', () => {
    withClearedEnv(['MISTRAL_API_KEY'], () => {
      const config: Config = { token: 'generic' };
      assert.strictEqual(resolveToken(DESCRIPTORS.mistral, config, 'from-cli'), 'from-cli');
    });
  });

  it('falls back to env vars when no cli token and no config token field is present', () => {
    withClearedEnv(['MISTRAL_API_KEY'], () => {
      process.env.MISTRAL_API_KEY = 'from-env';
      try {
        assert.strictEqual(resolveToken(DESCRIPTORS.mistral, {}), 'from-env');
      } finally {
        delete process.env.MISTRAL_API_KEY;
      }
    });
  });

  it('falls back to env vars when no config token', () => {
    process.env.MISTRAL_API_KEY = 'from-env';
    try {
      assert.strictEqual(resolveToken(DESCRIPTORS.mistral, {}), 'from-env');
    } finally {
      delete process.env.MISTRAL_API_KEY;
    }
  });

  it('does NOT leak generic config.token to simple-prompt providers', () => {
    withClearedEnv(['OPENROUTER_API_KEY', 'MISTRAL_API_KEY', 'COHERE_API_KEY'], () => {
      const config: Config = { token: 'sk-or-v1-DO-NOT-LEAK' };
      assert.strictEqual(resolveToken(DESCRIPTORS.mistral, config), undefined);
      assert.strictEqual(resolveToken(DESCRIPTORS.cohere, config), undefined);
      assert.strictEqual(resolveToken(DESCRIPTORS.openrouter, config), undefined);
    });
  });

  it('honors envPrecedesConfig for Vercel', () => {
    process.env.AI_GATEWAY_API_KEY = 'env-wins';
    try {
      const config: Config = {};
      assert.strictEqual(resolveToken(DESCRIPTORS.vercel, config), 'env-wins');
    } finally {
      delete process.env.AI_GATEWAY_API_KEY;
    }
  });

  it('respects env-var ordering (first match wins)', () => {
    process.env.OPENCODE_ZEN_API_KEY = 'first';
    process.env.OPENCODE_API_KEY = 'second';
    try {
      assert.strictEqual(resolveToken(DESCRIPTORS.opencodezen, {}), 'first');
    } finally {
      delete process.env.OPENCODE_ZEN_API_KEY;
      delete process.env.OPENCODE_API_KEY;
    }
  });

  it('returns undefined when no source has a token', () => {
    withClearedEnv(['CEREBRAS_API_KEY'], () => {
      assert.strictEqual(resolveToken(DESCRIPTORS.cerebras, {}), undefined);
    });
  });
});
