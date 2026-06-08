import type {
  Provider,
  ChatMessage,
  ChatChunk,
  ToolDefinition,
  ProviderCapabilities,
  ChatOptions,
  ModelPickerInfo,
  ModelTier,
} from '../types.js';
import { CopilotAuthManager, inferCopilotCredentialKind } from './auth.js';
import {
  buildChatBody,
  buildResponsesBody,
  isResponsesApiOnly,
  sendOpenAiChat,
  sendOpenAiResponses,
  streamOpenAiChat,
  streamOpenAiResponses,
} from '../openai/index.js';
import { filterChatModels } from '../list-models-filter.js';
import { formatTokenCount, warnHardcodedEstimateFallback } from '../shared.js';

const PROVIDER_NAME = 'GitHub Copilot';
const FALLBACK_MODELS = ['gpt-4.1', 'gpt-4o', 'claude-sonnet-4', 'gemini-2.5-pro', 'o4-mini'];

interface CopilotModelEntry {
  id: string;
}

export class CopilotProvider implements Provider {
  name = 'copilot';
  private auth: CopilotAuthManager;

  constructor(options: { token?: string; githubToken?: string; host?: string } = {}) {
    const envToken = process.env.GITHUB_COPILOT_API_KEY ?? process.env.COPILOT_API_KEY;
    const provided = options.token ?? envToken;
    const kind = inferCopilotCredentialKind(provided);
    this.auth = new CopilotAuthManager({
      copilotToken: kind === 'copilot' ? provided : undefined,
      githubToken: options.githubToken ?? (kind === 'github' ? provided : undefined),
      host: options.host,
    });
  }

  async listModels(): Promise<string[]> {
    const session = await this.auth.getSession();
    const res = await fetch(`${session.apiBaseUrl}/models`, {
      headers: {
        ...this.auth.authHeaders(session.token),
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${PROVIDER_NAME} API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as unknown;
    const models = extractModelEntries(data);
    return models.length > 0 ? models.map(model => model.id) : [...FALLBACK_MODELS];
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const caps = this.getCapabilities(model);
    return {
      label: model,
      detail: `tools · max ${formatTokenCount(caps.maxOutputTokens)} out`,
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    const tier = estimateCopilotModelTier(lower);
    warnHardcodedEstimateFallback({
      provider: PROVIDER_NAME,
      model,
      fields: ['contextWindow', 'maxOutputTokens', 'modelTier'],
      reason: 'Copilot model API does not expose token limits or tier metadata',
    });
    return {
      contextWindow: estimateCopilotContextWindow(lower),
      maxOutputTokens: lower.includes('mini') || lower.includes('haiku') ? 8192 : 16384,
      toolSupport: 'native',
      parallelToolCalls: true,
      streaming: true,
      tokenCounting: 'exact',
      modelTier: tier,
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const session = await this.requireChatSession(options?.signal);
    if (isResponsesApiOnly(model)) {
      yield* streamOpenAiResponses({
        url: `${session.apiBaseUrl}/responses`,
        headers: this.auth.authHeaders(session.token),
        body: buildResponsesBody({
          model,
          messages,
          tools,
          stream: true,
          options: options ? { ...options, temperature: undefined } : undefined,
        }),
        signal: options?.signal,
        providerName: PROVIDER_NAME,
      });
      return;
    }
    yield* streamOpenAiChat({
      url: `${session.apiBaseUrl}/chat/completions`,
      headers: this.auth.authHeaders(session.token),
      body: buildChatBody({
        model,
        messages,
        tools,
        stream: true,
        options,
        maxTokensField: 'max_tokens',
        providerName: PROVIDER_NAME,
      }),
      signal: options?.signal,
      providerName: PROVIDER_NAME,
    });
  }

  async chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    const session = await this.requireChatSession(options?.signal);
    if (isResponsesApiOnly(model)) {
      return sendOpenAiResponses({
        url: `${session.apiBaseUrl}/responses`,
        headers: this.auth.authHeaders(session.token),
        body: buildResponsesBody({
          model,
          messages,
          tools,
          stream: false,
          options: options ? { ...options, temperature: undefined } : undefined,
        }),
        signal: options?.signal,
        providerName: PROVIDER_NAME,
      });
    }
    return sendOpenAiChat({
      url: `${session.apiBaseUrl}/chat/completions`,
      headers: this.auth.authHeaders(session.token),
      body: buildChatBody({
        model,
        messages,
        tools,
        stream: false,
        options,
        maxTokensField: 'max_tokens',
        providerName: PROVIDER_NAME,
      }),
      signal: options?.signal,
      providerName: PROVIDER_NAME,
    });
  }

  private async requireChatSession(signal?: AbortSignal) {
    const session = await this.auth.getSession(signal);
    if (!session.chatEnabled) {
      throw new Error('GitHub Copilot chat is not enabled for this account.');
    }
    return session;
  }
}

interface CopilotModelItem {
  id?: string;
  name?: string;
  model_picker_enabled?: boolean;
  capabilities?: { type?: string };
  policy?: { state?: string };
}

function extractModelEntries(data: unknown): CopilotModelEntry[] {
  const rawItems: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { data?: unknown[] }).data)
      ? (data as { data: unknown[] }).data
      : [];

  const idable: { id: string; raw: unknown }[] = [];
  for (const item of rawItems) {
    if (typeof item === 'string') {
      idable.push({ id: item, raw: item });
      continue;
    }
    if (item && typeof item === 'object') {
      const i = item as CopilotModelItem;
      const id = typeof i.id === 'string' ? i.id : typeof i.name === 'string' ? i.name : null;
      if (id) idable.push({ id, raw: item });
    }
  }

  const kept = filterChatModels('copilot', idable, ({ raw }) => {
    if (typeof raw !== 'object' || raw === null) return true;
    const i = raw as CopilotModelItem;
    if (i.model_picker_enabled === false) return 'non-chat: model_picker_enabled=false';
    if (i.capabilities?.type && i.capabilities.type !== 'chat')
      return `non-chat: capabilities.type='${i.capabilities.type}'`;
    if (i.policy?.state && i.policy.state !== 'enabled')
      return `non-chat: policy.state='${i.policy.state}'`;
    return true;
  });

  return [...new Set(kept.map(k => k.id))].map(id => ({ id }));
}

function estimateCopilotModelTier(model: string): ModelTier {
  if (
    model.includes('opus') ||
    model.includes('sonnet') ||
    model.includes('gpt-5') ||
    model.includes('gpt-4.1') ||
    model.includes('o3') ||
    model.includes('o4') ||
    model.includes('gemini-2.5-pro')
  ) {
    return 'strong';
  }
  return 'medium';
}

function estimateCopilotContextWindow(model: string): number {
  if (model.includes('claude')) return 200000;
  if (model.includes('gemini')) return 128000;
  if (model.includes('gpt') || model.includes('o3') || model.includes('o4')) return 128000;
  return 128000;
}
