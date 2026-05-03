import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GoogleAiStudioAuthManager } from '../../src/providers/googleaistudio-auth.js';

describe('GoogleAiStudioAuthManager', () => {
  it('returns API-key headers when configured for API key auth', async () => {
    const auth = new GoogleAiStudioAuthManager({
      apiKey: 'gemini-test-key',
      authMode: 'api-key',
    });

    assert.deepStrictEqual(await auth.getChatHeaders(), {
      Authorization: 'Bearer gemini-test-key',
    });
    assert.deepStrictEqual(await auth.getModelsHeaders(), {
      'x-goog-api-key': 'gemini-test-key',
    });
  });

  it('returns OAuth bearer headers when configured for oauth', async () => {
    const auth = new GoogleAiStudioAuthManager({
      authMode: 'oauth',
      auth: {
        async getClient() {
          return {
            async getRequestHeaders() {
              return { Authorization: 'Bearer oauth-access-token' };
            },
          };
        },
      },
    });

    assert.deepStrictEqual(await auth.getChatHeaders(), {
      Authorization: 'Bearer oauth-access-token',
    });
    assert.deepStrictEqual(await auth.getModelsHeaders(), {
      Authorization: 'Bearer oauth-access-token',
    });
  });
});
