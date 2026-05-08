/**
 * Tiny vanilla HTML → Markdown converter.
 *
 * No external deps (no cheerio / jsdom). Walks the source string with a
 * minimal tag scanner and emits markdown. Readability beats fidelity —
 * this is meant to feed an LLM, not round-trip into a renderer.
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

/** Remove <!-- comments -->, <!doctype>, <?xml?>, and CDATA. */
function stripCommentsAndDoctype(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!doctype[^>]*>/gi, '');
}

/** Drop <tag>...</tag> for any of STRIP_TAGS, including self-closing forms. */
function stripUnwanted(html: string): string {
  let out = html;
  for (const tag of STRIP_TAGS) {
    // Pair: <tag ...>...</tag> (non-greedy, case-insensitive, dotall via [\s\S]).
    const pair = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi');
    out = out.replace(pair, '');
    // Self-closing or unmatched solo: <tag .../> or <tag>.
    const solo = new RegExp(`<${tag}\\b[^>]*/?>`, 'gi');
    out = out.replace(solo, '');
  }
  return out;
}

/**
 * Pick the most content-y region: <main>, <article>, or <body>.
 * If none match, return the original string. Case-insensitive.
 */
function pickContentRegion(html: string): string {
  for (const tag of ['main', 'article', 'body'] as const) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i');
    const m = html.match(re);
    if (m && m[1]) return m[1];
  }
  return html;
}

interface TagToken {
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
type Token = TagToken | TextToken;

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)(\/?)>/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ kind: 'text', text: html.slice(lastIndex, m.index) });
    }
    const raw = m[0];
    const name = m[1].toLowerCase();
    const closing = raw.startsWith('</');
    const selfClosing = m[3] === '/' || VOID_TAGS.has(name);
    tokens.push({ kind: 'tag', raw, name, closing, selfClosing, attrs: m[2] });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < html.length) {
    tokens.push({ kind: 'text', text: html.slice(lastIndex) });
  }
  return tokens;
}

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

function getAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = attrs.match(re);
  if (!m) return undefined;
  return m[2] ?? m[3] ?? m[4];
}

interface Ctx {
  out: string[];
  inPre: boolean;
  listStack: { kind: 'ul' | 'ol'; index: number }[];
  /** Per-tag text-buffer stack — used so a tag's children render into a
   * temporary buffer, then we wrap the result. */
  bufStack: string[][];
}

function pushBuf(ctx: Ctx): void {
  ctx.bufStack.push([]);
}
function popBuf(ctx: Ctx): string {
  return (ctx.bufStack.pop() ?? []).join('');
}
function emit(ctx: Ctx, s: string): void {
  if (ctx.bufStack.length > 0) ctx.bufStack[ctx.bufStack.length - 1].push(s);
  else ctx.out.push(s);
}

function processTokens(tokens: Token[]): string {
  const ctx: Ctx = { out: [], inPre: false, listStack: [], bufStack: [] };
  // Tag-buffer stack: when we open a tag whose markdown depends on inner text,
  // we push a buffer. On the matching close we wrap and emit.
  const openStack: string[] = [];

  for (const tok of tokens) {
    if (tok.kind === 'text') {
      const decoded = decodeEntities(tok.text);
      if (ctx.inPre) {
        emit(ctx, decoded);
      } else {
        // Collapse internal whitespace runs to single spaces.
        emit(ctx, decoded.replace(/\s+/g, ' '));
      }
      continue;
    }
    const t = tok as TagToken;
    if (!t.closing) {
      openTag(t, ctx, openStack);
    } else {
      closeTag(t, ctx, openStack);
    }
  }
  return ctx.out.join('');
}

