import type { TokenUsage } from '../types.js';

export function extractUsage(data: any): TokenUsage | undefined {
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
