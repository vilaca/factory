import type { TokenUsage } from '../types.js';

/** OpenAI-compatible usage envelope. Cached split is a relatively recent
 *  addition; older proxies emit only the three core counters. */
export interface OpenAiCompatUsageEnvelope {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

export function extractUsage(data: OpenAiCompatUsageEnvelope | undefined): TokenUsage | undefined {
  if (!data?.usage) return undefined;
  const cached = data.usage.prompt_tokens_details?.cached_tokens;
  const out: TokenUsage = {
    promptTokens: data.usage.prompt_tokens ?? 0,
    completionTokens: data.usage.completion_tokens ?? 0,
    totalTokens: data.usage.total_tokens ?? 0,
  };
  if (typeof cached === 'number') out.cachedPromptTokens = cached;
  return out;
}
