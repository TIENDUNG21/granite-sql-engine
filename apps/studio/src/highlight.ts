import { KEYWORDS, TYPE_NAMES, tokenize, type Token } from '@granite/core';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

export type TokenClass = 'kw' | 'type' | 'fn' | 'str' | 'num' | 'cmt' | 'param' | 'err';

/** CSS class for a token; `next` is the following significant token. */
export function classify(token: Token, next: Token | undefined): TokenClass | undefined {
  switch (token.kind) {
    case 'word':
      if (TYPE_NAMES.has(token.value)) return 'type';
      if (KEYWORDS.has(token.value)) return 'kw';
      return next?.kind === 'symbol' && next.value === '(' ? 'fn' : undefined;
    case 'string':
      return 'str';
    case 'number':
      return 'num';
    case 'comment':
      return 'cmt';
    case 'param':
      return 'param';
    case 'error':
      return 'err';
    default:
      return undefined;
  }
}

/**
 * SQL as HTML with one span per highlighted token. Uses the engine's own lexer
 * in lenient mode, so half-typed input never throws and the colors agree with
 * what the parser will see. The text content equals the input exactly.
 */
export function highlightSql(sql: string): string {
  const tokens = tokenize(sql, { lenient: true }).filter((t) => t.kind !== 'eof');
  const significant = tokens.filter((t) => t.kind !== 'comment');
  const nextOf = new Map<Token, Token | undefined>(
    significant.map((t, i) => [t, significant[i + 1]]),
  );
  let html = '';
  let pos = 0;
  for (const token of tokens) {
    html += escapeHtml(sql.slice(pos, token.start));
    const cls = classify(token, nextOf.get(token));
    const text = escapeHtml(sql.slice(token.start, token.end));
    html += cls ? `<span class="t-${cls}">${text}</span>` : text;
    pos = token.end;
  }
  return html + escapeHtml(sql.slice(pos));
}
