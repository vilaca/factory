/**
 * Tiny URL fetcher built on Node's native fetch.
 *
 * Used by the /web slash command to grab API docs / blog posts / error
 * pages and feed them into the next turn. No external deps.
 *
 * Behaviour:
 *   - Manual redirect handling, max 5 hops.
 *   - 15-second total timeout via AbortSignal.
 *   - 1 MB cap on response body — read in chunks and abort when exceeded.
 *   - User-Agent: factory/<version> (+https://github.com/vilaca/factory)
 */

import { getBuildInfo } from '../../utils/build-info.js';

interface FetchUrlResult {
  url: string;
  contentType: string;
  body: string;
  truncated: boolean;
}

interface FetchUrlOptions {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** Injectable for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

function userAgent(): string {
  const v = getBuildInfo().version;
  return `factory/${v} (+https://github.com/vilaca/factory)`;
}

async function readCappedBody(
  res: Response,
  maxBytes: number,
): Promise<{ body: Uint8Array; truncated: boolean }> {
  // Cheap pre-flight on Content-Length so a server that honestly advertises a
  // huge response is rejected before we allocate anything for it. Servers can
  // lie or omit the header; the streaming cap below still enforces the limit.
  const contentLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes * 8) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new Error(`response advertises ${contentLength} bytes (cap ${maxBytes})`);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    // No streaming body. We refuse rather than fall through to res.text(),
    // which would buffer the whole response into memory before any cap could
    // help — a Content-Length=0 server with a non-empty body, or a polyfilled
    // fetch, would OOM. Modern Node fetch always exposes a reader; tests
    // that mock Response should provide one.
    throw new Error('response has no streaming body — refusing to load uncapped');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) {
        chunks.push(value.slice(0, remaining));
        total += remaining;
      }
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return { body: merged, truncated };
}

function decodeBody(buf: Uint8Array, contentType: string): string {
  // Best-effort charset detection — UTF-8 is by far the common case; honour an
  // explicit charset= directive if the server provides one.
  const m = /charset\s*=\s*([^;]+)/i.exec(contentType);
  const enc = (m?.[1] ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(enc, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

export async function fetchUrl(url: string, opts: FetchUrlOptions = {}): Promise<FetchUrlResult> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetchFn = opts.fetchImpl ?? fetch;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);

  try {
    let current = url;
    let redirects = 0;
    // Manual redirect loop so we can cap hops and surface the final URL.
    for (;;) {
      const res = await fetchFn(current, {
        method: 'GET',
        headers: {
          'User-Agent': userAgent(),
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
        redirect: 'manual',
        signal: ctrl.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) {
          throw new Error(`redirect ${res.status} without Location header`);
        }
        if (redirects >= maxRedirects) {
          throw new Error(`too many redirects (>${maxRedirects})`);
        }
        redirects += 1;
        current = new URL(loc, current).toString();
        // Drain any body before next hop.
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${current}`);
      }
      const contentType = res.headers.get('content-type') ?? '';
      const { body, truncated } = await readCappedBody(res, maxBytes);
      const text = decodeBody(body, contentType);
      return { url: current, contentType, body: text, truncated };
    }
  } finally {
    clearTimeout(timer);
  }
}

const CONVERTIBLE_TYPES = ['text/html', 'application/xhtml+xml'];
const PLAIN_TYPES = ['text/plain', 'text/markdown'];

export function isHtmlType(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return CONVERTIBLE_TYPES.some(c => t.includes(c));
}

export function isPlainTextType(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return PLAIN_TYPES.some(c => t.includes(c));
}
