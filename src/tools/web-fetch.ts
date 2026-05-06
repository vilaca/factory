import type { ToolDefinition, ToolHandler, ToolResult, ToolContext } from './types.js';
import { fetchUrl, isHtmlType, isPlainTextType } from '../core/web/fetch.js';
import { htmlToMarkdown } from '../core/web/html-to-markdown.js';

/** Hard cap on the post-conversion text the model receives. The fetcher
 *  itself caps the raw body at 1 MiB; this cap protects the model's context
 *  from a ~1 MB markdown blob even when fetch succeeded. */
const MODEL_OUTPUT_CAP = 16 * 1024;

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'WebFetch',
    description:
      'Fetch a URL and return its content as text. HTML is stripped of boilerplate (nav, scripts, styles, footers) and converted to markdown for clean reading; plain text and markdown are returned as-is. Bounded: 1 MiB body cap, 15s timeout, 5 redirects max, 16 KiB cap on the returned text. The user is prompted before any fetch to a non-whitelisted domain.',
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

async function execute(args: Record<string, unknown>, _ctx?: ToolContext): Promise<ToolResult> {
  const raw = typeof args.url === 'string' ? args.url.trim() : '';
  if (!raw) {
    return { success: false, output: 'WebFetch: "url" is required and must be a non-empty string.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { success: false, output: `WebFetch: invalid URL "${raw}".` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { success: false, output: `WebFetch: unsupported protocol "${parsed.protocol}". Only http: and https: are allowed.` };
  }

  let result;
  try {
    result = await fetchUrl(raw);
  } catch (err) {
    return { success: false, output: `WebFetch: ${(err as Error).message}` };
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
    final = final.slice(0, MODEL_OUTPUT_CAP) + `\n... [truncated ${dropped} chars to fit the WebFetch output cap]`;
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

export const webFetchTool: ToolHandler = {
  name: 'WebFetch',
  description: definition.function.description,
  category: 'read-only',
  definition,
  execute,
};
