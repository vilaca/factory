import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { PermissionManager } from '../../src/permissions.js';

describe('PermissionManager', () => {
  let pm: PermissionManager;

  beforeEach(() => {
    pm = new PermissionManager();
  });

  it('isAutoAllowed returns false for unknown tools', () => {
    assert.strictEqual(pm.isAutoAllowed('Bash'), false);
    assert.strictEqual(pm.isAutoAllowed('Read'), false);
  });

  it('allowAll marks a tool as auto-allowed', () => {
    pm.allowAll('Read');
    assert.strictEqual(pm.isAutoAllowed('Read'), true);
  });

  it('auto-allow is per-tool, not global', () => {
    pm.allowAll('Read');
    assert.strictEqual(pm.isAutoAllowed('Read'), true);
    assert.strictEqual(pm.isAutoAllowed('Bash'), false);
  });

  it('allowAll can be called for multiple tools', () => {
    pm.allowAll('Read');
    pm.allowAll('Bash');
    assert.strictEqual(pm.isAutoAllowed('Read'), true);
    assert.strictEqual(pm.isAutoAllowed('Bash'), true);
    assert.strictEqual(pm.isAutoAllowed('Write'), false);
  });

  it('reset clears all auto-allowed tools', () => {
    pm.allowAll('Read');
    pm.allowAll('Bash');
    pm.reset();
    assert.strictEqual(pm.isAutoAllowed('Read'), false);
    assert.strictEqual(pm.isAutoAllowed('Bash'), false);
  });

  it('allowAll is idempotent', () => {
    pm.allowAll('Read');
    pm.allowAll('Read');
    assert.strictEqual(pm.isAutoAllowed('Read'), true);
    pm.reset();
    assert.strictEqual(pm.isAutoAllowed('Read'), false);
  });

  describe('Bash policy', () => {
    it('forbidden command is hard-denied even with allow-all', () => {
      pm.allowAll('Bash');
      const r = pm.evaluateBashCommand('rm -rf /');
      assert.strictEqual(r.kind, 'deny');
      if (r.kind === 'deny') {
        assert.match(r.source, /^forbidden:/);
        assert.match(r.reason, /built-in safety policy/);
      }
    });

    it('user allow rule short-circuits prompt', () => {
      pm.setBashRules([{ pattern: 'git status*', decision: 'allow' }]);
      const r = pm.evaluateBashCommand('git status -s');
      assert.strictEqual(r.kind, 'allow');
    });

    it('user deny rule blocks even when allow-all is set', () => {
      pm.allowAll('Bash');
      pm.setBashRules([{ pattern: 'npm publish*', decision: 'deny' }]);
      const r = pm.evaluateBashCommand('npm publish');
      assert.strictEqual(r.kind, 'deny');
    });

    it('falls through to prompt without allow-all and without rules', () => {
      const r = pm.evaluateBashCommand('ls -la');
      assert.strictEqual(r.kind, 'prompt');
    });

    it('falls through to allow when bash is allow-all and policy says prompt', () => {
      pm.allowAll('Bash');
      const r = pm.evaluateBashCommand('ls -la');
      assert.strictEqual(r.kind, 'allow');
      if (r.kind === 'allow') assert.strictEqual(r.source, 'allow-all');
    });

    it('reset() clears allow-all but preserves bashRules', () => {
      pm.allowAll('Bash');
      pm.setBashRules([{ pattern: 'git *', decision: 'allow' }]);
      pm.reset();
      assert.strictEqual(pm.isAutoAllowed('Bash'), false);
      assert.strictEqual(pm.getBashRules().length, 1);
    });

    it('clearBashRules empties the rules list', () => {
      pm.setBashRules([{ pattern: 'git *', decision: 'allow' }]);
      pm.clearBashRules();
      assert.strictEqual(pm.getBashRules().length, 0);
    });

    it('addBashRule appends to existing rules', () => {
      pm.setBashRules([{ pattern: 'git *', decision: 'allow' }]);
      pm.addBashRule({ pattern: 'npm test*', decision: 'allow' });
      assert.strictEqual(pm.getBashRules().length, 2);
    });
  });

  describe('evaluateTool', () => {
    it('returns allow for auto-allowed tools', () => {
      pm.allowAll('Read');
      assert.deepStrictEqual(pm.evaluateTool('Read'), { kind: 'allow', source: 'allow-all' });
    });

    it('returns prompt otherwise', () => {
      assert.deepStrictEqual(pm.evaluateTool('Read'), { kind: 'prompt' });
    });
  });
});
