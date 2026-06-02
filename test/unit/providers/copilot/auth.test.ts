import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import {
  CopilotAuthManager,
  inferCopilotCredentialKind,
} from '../../../../src/providers/copilot/auth.js';

function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to get server address'));
        return;
      }

      try {
        await fn(`http://127.0.0.1:${address.port}`);
        server.close(err => (err ? reject(err) : resolve()));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

describe('CopilotAuthManager', () => {
  it('classifies GitHub tokens distinctly from direct Copilot tokens', () => {
    assert.strictEqual(inferCopilotCredentialKind('gho_test'), 'github');
    assert.strictEqual(inferCopilotCredentialKind('github_pat_test'), 'github');
    assert.strictEqual(inferCopilotCredentialKind('ghu_test'), 'github');
    assert.strictEqual(inferCopilotCredentialKind('copilot_bearer'), 'copilot');
  });

  it('exchanges a GitHub token for a Copilot token and uses endpoints.api', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.url, '/copilot_internal/v2/token');
        assert.strictEqual(req.headers.authorization, 'token gho_test');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            token: 'copilot_token',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            endpoints: { api: 'https://copilot.example.test' },
            chat_enabled: true,
          }),
        );
      },
      async baseUrl => {
        const prevApi = process.env.FACTORY_GITHUB_API_BASE_URL;
        process.env.FACTORY_GITHUB_API_BASE_URL = baseUrl;
        try {
          const auth = new CopilotAuthManager({ githubToken: 'gho_test' });
          const session = await auth.getSession();
          assert.strictEqual(session.token, 'copilot_token');
          assert.strictEqual(session.apiBaseUrl, 'https://copilot.example.test');
          assert.strictEqual(session.chatEnabled, true);
        } finally {
          if (prevApi === undefined) delete process.env.FACTORY_GITHUB_API_BASE_URL;
          else process.env.FACTORY_GITHUB_API_BASE_URL = prevApi;
        }
      },
    );
  });

  it('runs device flow and forwards the GitHub token to persistence callback', async () => {
    let deviceRequested = false;
    let tokenPolled = false;

    await withServer(
      (req, res) => {
        if (req.url === '/login/device/code') {
          deviceRequested = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              device_code: 'device_code',
              user_code: 'ABCD-EFGH',
              verification_uri: 'https://example.test/device',
              expires_in: 900,
              interval: 0,
            }),
          );
          return;
        }
        if (req.url === '/login/oauth/access_token') {
          tokenPolled = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'gho_saved_token',
              token_type: 'bearer',
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end('Not found');
      },
      async baseUrl => {
        const prevLogin = process.env.FACTORY_GITHUB_LOGIN_BASE_URL;
        process.env.FACTORY_GITHUB_LOGIN_BASE_URL = baseUrl;

        let persistedToken: string | undefined;
        try {
          const auth = new CopilotAuthManager({
            onGithubTokenPersist: token => {
              persistedToken = token;
            },
          });
          let promptSeen = false;
          await auth.authenticateWithDeviceFlow(async ({ userCode, verificationUri }) => {
            promptSeen = true;
            assert.strictEqual(userCode, 'ABCD-EFGH');
            assert.strictEqual(verificationUri, 'https://example.test/device');
          });
          assert.ok(deviceRequested);
          assert.ok(tokenPolled);
          assert.ok(promptSeen);
          assert.strictEqual(persistedToken, 'gho_saved_token');
        } finally {
          if (prevLogin === undefined) delete process.env.FACTORY_GITHUB_LOGIN_BASE_URL;
          else process.env.FACTORY_GITHUB_LOGIN_BASE_URL = prevLogin;
        }
      },
    );
  });
});