function openTag(t: TagToken, ctx: Ctx, openStack: string[]): void {
  const n = t.name;
  switch (n) {
    case 'br':
      emit(ctx, '\n');
      return;
    case 'hr':
      emit(ctx, '\n\n---\n\n');
      return;
    case 'p':
    case 'div':
    case 'section':
      emit(ctx, '\n\n');
      openStack.push(n);
      return;
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = parseInt(n[1], 10);
      emit(ctx, '\n\n' + '#'.repeat(level) + ' ');
      openStack.push(n);
      return;
    }
    case 'strong':
    case 'b':
      emit(ctx, '**');
      openStack.push(n);
      return;
    case 'em':
    case 'i':
      emit(ctx, '*');
      openStack.push(n);
      return;
    case 'code':
      if (!ctx.inPre) emit(ctx, '`');
      openStack.push(n);
      return;
    case 'pre':
      emit(ctx, '\n\n```\n');
      ctx.inPre = true;
      openStack.push(n);
      return;
    case 'ul':
      emit(ctx, '\n');
      ctx.listStack.push({ kind: 'ul', index: 0 });
      openStack.push(n);
      return;
    case 'ol':
      emit(ctx, '\n');
      ctx.listStack.push({ kind: 'ol', index: 0 });
      openStack.push(n);
      return;
    case 'li': {
      const top = ctx.listStack[ctx.listStack.length - 1];
      const indent = '  '.repeat(Math.max(0, ctx.listStack.length - 1));
      if (top && top.kind === 'ol') {
        top.index += 1;
        emit(ctx, '\n' + indent + `${top.index}. `);
      } else {
        emit(ctx, '\n' + indent + '- ');
      }
      openStack.push(n);
      return;
    }
    case 'a': {
      const href = getAttr(t.attrs, 'href') ?? '';
      // Buffer the link text so we can wrap on </a>.
      pushBuf(ctx);
      openStack.push(`a:${href}`);
      return;
    }
    case 'tr':
      emit(ctx, '\n| ');
      openStack.push(n);
      return;
    case 'td':
    case 'th':
      // Cells are separated by " | "; the tr opener already emitted "| ".
      openStack.push(n);
      return;
    case 'img': {
      const alt = getAttr(t.attrs, 'alt') ?? '';
      const src = getAttr(t.attrs, 'src') ?? '';
      if (src) emit(ctx, `![${alt}](${src})`);
      return;
    }
    case 'blockquote':
      emit(ctx, '\n\n> ');
      openStack.push(n);
      return;
    default:
      // Unknown tag — track it on the stack but don't emit anything.
      if (!t.selfClosing) openStack.push(n);
      return;
  }
}

function closeTag(t: TagToken, ctx: Ctx, openStack: string[]): void {
  const n = t.name;
  // Find the most recent matching opener on the stack and pop down to it.
  // Tolerate mismatched HTML by popping unknown openers we can't match.
  let idx = -1;
  for (let i = openStack.length - 1; i >= 0; i--) {
    const top = openStack[i];
    const topName = top.startsWith('a:') ? 'a' : top;
    if (topName === n) {
      idx = i;
      break;
    }
  }

  switch (n) {
    case 'p':
    case 'div':
    case 'section':
      emit(ctx, '\n\n');
      break;
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      emit(ctx, '\n\n');
      break;
    case 'strong':
    case 'b':
      emit(ctx, '**');
      break;
    case 'em':
    case 'i':
      emit(ctx, '*');
      break;
    case 'code':
      if (!ctx.inPre) emit(ctx, '`');
      break;
    case 'pre':
      ctx.inPre = false;
      emit(ctx, '\n```\n\n');
      break;
    case 'ul':
    case 'ol':
      ctx.listStack.pop();
      emit(ctx, '\n');
      break;
    case 'li':
      // Nothing to emit — next li or list close will handle structure.
      break;
    case 'a': {
      const text = popBuf(ctx);
      let href = '';
      if (idx >= 0) {
        const opener = openStack[idx];
        href = opener.startsWith('a:') ? opener.slice(2) : '';
      }
      if (href) emit(ctx, `[${text.trim()}](${href})`);
      else emit(ctx, text);
      break;
    }
    case 'tr':
      emit(ctx, ' |');
      break;
    case 'td':
    case 'th':
      emit(ctx, ' | ');
      break;
    case 'blockquote':
      emit(ctx, '\n\n');
      break;
  }
  if (idx >= 0) openStack.splice(idx, 1);
}

function tidy(s: string): string {
  // Decode any entities we missed (e.g. inside text that was wrapped by tags).
  // Tokens already decode text nodes — this catches anything reassembled.
  let out = s;
  // Trim trailing whitespace on each line (preserve in fenced code blocks
  // is non-trivial; keep it simple — readability beats fidelity).
  out = out
    .split('\n')
    .map(l => l.replace(/[ \t]+$/g, ''))
    .join('\n');
  // Collapse runs of >2 blank lines to exactly 2.
  out = out.replace(/\n{3,}/g, '\n\n');
  // Strip leading/trailing blank lines.
  out = out.replace(/^\s+|\s+$/g, '');
  return out;
}

export function htmlToMarkdown(html: string): string {
  const cleaned = stripUnwanted(stripCommentsAndDoctype(html));
  const region = pickContentRegion(cleaned);
  const tokens = tokenize(region);
  const md = processTokens(tokens);
  return tidy(md);
}
