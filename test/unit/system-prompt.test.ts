import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getGitStatusSnippet } from '../../src/core/system-prompt.js';

describe('getGitStatusSnippet', () => {
  it('returns an empty string when dirty is null (not a repo)', () => {
    assert.strictEqual(getGitStatusSnippet(null), '');
  });

  it("renders 'clean' when dirty is false", () => {
    assert.strictEqual(getGitStatusSnippet(false), '## Git\n- Status: clean');
  });

  it("renders 'dirty' when dirty is true", () => {
    assert.strictEqual(getGitStatusSnippet(true), '## Git\n- Status: dirty');
  });
});
