import type {
  Provider,
  ChatMessage,
  ChatChunk,
  ToolDefinition,
  ProviderCapabilities,
  ChatOptions,
  ModelInfo,
  ModelPickerInfo,
  ModelTier,
} from '../types.js';
import type { GoogleAiStudioAuthMode } from '../auth-modes.js';
import { appendProviderLog } from '../../utils/provider-log.js';
import { GoogleAiStudioAuthManager } from './auth.js';
import { buildChatBody, sendOpenAiChat, streamOpenAiChat } from '../openai/index.js';
import { filterChatModels } from '../list-models-filter.js';

const DEFAULT_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const PROVIDER_NAME = 'Google AI Studio';

interface GoogleAiStudioModel {
  name: string;
  baseModelId: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
}

export class GoogleAiStudioProvider implements Provider {
  name = 'googleaistudio';
  private readonly openAiBaseUrl: string;
  private readonly modelsBaseUrl: string;
  private readonly auth: GoogleAiStudioAuthManager;
  private modelsCache: GoogleAiStudioModel[] | null = null;

  constructor(options: { token?: string; host?: string; authMode?: GoogleAiStudioAuthMode } = {}) {
    const key = options.token ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    this.auth = new GoogleAiStudioAuthManager({
      apiKey: key,
      authMode: options.authMode,
    });
    this.openAiBaseUrl = (options.host ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
    this.modelsBaseUrl = this.openAiBaseUrl.replace(/\/openai\/?$/, '');
  }

  async listModels(): Promise<string[]> {
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'diagnostic',
      action: 'list-models',
      detail: `listing models via ${this.modelsBaseUrl}/models`,
    });
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'diagnostic',
      action: 'auth-diagnostics',
      detail: formatDiagnostics(this.auth.getDiagnostics()),
    });
    const models = await this.getCatalog();
    const ids = [...new Set(models.map(model => model.baseModelId))];
    appendProviderLog({
      provider: 'googleaistudio',
      category: 'diagnostic',
      action: 'usable-models',
      detail: `usable models after filtering: ${ids.length}`,
    });
    return ids;
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const match = this.modelsCache?.find(item => item.baseModelId === model);
    if (!match) {
      return { label: model };
    }

    return {
      label: isLegacyGoogleAiStudioModel(match.baseModelId) ? `${model} (legacy)` : model,
      detail: buildModelDetail(match),
      warning: buildModelWarning(match),
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    const cached = this.modelsCache?.find(item => item.baseModelId === model);

    return {
      contextWindow: cached?.inputTokenLimit ?? estimateGoogleAiStudioContextWindow(lower),
      maxOutputTokens: cached?.outputTokenLimit ?? estimateGoogleAiStudioMaxOutput(lower),
      toolSupport: 'native',
      parallelToolCalls: true,
      streaming: true,
      tokenCounting: 'exact',
      modelTier: estimateGoogleAiStudioModelTier(lower),
    };
  }

  async getModelInfo(model: string): Promise<ModelInfo> {
    const models = await this.getCatalog();
    const match = models.find(item => item.baseModelId === model);
    if (!match) {
      return { supportsTools: true };
    }

    const capabilities = [
      ...(match.supportedGenerationMethods ?? []),
      ...(match.thinking ? ['thinking'] : []),
    ];

    return {
      supportsTools: true,
      capabilities,
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const headers = await this.auth.getChatHeaders();
    yield* streamOpenAiChat({
      url: `${this.openAiBaseUrl}/chat/completions`,
      headers,
      body: this.body(model, messages, tools, true, options),
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
    const headers = await this.auth.getChatHeaders();
    return sendOpenAiChat({
      url: `${this.openAiBaseUrl}/chat/completions`,
      headers,
      body: this.body(model, messages, tools, false, options),
      signal: options?.signal,
      providerName: PROVIDER_NAME,
    });
  }

  private body(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    stream: boolean,
    options?: ChatOptions,
  ): Record<string, unknown> {
    return buildChatBody({
      model,
      messages,
      tools,
      stream,
      options,
      maxTokensField: 'max_tokens',
      extra: tools && tools.length > 0 ? { tool_choice: 'auto' } : undefined,
    });
  }

  private async getCatalog(): Promise<GoogleAiStudioModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const models: GoogleAiStudioModel[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${this.modelsBaseUrl}/models`);
      url.searchParams.set('pageSize', '1000');
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken);
      }

      const res = await fetch(url, {
        headers: {
          ...(await this.auth.getModelsHeaders()),
          Accept: 'application/json',
        },
      });

      appendProviderLog({
        provider: 'googleaistudio',
        category: 'diagnostic',
        action: 'models-status',
        detail: `${res.status} ${res.statusText}`,
      });

      if (!res.ok) {
        // TODO: Detect Gemini SERVICE_DISABLED / PERMISSION_DENIED responses here
        // and surface a clearer message with the activationUrl plus propagation delay hint.
        throw new Error(`${PROVIDER_NAME} API error ${res.status}: ${await res.text()}`);
      }

      const data = (await res.json()) as { models?: unknown[]; nextPageToken?: string };
      const pageModels: unknown[] = Array.isArray(data?.models) ? data.models : [];
      const idable: (GoogleAiStudioModelItem & { id: string })[] = [];
      for (const item of pageModels) {
        if (!item || typeof item !== 'object') continue;
        const i = item as GoogleAiStudioModelItem;
        const modelId = getGoogleAiStudioModelId(i);
        if (typeof i.name !== 'string' || !modelId) continue;
        idable.push({ ...i, id: modelId });
      }
      const supportedModels = filterChatModels(
        'googleaistudio',
        idable,
        chatCapabilityReason,
      );
      appendProviderLog({
        provider: 'googleaistudio',
        category: 'diagnostic',
        action: 'models-filtering',
        detail: `models.list returned ${pageModels.length} models; ${supportedModels.length} survived filtering`,
      });
      if (pageModels.length > 0 && supportedModels.length === 0) {
        appendProviderLog({
          provider: 'googleaistudio',
          category: 'diagnostic',
          action: 'sample-model-ids',
          detail: pageModels
            .slice(0, 10)
            .map(item => {
              const i = (item ?? {}) as GoogleAiStudioModelItem;
              return i.baseModelId ?? i.name ?? '<unknown>';
            })
            .join(', '),
        });
      }
      models.push(
        ...supportedModels.map(item => ({
          name: item.name!,
          baseModelId: getGoogleAiStudioModelId(item)!,
          displayName: typeof item.displayName === 'string' ? item.displayName : undefined,
          description: typeof item.description === 'string' ? item.description : undefined,
          inputTokenLimit:
            typeof item.inputTokenLimit === 'number' ? item.inputTokenLimit : undefined,
          outputTokenLimit:
            typeof item.outputTokenLimit === 'number' ? item.outputTokenLimit : undefined,
          supportedGenerationMethods: Array.isArray(item.supportedGenerationMethods)
            ? item.supportedGenerationMethods.filter(
                (value: unknown): value is string => typeof value === 'string',
              )
            : undefined,
          thinking: item.thinking === true,
        })),
      );

      pageToken =
        typeof data?.nextPageToken === 'string' && data.nextPageToken
          ? data.nextPageToken
          : undefined;
    } while (pageToken);

    this.modelsCache = dedupeModels(models);
    return this.modelsCache;
  }
}

interface GoogleAiStudioModelItem {
  name?: string;
  baseModelId?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: unknown[];
  thinking?: boolean;
}

function chatCapabilityReason(item: GoogleAiStudioModelItem & { id: string }): true | string {
  const methods = Array.isArray(item.supportedGenerationMethods)
    ? item.supportedGenerationMethods.filter(
        (value: unknown): value is string => typeof value === 'string',
      )
    : [];
  if (!methods.includes('generateContent')) return 'non-chat: lacks generateContent';

  const searchableId = `${item.name ?? ''} ${item.id} ${item.displayName ?? ''}`.toLowerCase();
  const familyMatch = /(embedding|imagen|veo|lyria|robotics)/i.exec(searchableId);
  if (familyMatch) return `non-chat: family '${familyMatch[1]}'`;
  const taskMatch = /(?:^|[\s/_:-])(tts|speech|music|image|video|live)(?:$|[\s/_:-])/i.exec(
    searchableId,
  );
  if (taskMatch) return `non-chat: task '${taskMatch[1]}'`;

  return true;
}

function getGoogleAiStudioModelId(item: GoogleAiStudioModelItem): string | null {
  if (typeof item.baseModelId === 'string' && item.baseModelId) {
    return item.baseModelId;
  }
  if (typeof item.name === 'string' && item.name.startsWith('models/')) {
    return item.name.slice('models/'.length);
  }
  return null;
}

function isLegacyGoogleAiStudioModel(modelId: string): boolean {
  return (
    modelId === 'gemini-2.0-flash' ||
    modelId === 'gemini-2.0-flash-001' ||
    modelId === 'gemini-2.0-flash-lite' ||
    modelId === 'gemini-2.0-flash-lite-001'
  );
}

function dedupeModels(models: GoogleAiStudioModel[]): GoogleAiStudioModel[] {
  const byId = new Map<string, GoogleAiStudioModel>();
  for (const model of models) {
    if (!byId.has(model.baseModelId)) {
      byId.set(model.baseModelId, model);
    }
  }
  return [...byId.values()];
}

function buildModelDetail(model: GoogleAiStudioModel): string {
  const lower = model.baseModelId.toLowerCase();
  const details = ['tools'];
  if (model.thinking) {
    details.push('reasoning');
  }
  const maxOutputTokens = model.outputTokenLimit ?? estimateGoogleAiStudioMaxOutput(lower);
  if (maxOutputTokens > 0) {
    details.push(`max ${formatTokenCount(maxOutputTokens)} out`);
  }
  const contextWindow = model.inputTokenLimit ?? estimateGoogleAiStudioContextWindow(lower);
  if (contextWindow > 0) {
    details.push(`${formatTokenCount(contextWindow)} ctx`);
  }
  return details.join(' · ');
}

function buildModelWarning(model: GoogleAiStudioModel): string | undefined {
  if (isLegacyGoogleAiStudioModel(model.baseModelId)) {
    return 'legacy - no longer available to new users';
  }
  const searchable = `${model.baseModelId} ${model.displayName ?? ''}`.toLowerCase();
  if (searchable.includes('experimental') || searchable.includes('-exp')) {
    return 'experimental';
  }
  if (searchable.includes('preview')) {
    return 'preview';
  }
  if (searchable.includes('deprecated')) {
    return 'deprecated';
  }
  return undefined;
}

function estimateGoogleAiStudioModelTier(model: string): ModelTier {
  if (model.includes('pro')) return 'strong';
  if (model.includes('flash-lite')) return 'weak';
  return 'medium';
}

function estimateGoogleAiStudioContextWindow(model: string): number {
  if (model.includes('flash') || model.includes('pro')) return 1_000_000;
  return 128000;
}

function estimateGoogleAiStudioMaxOutput(model: string): number {
  if (model.includes('pro')) return 65536;
  if (model.includes('flash-lite')) return 8192;
  return 65536;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    if (millions < 1.05) {
      return '1M';
    }
    return `${millions.toFixed(millions % 1 === 0 ? 0 : 1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands.toFixed(thousands % 1 === 0 ? 0 : 1).replace(/\.0$/, '')}k`;
  }
  return String(value);
}

function formatDiagnostics(values: Record<string, string | boolean>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
}
