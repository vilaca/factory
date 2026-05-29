import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isCommandAllowed, tokenizeCommand } from '../../../../src/tools/bash-allowlist.js';

describe('subagent bash allow-list', () => {
  describe('positive cases', () => {
    const allowedSamples = [
      'ls',
      'ls -la',
      'ls /tmp',
      'cat package.json',
      'head -n 50 README.md',
      'tail -f /var/log/foo.log',
      'wc -l src/index.ts',
      'find . -name "*.ts"',
      'grep -r "foo" src/',
      'rg -i pattern',
      'git log --oneline -20',
      'git diff HEAD',
      'git show abc123',
      'git status',
      'git branch -a',
      'git ls-files',
      'npm ls --depth=0',
      'node --version',
      'which node',
      'file /usr/bin/ls',
      "awk '{print $1}' file.txt",
      'sed -n 1,40p file.txt',
    ];

    for (const cmd of allowedSamples) {
      it(`allows: ${cmd}`, () => {
        const decision = isCommandAllowed(cmd);
        assert.strictEqual(
          decision.allowed,
          true,
          `expected allowed but got rejected: ${decision.reason}`,
        );
      });
    }
  });

  describe('negative cases — destructive commands', () => {
    const rejected = [
      'rm -rf /',
      'rm file.txt',
      'mv a b',
      'cp a b',
      'echo hello',
      'curl https://example.com',
      'wget https://example.com',
      'npm install',
      'npm run build',
      'git commit -m "bad"',
      'git push',
      'sed -i s/a/b/ file.txt', // sed without -n
      'python script.py',
      'sudo ls',
      'chmod 777 file',
    ];
    for (const cmd of rejected) {
      it(`rejects: ${cmd}`, () => {
        const decision = isCommandAllowed(cmd);
        assert.strictEqual(decision.allowed, false, `expected rejected but got allowed: ${cmd}`);
        assert.ok(decision.reason && decision.reason.length > 0);
      });
    }
  });

  describe('negative cases — shell composition', () => {
    const composed = [
      'ls && rm -rf /',
      'ls; rm file',
      'ls || echo failed',
      'ls | xargs rm',
      'cat $(echo /etc/passwd)',
      'ls `whoami`',
      'cat file > out.txt',
      'cat < input.txt',
      'echo evil >> /etc/hosts',
    ];
    for (const cmd of composed) {
      it(`rejects compound: ${cmd}`, () => {
        const decision = isCommandAllowed(cmd);
        assert.strictEqual(decision.allowed, false);
      });
    }
  });

  describe('edge cases', () => {
    it('rejects empty string', () => {
      assert.strictEqual(isCommandAllowed('').allowed, false);
      assert.strictEqual(isCommandAllowed('   ').allowed, false);
    });

    it('rejects malformed quoting', () => {
      const decision = isCommandAllowed('ls "unterminated');
      assert.strictEqual(decision.allowed, false);
    });

    it('tokenizes quoted args correctly', () => {
      const tokens = tokenizeCommand('grep "foo bar" file.txt');
      assert.deepStrictEqual(tokens, ['grep', 'foo bar', 'file.txt']);
    });

    it('does not allow git foo where foo is not in the allow-list', () => {
      assert.strictEqual(isCommandAllowed('git push origin main').allowed, false);
      assert.strictEqual(isCommandAllowed('git checkout main').allowed, false);
    });

    it('does not allow npm foo where foo is not "ls"', () => {
      assert.strictEqual(isCommandAllowed('npm install').allowed, false);
      assert.strictEqual(isCommandAllowed('npm run test').allowed, false);
    });

    it('does not allow node anything other than --version', () => {
      assert.strictEqual(isCommandAllowed('node script.js').allowed, false);
      assert.strictEqual(isCommandAllowed('node -e "process.exit()"').allowed, false);
    });

    it('does not allow "sed" without -n (write mode)', () => {
      assert.strictEqual(isCommandAllowed('sed s/a/b/ file.txt').allowed, false);
    });
  });
});
