/**
 * Error classification used by the rotation runtime. Provider SDKs surface
 * errors heterogeneously — sometimes a class with `.status`, sometimes a
 * plain Error whose message contains the HTTP status. We accept either.
 *
 * Returns 'other' when nothing rotatable matches; rotation is a no-op for
 * those (transport drops, model-shape errors, server crashes — retrying
 * with a different key won't help).
 */

type RotationReason = 'rate-limit' | 'auth' | 'other';

const RATE_RE = /(\b429\b|rate[ -]?limit|throttl|too many requests|insufficient[_ ]?quota|quota[_ ]?exceeded)/i;
const AUTH_RE = /(\b401\b|\b403\b|unauthorized|forbidden|invalid[ _-]?api[ _-]?key|invalid_api_key|authentication[_ -]error|api[_ -]?key[_ -]?expired)/i;

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; statusCode?: unknown };
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
  }
  return undefined;
}

function messageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err ?? '');
}

export function classifyForRotation(err: unknown): RotationReason {
  const status = statusOf(err);
  if (status === 429) return 'rate-limit';
  if (status === 401 || status === 403) return 'auth';
  const msg = messageOf(err);
  if (RATE_RE.test(msg)) return 'rate-limit';
  if (AUTH_RE.test(msg)) return 'auth';
  return 'other';
}
