import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

export type GoogleAiStudioAuthMode = 'api-key' | 'oauth';

type HeaderMap = Record<string, string>;

interface GoogleAuthClientLike {
  getRequestHeaders(url?: string): Promise<Headers | HeaderMap>;
}

interface GoogleAuthLike {
  getClient(): Promise<GoogleAuthClientLike>;
}

export interface GoogleAiStudioAuthOptions {
  apiKey?: string;
  authMode?: GoogleAiStudioAuthMode;
  auth?: GoogleAuthLike;
}

const GOOGLE_AI_STUDIO_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/generative-language.retriever',
];

export class GoogleAiStudioAuthManager {
  private readonly apiKey?: string;
  private readonly authMode: GoogleAiStudioAuthMode;
  private readonly auth?: GoogleAuthLike;

  constructor(options: GoogleAiStudioAuthOptions = {}) {
    this.apiKey = options.apiKey;
    this.authMode = options.authMode ?? (options.apiKey ? 'api-key' : 'oauth');
    this.auth = this.authMode === 'oauth'
      ? (options.auth ?? new GoogleAuth({ scopes: GOOGLE_AI_STUDIO_SCOPES }))
      : undefined;
  }

  mode(): GoogleAiStudioAuthMode {
    return this.authMode;
  }

  async validate(): Promise<void> {
    if (this.authMode === 'api-key') {
      if (!this.apiKey) {
        throw new Error('Google AI Studio API key required.');
      }
      return;
    }

    const headers = await this.getOAuthHeaders().catch(() => null);
    if (!headers?.Authorization && !headers?.authorization) {
      throw new Error(getGoogleAiStudioOAuthErrorMessage());
    }
  }

  async getChatHeaders(): Promise<HeaderMap> {
    if (this.authMode === 'api-key') {
      if (!this.apiKey) {
        throw new Error('Google AI Studio API key required.');
      }
      return { Authorization: `Bearer ${this.apiKey}` };
    }

    const headers = await this.getOAuthHeaders();
    if (!headers.Authorization && !headers.authorization) {
      throw new Error(getGoogleAiStudioOAuthErrorMessage());
    }
    return headers;
  }

  async getModelsHeaders(): Promise<HeaderMap> {
    if (this.authMode === 'api-key') {
      if (!this.apiKey) {
        throw new Error('Google AI Studio API key required.');
      }
      return { 'x-goog-api-key': this.apiKey };
    }

    const headers = await this.getOAuthHeaders();
    if (!headers.Authorization && !headers.authorization) {
      throw new Error(getGoogleAiStudioOAuthErrorMessage());
    }
    return headers;
  }

  private async getOAuthHeaders(): Promise<HeaderMap> {
    if (!this.auth) {
      throw new Error(getGoogleAiStudioOAuthErrorMessage());
    }

    try {
      const client = await this.auth.getClient();
      return normalizeHeaders(await client.getRequestHeaders());
    } catch (error: any) {
      throw new Error(`${getGoogleAiStudioOAuthErrorMessage()} ${error?.message ?? ''}`.trim());
    }
  }

  getDiagnostics(): Record<string, string | boolean> {
    return {
      authMode: this.authMode,
      hasApiKey: Boolean(this.apiKey),
      hasGeminiEnv: Boolean(process.env.GEMINI_API_KEY),
      hasGoogleApiEnv: Boolean(process.env.GOOGLE_API_KEY),
      hasGoogleApplicationCredentials: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS),
      hasAdcFile: hasAdcFile(),
    };
  }
}

function normalizeHeaders(headers: Headers | HeaderMap): HeaderMap {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (headers && typeof (headers as { entries?: unknown }).entries === 'function') {
    return Object.fromEntries((headers as { entries(): Iterable<[string, string]> }).entries());
  }
  return Object.fromEntries(
    Object.entries(headers).filter((entry) => typeof entry[1] === 'string') as Array<[string, string]>
  );
}

export function getGoogleAiStudioOAuthStorageNote(): string {
  return 'Google OAuth uses Application Default Credentials from GOOGLE_APPLICATION_CREDENTIALS or your gcloud ADC login.';
}

export function getGoogleAiStudioOAuthErrorMessage(): string {
  return 'Google AI Studio OAuth credentials not found. Run `gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/generative-language.retriever` or set GOOGLE_APPLICATION_CREDENTIALS to a credential JSON file.';
}

function hasAdcFile(): boolean {
  const home = process.env.HOME;
  if (!home) return false;
  try {
    return fs.existsSync(`${home}/.config/gcloud/application_default_credentials.json`);
  } catch {
    return false;
  }
}
