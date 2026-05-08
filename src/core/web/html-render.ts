/**
 * Token-stream renderer: walks tokens emitted by html-tokenize and writes
 * Markdown to a context buffer. The openTag/closeTag dispatchers are
 * intrinsically broad — every tag is a case — and the complexity disable
 * stays here on purpose: per-tag helpers would just shuffle the cases
 * across files without reducing dispatch breadth.
 */

import { decodeEntities, getAttr, type Token, type TagToken } from './html-tokenize.js';

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

// eslint-disable-next-line complexity -- Tag dispatch is intrinsically broad; per-tag helpers would just shuffle the cases around.
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

// eslint-disable-next-line complexity -- Tag dispatch is intrinsically broad; per-tag helpers would just shuffle the cases around.
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

export function processTokens(tokens: Token[]): string {
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
    const t = tok;
    if (!t.closing) {
      openTag(t, ctx, openStack);
    } else {
      closeTag(t, ctx, openStack);
    }
  }
  return ctx.out.join('');
}

export function tidy(s: string): string {
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
