import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { bearerAuth, normalizeBaseUrl } from '../shared.js';
import { makeAbortError } from '../../utils/errors.js';

function readPackageVersion(): string {
  // Walk up from this file until we find package.json (handles any outDir depth)
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
        version?: string;
      };
      if (pkg.version) return pkg.version;
    } catch {
      /* not found here, keep walking */
    }
    dir = dirname(dir);
  }
  return 'unknown';
}

const DEFAULT_GITHUB_LOGIN_BASE_URL = 'https://github.com';
const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const COPILOT_OAUTH_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const COPILOT_API_VERSION = '2023-07-07';
const COPILOT_INTEGRATION_ID = 'vscode-chat';
const USER_AGENT = `factory/${readPackageVersion()}`;
const TOKEN_REFRESH_SKEW_MS = 60_000;

interface CopilotAuthOptions {
  githubToken?: string;
  copilotToken?: string;
  host?: string;
  onGithubTokenPersist?: (token: string) => Promise<void> | void;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  error_uri?: string;
}

interface CopilotTokenResponse {
  token: string;
  expires_at: number;
  endpoints?: {
    api?: string;
  };
  chat_enabled?: boolean;
}

interface CopilotSession {
  token: string;
  expiresAtMs: number;
  apiBaseUrl: string;
  chatEnabled: boolean;
}

interface DeviceAuthPrompt {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

export class CopilotAuthManager {
  private githubToken?: string;
  private directCopilotToken?: string;
  private hostOverride?: string;
  private onGithubTokenPersist?: (token: string) => Promise<void> | void;
  private session: CopilotSession | null = null;

  constructor(options: CopilotAuthOptions = {}) {
    this.githubToken = options.githubToken;
    this.directCopilotToken = options.copilotToken;
    this.hostOverride = options.host;
    this.onGithubTokenPersist = options.onGithubTokenPersist;
  }

  async authenticateWithDeviceFlow(
    onPrompt?: (prompt: DeviceAuthPrompt) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<void> {
    const device = await this.requestDeviceCode(signal);
    await onPrompt?.({
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      expiresIn: device.expires_in,
    });

    this.githubToken = await this.pollForAccessToken(device, signal);
    await this.onGithubTokenPersist?.(this.githubToken);
  }

  async getSession(signal?: AbortSignal): Promise<CopilotSession> {
    if (this.directCopilotToken) {
      return {
        token: this.directCopilotToken,
        expiresAtMs: Number.POSITIVE_INFINITY,
        apiBaseUrl: normalizeBaseUrl(this.hostOverride ?? 'https://api.githubcopilot.com'),
        chatEnabled: true,
      };
    }

    if (this.session && Date.now() < this.session.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
      return this.session;
    }

    if (!this.githubToken) {
      throw new Error(
        'GitHub authentication required. Sign in via device flow or set GITHUB_COPILOT_API_KEY/COPILOT_API_KEY.',
      );
    }

    const response = await fetch(`${githubApiBaseUrl()}/copilot_internal/v2/token`, {
      headers: {
        Authorization: `token ${this.githubToken}`,
        Accept: 'application/json',
        'Editor-Version': 'vscode/1.99.0',
        'Editor-Plugin-Version': 'copilot-chat/0.26.7',
        'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
        'User-Agent': USER_AGENT,
      },
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub Copilot token exchange failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as CopilotTokenResponse;
    if (!data.token) {
      throw new Error('GitHub Copilot token exchange returned no token.');
    }

    this.session = {
      token: data.token,
      expiresAtMs: data.expires_at * 1000,
      apiBaseUrl: normalizeBaseUrl(
        this.hostOverride ?? data.endpoints?.api ?? 'https://api.githubcopilot.com',
      ),
      chatEnabled: data.chat_enabled !== false,
    };
    return this.session;
  }

  authHeaders(token: string): Record<string, string> {
    return {
      ...bearerAuth(token),
      'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
      'X-GitHub-Api-Version': COPILOT_API_VERSION,
      'Editor-Version': 'vscode/1.99.0',
      'Editor-Plugin-Version': 'copilot-chat/0.26.7',
      'User-Agent': USER_AGENT,
    };
  }

  private async requestDeviceCode(signal?: AbortSignal): Promise<DeviceCodeResponse> {
    const response = await fetch(`${githubLoginBaseUrl()}/login/device/code`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: COPILOT_OAUTH_CLIENT_ID,
      }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub device flow failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<DeviceCodeResponse>;
  }

  private async pollForAccessToken(
    device: DeviceCodeResponse,
    signal?: AbortSignal,
  ): Promise<string> {
    const expiresAt = Date.now() + device.expires_in * 1000;
    let intervalSec = Math.max(device.interval, 1);

    while (Date.now() < expiresAt) {
      await delay(intervalSec * 1000, signal);

      const response = await fetch(`${githubLoginBaseUrl()}/login/oauth/access_token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: new URLSearchParams({
          client_id: COPILOT_OAUTH_CLIENT_ID,
          device_code: device.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`GitHub device flow token exchange failed (${response.status}): ${text}`);
      }

      const data = (await response.json()) as AccessTokenResponse;
      if (data.access_token) {
        return data.access_token;
      }

      switch (data.error) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          intervalSec += 5;
          continue;
        case 'expired_token':
          throw new Error('GitHub device code expired before authorization completed.');
        case 'access_denied':
          throw new Error('GitHub device flow authorization was denied.');
        default:
          throw new Error(data.error_description ?? data.error ?? 'GitHub device flow failed.');
      }
    }

    throw new Error('GitHub device flow timed out before authorization completed.');
  }
}

export function inferCopilotCredentialKind(token?: string): 'github' | 'copilot' | null {
  if (!token) return null;
  if (
    token.startsWith('gho_') ||
    token.startsWith('ghu_') ||
    token.startsWith('ghs_') ||
    token.startsWith('github_pat_')
  ) {
    return 'github';
  }
  return 'copilot';
}

function githubLoginBaseUrl(): string {
  return normalizeBaseUrl(
    process.env.FACTORY_GITHUB_LOGIN_BASE_URL ?? DEFAULT_GITHUB_LOGIN_BASE_URL,
  );
}

function githubApiBaseUrl(): string {
  return normalizeBaseUrl(process.env.FACTORY_GITHUB_API_BASE_URL ?? DEFAULT_GITHUB_API_BASE_URL);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(makeAbortError());
    };

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(makeAbortError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
