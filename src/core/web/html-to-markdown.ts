/**
 * Tiny vanilla HTML → Markdown converter.
 *
 * No external deps (no cheerio / jsdom). Walks the source string with a
 * minimal tag scanner and emits markdown. Readability beats fidelity —
 * this is meant to feed an LLM, not round-trip into a renderer.
 *
 * Pipeline: strip noise → pick content region → tokenize → render → tidy.
 * The phases live in sibling modules:
 *   - html-tokenize: scanner, entity decoder, content-region picker
 *   - html-render: per-tag dispatch + markdown emission
 *
 * Supported transforms:
 *   - Strips: script, style, nav, footer, header, aside, form, svg, iframe,
 *     and HTML comments.
 *   - Prefers content inside <main> or <article> if present, else <body>.
 *   - h1..h6 → #..######, p → blank-line-separated paragraphs,
 *     a[href] → [text](href), code → `…`, pre → fenced ``` block,
 *     ul/li → "- ", ol/li → "1.", strong/b → **…**, em/i → *…*,
 *     br → newline, table → simple pipe rows.
 *   - Decodes named (&amp; &lt; &gt; &quot; &apos; &nbsp;) and numeric
 *     (&#NN;, &#xNN;) HTML entities.
 *   - Collapses runs of >2 blank lines.
 */

import {
  pickContentRegion,
  stripCommentsAndDoctype,
  stripUnwanted,
  tokenize,
} from './html-tokenize.js';
import { processTokens, tidy } from './html-render.js';

export { decodeEntities } from './html-tokenize.js';

export function htmlToMarkdown(html: string): string {
  const cleaned = stripUnwanted(stripCommentsAndDoctype(html));
  const region = pickContentRegion(cleaned);
  const tokens = tokenize(region);
  const md = processTokens(tokens);
  return tidy(md);
}
