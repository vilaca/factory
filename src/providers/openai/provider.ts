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
import { buildChatBody, fetchOpenAiCatalog, sendOpenAiChat, streamOpenAiChat } from './index.js';
import { filterChatModels, matchedPattern } from '../list-models-filter.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const PROVIDER_NAME = 'OpenAI';
const MISSING_TOKEN_ERROR =
  'OpenAI API key required. Set OPENAI_API_KEY env var or use --token flag.';

interface OpenAiModel {
  id: string;
  owned_by?: string;
}

export class OpenAIProvider implements Provider {
  name = 'openai';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private modelsCache: OpenAiModel[] | null = null;

  constructor(options: { token?: string; host?: string } = {}) {
    const key = options.token ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error(MISSING_TOKEN_ERROR);
    this.apiKey = key;
    this.baseUrl = (options.host ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async listModels(): Promise<string[]> {
    const models = await this.getCatalog();
    return [...new Set(models.map(model => model.id))];
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const lower = model.toLowerCase();
    return {
      label: model,
      detail: buildModelDetail(lower),
      warning: buildModelWarning(lower),
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    return {
      contextWindow: estimateContextWindow(lower),
      maxOutputTokens: estimateMaxOutput(lower),
      toolSupport: supportsToolsByName(lower) ? 'native' : 'none',
      parallelToolCalls: supportsParallelToolCalls(lower),
      streaming: true,
      tokenCounting: 'exact',
      modelTier: estimateModelTier(lower),
    };
  }

  async getModelInfo(model: string): Promise<ModelInfo> {
    await this.getCatalog();
    const lower = model.toLowerCase();
    return {
      supportsTools: supportsToolsByName(lower),
      capabilities: buildCapabilities(lower),
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    yield* streamOpenAiChat({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.authHeaders(),
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
    return sendOpenAiChat({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.authHeaders(),
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
    const lower = model.toLowerCase();
    // Reasoning models (o1/o3/o4, gpt-5) reject `temperature` other than the
    // default — strip the field so callers' default of 0 doesn't 400 the call.
    const adjusted = isReasoningModel(lower)
      ? options
        ? { ...options, temperature: undefined }
        : undefined
      : options;
    return buildChatBody({
      model,
      messages,
      tools: supportsToolsByName(lower) ? tools : undefined,
      stream,
      options: adjusted,
      parallelToolCalls: supportsParallelToolCalls(lower),
    });
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async getCatalog(): Promise<OpenAiModel[]> {
    if (this.modelsCache) return this.modelsCache;

    const items = await fetchOpenAiCatalog({
      url: `${this.baseUrl}/models`,
      headers: this.authHeaders(),
      providerName: PROVIDER_NAME,
    });

    interface CatalogItem {
      id?: string;
      owned_by?: string;
    }
    const valid = items.filter(
      (item: unknown): item is CatalogItem & { id: string } =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as CatalogItem).id === 'string' &&
        !!(item as CatalogItem).id,
    );
    const allIds = new Set(valid.map(item => item.id));
    this.modelsCache = filterChatModels('openai', valid, item => {
      const matched = matchedPattern(item.id, NON_CHAT_PATTERNS);
      if (matched) return `non-chat: matches '${matched}'`;
      const aliasBase = stripDateSuffix(item.id);
      if (aliasBase && allIds.has(aliasBase)) return `alias of '${aliasBase}'`;
      return true;
    }).map(item => ({
      id: item.id,
      owned_by: typeof item.owned_by === 'string' ? item.owned_by : undefined,
    }));

    return this.modelsCache;
  }
}

/** Returns the alias base when `id` looks like a dated pin
 * (`o3-mini-2025-01-31` → `o3-mini`, `gpt-4-0613` → `gpt-4`). Caller decides
 * whether the base actually exists in the catalog before treating it as a dup. */
function stripDateSuffix(id: string): string | null {
  const ymd = /^(.+)-\d{4}-\d{2}-\d{2}$/.exec(id);
  if (ymd?.[1]) return ymd[1];
  const mmdd = /^(.+)-\d{4}$/.exec(id);
  if (mmdd?.[1]) return mmdd[1];
  return null;
}

// ─── Catalog filter ────────────────────────────────────────────────────

const NON_CHAT_PATTERNS = [
  'whisper',
  'tts',
  'embedding',
  'dall-e',
  'moderation',
  'davinci',
  'babbage',
  'realtime',
  'audio',
  'image',
  'transcribe',
  'search',
  'computer-use',
] as const;

// ─── Picker / capability helpers ───────────────────────────────────────

function buildModelDetail(modelId: string): string {
  const details: string[] = [];
  details.push('paid');
  details.push(supportsVisionByName(modelId) ? 'vision' : 'text-only');
  details.push(supportsToolsByName(modelId) ? 'tools' : 'no tools');
  if (isReasoningModel(modelId)) details.push('reasoning');
  details.push(`max ${formatTokenCount(estimateMaxOutput(modelId))} out`);
  details.push(`${formatTokenCount(estimateContextWindow(modelId))} ctx`);
  return details.join(' · ');
}

function buildModelWarning(modelId: string): string | undefined {
  if (modelId.includes('preview')) return 'preview';
  if (lookupFamily(modelId)?.deprecated) return 'deprecated';
  return undefined;
}

function buildCapabilities(model: string): string[] {
  const capabilities: string[] = [];
  capabilities.push(supportsVisionByName(model) ? 'vision' : 'text');
  if (supportsToolsByName(model)) capabilities.push('tool-use');
  if (isReasoningModel(model)) capabilities.push('reasoning');
  if (supportsParallelToolCalls(model)) capabilities.push('parallel-tools');
  return capabilities;
}

/**
 * Single source of truth for OpenAI per-family capability metadata.
 *
 * `/v1/models` ships only `{id, created, object, owned_by}` — no context
 * size, max output, modality, reasoning flag, or deprecation status. Every
 * one of those has to be inferred from the model id, so we keep them all
 * in one table instead of scattering startsWith chains across six functions.
 *
 * Lookup uses longest-matching prefix (so `gpt-4o-mini` beats `gpt-4o`),
 * which makes array order irrelevant — keep the rows grouped by family for
 * readability. Add a row when a new family ships; tweak existing rows when
 * a family is retired (set `deprecated: true`) or extended.
 *
 * Defaults when no row matches: ctx 128k, maxOut 16k, no reasoning, no
 * vision, supportsTools true, tier from generic mini/nano heuristic. New
 * unknown ids therefore land in the middle of `strong` tier — visible but
 * not at the top — until someone adds a row.
 */
interface OpenAIFamily {
  prefix: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** Override for the generic tier heuristic. */
  tier?: ModelTier;
  reasoning?: boolean;
  vision?: boolean;
  /** Defaults to true. Set false for models that are tool-disabled. */
  supportsTools?: boolean;
  /** Drives both the picker 'deprecated' warning and tier='weak'. */
  deprecated?: boolean;
}

const OPENAI_FAMILIES: ReadonlyArray<OpenAIFamily> = [
  // Current flagships
  { prefix: 'gpt-5-codex', contextWindow: 1_047_576, maxOutputTokens: 128_000, tier: 'strong', reasoning: true,  vision: true },
  { prefix: 'gpt-5',       contextWindow: 1_047_576, maxOutputTokens: 128_000, tier: 'strong', reasoning: true,  vision: true },
  { prefix: 'gpt-4.1',     contextWindow: 1_047_576, maxOutputTokens:  32_768, tier: 'strong', vision: true },

  // Reasoning series
  { prefix: 'o4-mini',     contextWindow: 200_000, maxOutputTokens: 100_000, tier: 'medium', reasoning: true, vision: true },
  { prefix: 'o4',          contextWindow: 200_000, maxOutputTokens: 100_000, tier: 'strong', reasoning: true, vision: true },
  { prefix: 'o3-mini',     contextWindow: 200_000, maxOutputTokens: 100_000, tier: 'medium', reasoning: true, vision: true },
  { prefix: 'o3',          contextWindow: 200_000, maxOutputTokens: 100_000, tier: 'strong', reasoning: true, vision: true },
  { prefix: 'o1-pro',      contextWindow: 200_000, maxOutputTokens: 100_000, tier: 'strong', reasoning: true, vision: true },
  { prefix: 'o1-preview',  contextWindow: 128_000, maxOutputTokens: 100_000, tier: 'strong', reasoning: true, vision: true, supportsTools: false },
  { prefix: 'o1-mini',     contextWindow: 128_000, maxOutputTokens: 100_000, tier: 'medium', reasoning: true, vision: true, supportsTools: false },
  { prefix: 'o1',          contextWindow: 128_000, maxOutputTokens: 100_000, tier: 'strong', reasoning: true, vision: true },

  // Multimodal flagship line
  { prefix: 'gpt-4o-mini', contextWindow: 128_000, maxOutputTokens: 16_384, tier: 'medium', vision: true },
  { prefix: 'gpt-4o',      contextWindow: 128_000, maxOutputTokens: 16_384, tier: 'strong', vision: true },

  // Deprecated families — surface a warning and pin to weak tier
  { prefix: 'gpt-4-turbo',           contextWindow: 128_000, maxOutputTokens: 4_096, deprecated: true },
  { prefix: 'gpt-4-1106',            contextWindow: 128_000, maxOutputTokens: 4_096, deprecated: true },
  { prefix: 'gpt-4-',                contextWindow: 128_000, maxOutputTokens: 4_096, deprecated: true },
  { prefix: 'gpt-3.5-turbo-instruct', contextWindow: 16_385, maxOutputTokens: 4_096, deprecated: true, supportsTools: false },
  { prefix: 'gpt-3.5-turbo',         contextWindow:  16_385, maxOutputTokens: 4_096, deprecated: true },
];

function lookupFamily(model: string): OpenAIFamily | undefined {
  const lower = model.toLowerCase();
  let best: OpenAIFamily | undefined;
  for (const family of OPENAI_FAMILIES) {
    if (lower.startsWith(family.prefix) && (!best || family.prefix.length > best.prefix.length)) {
      best = family;
    }
  }
  return best;
}

function estimateModelTier(model: string): ModelTier {
  const family = lookupFamily(model);
  if (family?.deprecated) return 'weak';
  const baseTier: ModelTier = family?.tier ?? 'strong';
  // A family row encodes the *default* tier for that family; mini/nano
  // variants of a strong family are still smaller models. Apply the
  // generic demotion on top of `strong` rows so e.g. `gpt-5.1-codex-mini`
  // (which matches the `gpt-5` row) lands in `medium`. Explicit `medium`
  // or `weak` rows already account for being a mini and aren't demoted
  // again.
  if (baseTier === 'strong' && /(?:^|[-/])(?:mini|nano)\b/.test(model)) return 'medium';
  return baseTier;
}

function estimateContextWindow(model: string): number {
  return lookupFamily(model)?.contextWindow ?? 128_000;
}

function estimateMaxOutput(model: string): number {
  return lookupFamily(model)?.maxOutputTokens ?? 16_384;
}

function isReasoningModel(model: string): boolean {
  return lookupFamily(model)?.reasoning ?? false;
}

function supportsToolsByName(model: string): boolean {
  return lookupFamily(model)?.supportsTools ?? true;
}

function supportsParallelToolCalls(model: string): boolean {
  if (!supportsToolsByName(model)) return false;
  // o-series reasoning models don't support parallel tool calls.
  if (isReasoningModel(model)) return false;
  return true;
}

function supportsVisionByName(model: string): boolean {
  return lookupFamily(model)?.vision ?? false;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions.toFixed(millions % 1 === 0 ? 0 : 1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands.toFixed(thousands % 1 === 0 ? 0 : 1).replace(/\.0$/, '')}k`;
  }
  return String(value);
}
