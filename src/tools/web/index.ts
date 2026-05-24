import type { StandardToolHandler, ToolDefinition, ToolResult, ToolContext } from '../types.js';
import { TOOL_NAMES } from '../types.js';
import { fetchUrl, isHtmlType, isPlainTextType } from './fetch.js';
import { htmlToMarkdown } from './html-to-markdown.js';
import { errorMessage } from '../../utils/errors.js';

/** Hard cap on the post-conversion text the model receives. The fetcher
 *  itself caps the raw body at 1 MiB; this cap protects the model's context
 *  from a ~1 MB markdown blob even when fetch succeeded. */
const MODEL_OUTPUT_CAP = 16 * 1024;

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAMES.WebFetch,
    description:
      'Fetch a URL and return its content as text. HTML is stripped of boilerplate (nav, scripts, styles, footers) and converted to markdown for clean reading; plain text and markdown are returned as-is. Bounded: 1 MiB body cap, 15s timeout, 5 redirects max, 16 KiB cap on the returned text. The user is prompted before any fetch to a non-whitelisted domain. Redirects are re-validated against the same allowlist on every hop — a redirect to a host that is neither the originally-approved host nor explicitly whitelisted is refused.',
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: {
          type: 'string',
          description: 'Absolute http:// or https:// URL to fetch.',
        },
      },
    },
  },
};

async function execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const raw = typeof args.url === 'string' ? args.url.trim() : '';
  if (!raw) {
    return {
      success: false,
      output: 'WebFetch: "url" is required and must be a non-empty string.',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { success: false, output: `WebFetch: invalid URL "${raw}".` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      success: false,
      output: `WebFetch: unsupported protocol "${parsed.protocol}". Only http: and https: are allowed.`,
    };
  }

  // Re-apply the domain gate on every redirect target. The agent layer
  // already gated `raw`'s hostname (allowlist hit or user prompt), but
  // the manual-redirect loop in fetch.ts could otherwise be steered onto
  // an un-approved host — a server can chain `allowed → http://127.0.0.1`,
  // `allowed → http://169.254.169.254/`, or any other internal target.
  // The initial hostname is implicitly trusted because the agent already
  // approved it for this call.
  const initialHostname = parsed.hostname.toLowerCase();
  const isHostnameAllowed = ctx?.isHostnameAllowed;
  const validateHop = (u: URL): string | null => {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return `redirect to unsupported protocol "${u.protocol}"`;
    }
    const host = u.hostname.toLowerCase();
    if (host === initialHostname) return null;
    if (isHostnameAllowed?.(host)) return null;
    return `redirect to "${host}" blocked — host not in domain allowlist`;
  };

  let result;
  try {
    result = await fetchUrl(raw, { validateHop });
  } catch (err) {
    return { success: false, output: `WebFetch: ${errorMessage(err)}` };
  }

  let body: string;
  let mode: string;
  if (isHtmlType(result.contentType)) {
    body = htmlToMarkdown(result.body);
    mode = 'html→markdown';
  } else if (isPlainTextType(result.contentType)) {
    body = result.body;
    mode = 'plain text';
  } else {
    body = `[unsupported content-type: ${result.contentType || 'unknown'}; raw body follows]\n\n${result.body}`;
    mode = 'raw';
  }

  const truncatedTail = result.truncated
    ? '\n\n[note: response was truncated at the 1 MiB fetch cap]'
    : '';
  let final = body + truncatedTail;
  if (final.length > MODEL_OUTPUT_CAP) {
    const dropped = final.length - MODEL_OUTPUT_CAP;
    final =
      final.slice(0, MODEL_OUTPUT_CAP) +
      `\n... [truncated ${dropped} chars to fit the WebFetch output cap]`;
  }

  // Prefix the final URL on the first line so the model knows where this
  // came from when redirects rewrote the original. Many response bodies
  // start with markdown content that wouldn't otherwise carry that hint.
  const finalUrl = result.url !== raw ? ` (final URL after redirects: ${result.url})` : '';
  return {
    success: true,
    output: `Fetched ${raw}${finalUrl} — ${mode}\n\n${final}`,
  };
}

export const webFetchTool: StandardToolHandler = {
  name: TOOL_NAMES.WebFetch,
  description: definition.function.description,
  category: 'read-only',
  definition,
  execute,
};
