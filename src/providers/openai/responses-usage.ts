import type { TokenUsage } from '../types.js';

/** Responses-API usage envelope. Different field names than chat-completions
 *  (`input_tokens` vs `prompt_tokens`, `output_tokens` vs `completion_tokens`)
 *  and a separate `output_tokens_details.reasoning_tokens` breakdown the
 *  chat-completions endpoint doesn't surface. */
export interface ResponsesUsageEnvelope {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
  } | null;
}

export function extractResponsesUsage(
  envelope: ResponsesUsageEnvelope | undefined,
): TokenUsage | undefined {
  if (!envelope?.usage) return undefined;
  const cached = envelope.usage.input_tokens_details?.cached_tokens;
  const reasoning = envelope.usage.output_tokens_details?.reasoning_tokens;
  const out: TokenUsage = {
    promptTokens: envelope.usage.input_tokens ?? 0,
    completionTokens: envelope.usage.output_tokens ?? 0,
    totalTokens: envelope.usage.total_tokens ?? 0,
  };
  if (typeof cached === 'number') out.cachedPromptTokens = cached;
  if (typeof reasoning === 'number') out.reasoningTokens = reasoning;
  return out;
}
