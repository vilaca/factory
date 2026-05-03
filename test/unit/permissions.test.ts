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
});
