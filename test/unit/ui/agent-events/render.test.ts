import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  describeRotationReason,
  fingerprintLabel,
  formatHookDisplay,
} from '../../../../src/ui/agent-events/render.js';

describe('describeRotationReason', () => {
  it('maps rate-limit to "rate-limited"', () => {
    assert.strictEqual(describeRotationReason('rate-limit'), 'rate-limited');
  });
  it('maps anything else (including "auth") to "auth failed"', () => {
    assert.strictEqual(describeRotationReason('auth'), 'auth failed');
    assert.strictEqual(describeRotationReason(''), 'auth failed');
    assert.strictEqual(describeRotationReason('unexpected'), 'auth failed');
  });
});

describe('fingerprintLabel', () => {
  it('renders label + ellipsis prefix when a label is present', () => {
    assert.strictEqual(
      fingerprintLabel({ label: 'work-key', fingerprint: 'abc123' }),
      'work-key · …abc123',
    );
  });
  it('renders just the ellipsis prefix when there is no label', () => {
    assert.strictEqual(fingerprintLabel({ fingerprint: 'def456' }), '…def456');
  });
  it('treats an empty-string label the same as no label', () => {
    assert.strictEqual(fingerprintLabel({ label: '', fingerprint: 'xyz' }), '…xyz');
  });
});

describe('formatHookDisplay', () => {
  it('strips path and shell args down to the basename', () => {
    assert.deepStrictEqual(formatHookDisplay('/usr/local/bin/my-hook --arg foo', undefined), {
      display: 'my-hook',
      suffix: '',
    });
  });
  it('appends notice as " — <notice>"', () => {
    assert.deepStrictEqual(formatHookDisplay('./hook.sh', 'cached'), {
      display: 'hook.sh',
      suffix: ' — cached',
    });
  });
  it('handles a bare command with no path or args', () => {
    assert.deepStrictEqual(formatHookDisplay('echo', undefined), {
      display: 'echo',
      suffix: '',
    });
  });
  it('handles empty string defensively', () => {
    assert.deepStrictEqual(formatHookDisplay('', undefined), {
      display: '',
      suffix: '',
    });
  });
});
