/**
 * Provider error helper.
 *
 * Every OpenAI-compatible provider hand-rolls
 *   throw new Error(`${name} API error ${status}: ${body}`)
 * which buries the HTTP status inside the message string. The retry classifier
 * in `call-model/provider-retry.ts` reads `.status` / `.statusCode` off the
 * error object — when neither is set, *every* OpenAI failure (5xx, 429, 408)
 * falls through to the network-regex bucket, which never matches a number, so
 * the call is treated as non-retryable. The session log we debugged on
 * 2026-05-10 shows exactly this pathology: an SSE-channel `response.error`
 * with body "Internal server error" terminated the turn instead of retrying.
 *
 * `apiError` keeps the human-readable message identical (so existing test
 * matchers still pass) but also attaches `.status` so `classifyForRetry`'s
 * 408/429/5xx buckets actually fire. The shape is OpenAI's API error policy
 * (https://developers.openai.com/api/docs/guides/error-codes.md): retry
 * transient categories (408, 429, 5xx, network), do not same-key retry
 * auth/permission failures (401/403); those should rotate or surface.
 */

export interface ApiError extends Error {
  status: number;
  /** Server-requested wait (ms) for throttling responses (429/503). */
  retryAfterMs?: number;
}

function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;

  const retryAfterMsRaw = headers.get('retry-after-ms');
  if (retryAfterMsRaw) {
    const ms = Number.parseFloat(retryAfterMsRaw);
    if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms);
  }

  const retryAfterRaw = headers.get('retry-after');
  if (!retryAfterRaw) return undefined;

  const seconds = Number.parseFloat(retryAfterRaw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000);
  }

  const at = Date.parse(retryAfterRaw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

export function apiError(
  providerName: string,
  status: number,
  body: string,
  headers?: Headers,
): ApiError {
  const err = new Error(`${providerName} API error ${status}: ${body}`) as ApiError;
  err.status = status;
  const retryAfterMs = parseRetryAfterMs(headers);
  if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
  return err;
}
