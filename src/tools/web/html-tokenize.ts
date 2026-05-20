/**
 * HTML tokenizer + entity decoder + content-region picker.
 *
 * Splits the source string into a flat list of tag/text tokens and decodes
 * named and numeric HTML entities. Internal void/strip-tag sets stay
 * file-private; the renderer only consumes the exported `Token`/`TagToken`
 * types and the helper functions.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = parseInt(body.slice(2), 16);
      if (Number.isFinite(cp)) {
        try {
          return String.fromCodePoint(cp);
        } catch {
          return m;
        }
      }
      return m;
    }
    if (body.startsWith('#')) {
      const cp = parseInt(body.slice(1), 10);
      if (Number.isFinite(cp)) {
        try {
          return String.fromCodePoint(cp);
        } catch {
          return m;
        }
      }
      return m;
    }
    const v = NAMED_ENTITIES[body];
    return v ?? m;
  });
}

const STRIP_TAGS = new Set([
  'script',
  'style',
  'nav',
  'footer',
  'header',
  'aside',
  'form',
  'svg',
  'iframe',
]);

const VOID_TAGS = new Set([
  'br',
  'hr',
  'img',
  'input',
  'meta',
  'link',
  'area',
  'base',
  'col',
  'embed',
  'param',
  'source',
  'track',
  'wbr',
]);

// Apply a replacement until the input is stable. Each pattern is looped
// independently so a single replace() cannot leave a residual that a
// neighbour splice reconstructs (e.g. `<<!-- -->!-- -->` → `<!-- -->`).
function replaceAllUntilStable(input: string, pattern: RegExp): string {
  let out = input;
  while (pattern.test(out)) {
    out = out.replace(pattern, '');
  }
  return out;
}

/** Remove <!-- comments -->, <!doctype>, <?xml?>, and CDATA. */
export function stripCommentsAndDoctype(html: string): string {
  let out = html;
  out = replaceAllUntilStable(out, /<!--[\s\S]*?-->/g);
  out = replaceAllUntilStable(out, /<!\[CDATA\[[\s\S]*?\]\]>/g);
  out = replaceAllUntilStable(out, /<\?[\s\S]*?\?>/g);
  out = replaceAllUntilStable(out, /<!doctype[^>]*>/gi);
  return out;
}

/** Drop <tag>...</tag> for any of STRIP_TAGS, including self-closing forms. */
export function stripUnwanted(html: string): string {
  let out = html;
  for (const tag of STRIP_TAGS) {
    // Pair: <tag ...>...</tag> (non-greedy, case-insensitive, dotall via [\s\S]).
    out = replaceAllUntilStable(out, new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'));
    // Self-closing or unmatched solo: <tag .../> or <tag>.
    out = replaceAllUntilStable(out, new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'));
  }
  return out;
}

/**
 * Pick the most content-y region: <main>, <article>, or <body>.
 * If none match, return the original string. Case-insensitive.
 */
export function pickContentRegion(html: string): string {
  for (const tag of ['main', 'article', 'body'] as const) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i');
    const m = html.match(re);
    if (m && m[1]) return m[1];
  }
  return html;
}

export interface TagToken {
  kind: 'tag';
  raw: string;
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: string;
}
interface TextToken {
  kind: 'text';
  text: string;
}
export type Token = TagToken | TextToken;

export function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)(\/?)>/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ kind: 'text', text: html.slice(lastIndex, m.index) });
    }
    const raw = m[0];
    const name = m[1]!.toLowerCase();
    const closing = raw.startsWith('</');
    const selfClosing = m[3] === '/' || VOID_TAGS.has(name);
    tokens.push({ kind: 'tag', raw, name, closing, selfClosing, attrs: m[2] ?? '' });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < html.length) {
    tokens.push({ kind: 'text', text: html.slice(lastIndex) });
  }
  return tokens;
}

export function getAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = attrs.match(re);
  if (!m) return undefined;
  return m[2] ?? m[3] ?? m[4];
}
