import { GraniteError } from '../errors.ts';

/**
 * Token kinds produced by the lexer.
 * - `word`: a bare word; keywords are recognized by the parser through `upper`.
 * - `quoted`: a double-quoted identifier, case preserved.
 * - `comment` and `error` appear only in lenient mode (used for highlighting).
 */
export type TokenKind =
  'word' | 'quoted' | 'number' | 'string' | 'param' | 'symbol' | 'comment' | 'error' | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /** Exact source text of the token. */
  readonly text: string;
  /** Start and end offsets (UTF-16 units) into the source. */
  readonly start: number;
  readonly end: number;
  /**
   * Normalized value: upper-case for words, the identifier for quoted names,
   * the unescaped NFC content for strings, the text for numbers and symbols.
   */
  readonly value: string;
}

/** Every keyword the parser knows; used by highlighters and for error hints. */
export const KEYWORDS: ReadonlySet<string> = new Set([
  'ALL',
  'ANALYZE',
  'AND',
  'AS',
  'ASC',
  'BEGIN',
  'BETWEEN',
  'BY',
  'CASE',
  'CAST',
  'COMMIT',
  'CREATE',
  'CROSS',
  'DEFAULT',
  'DELETE',
  'DESC',
  'DISTINCT',
  'DROP',
  'ELSE',
  'END',
  'EXISTS',
  'EXPLAIN',
  'FALSE',
  'FIRST',
  'FROM',
  'GROUP',
  'HAVING',
  'IF',
  'IN',
  'INDEX',
  'INNER',
  'INSERT',
  'INTO',
  'IS',
  'JOIN',
  'KEY',
  'LAST',
  'LEFT',
  'LIKE',
  'LIMIT',
  'NOT',
  'NULL',
  'NULLS',
  'OFFSET',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'PRIMARY',
  'ROLLBACK',
  'SELECT',
  'SET',
  'TABLE',
  'THEN',
  'TRANSACTION',
  'TRUE',
  'UNIQUE',
  'UPDATE',
  'VACUUM',
  'VALUES',
  'WHEN',
  'WHERE',
]);

/** Words that can never be used as bare identifiers. */
export const RESERVED: ReadonlySet<string> = new Set([
  'ALL',
  'AND',
  'AS',
  'ASC',
  'BETWEEN',
  'BY',
  'CASE',
  'CAST',
  'CREATE',
  'CROSS',
  'DEFAULT',
  'DELETE',
  'DESC',
  'DISTINCT',
  'DROP',
  'ELSE',
  'END',
  'EXISTS',
  'FALSE',
  'FROM',
  'GROUP',
  'HAVING',
  'IN',
  'INNER',
  'INSERT',
  'INTO',
  'IS',
  'JOIN',
  'LEFT',
  'LIKE',
  'LIMIT',
  'NOT',
  'NULL',
  'OFFSET',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'PRIMARY',
  'SELECT',
  'SET',
  'THEN',
  'TRUE',
  'UNIQUE',
  'UPDATE',
  'VALUES',
  'WHEN',
  'WHERE',
]);

/** Names of the column types, highlighted as types. */
export const TYPE_NAMES: ReadonlySet<string> = new Set([
  'INTEGER',
  'INT',
  'BIGINT',
  'SMALLINT',
  'REAL',
  'FLOAT',
  'DOUBLE',
  'NUMERIC',
  'TEXT',
  'VARCHAR',
  'CHAR',
  'BOOLEAN',
  'BOOL',
]);

const SYMBOLS_2 = new Set(['<=', '>=', '<>', '!=', '||', '==']);
const SYMBOLS_1 = new Set(['(', ')', ',', ';', '.', '*', '+', '-', '/', '%', '=', '<', '>']);

const WORD_START = /[\p{L}_]/u;
const WORD_PART = /[\p{L}\p{M}\p{N}_$]/u;

export interface TokenizeOptions {
  /**
   * Never throw: emit `comment` tokens and turn bad input into `error` tokens.
   * Meant for syntax highlighting of half-typed SQL.
   */
  lenient?: boolean;
}

/** Split SQL text into tokens. The last token is always `eof`. */
export function tokenize(source: string, options: TokenizeOptions = {}): Token[] {
  const lenient = options.lenient === true;
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;

  const push = (kind: TokenKind, start: number, end: number, value?: string): void => {
    const text = source.slice(start, end);
    tokens.push({ kind, text, start, end, value: value ?? text });
  };
  const fail = (message: string, start: number, end: number): never => {
    throw new GraniteError('syntax_error', message, { span: { start, end } }).locate(source);
  };

  while (i < n) {
    const c = source[i]!;
    const code = source.charCodeAt(i);

    // Whitespace.
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      i++;
      continue;
    }

    // Comments.
    if (c === '-' && source[i + 1] === '-') {
      const start = i;
      while (i < n && source[i] !== '\n') i++;
      if (lenient) push('comment', start, i);
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const start = i;
      const close = source.indexOf('*/', i + 2);
      if (close === -1) {
        if (!lenient) fail('unterminated block comment', start, start + 2);
        push('comment', start, n);
        i = n;
        continue;
      }
      i = close + 2;
      if (lenient) push('comment', start, i);
      continue;
    }

    // Numbers: 12, 1.5, .5, 1e9, 2.5E-3.
    if ((code >= 48 && code <= 57) || (c === '.' && isDigit(source.charCodeAt(i + 1)))) {
      const start = i;
      while (i < n && isDigit(source.charCodeAt(i))) i++;
      if (source[i] === '.' && source[i + 1] !== '.') {
        i++;
        while (i < n && isDigit(source.charCodeAt(i))) i++;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        let j = i + 1;
        if (source[j] === '+' || source[j] === '-') j++;
        if (isDigit(source.charCodeAt(j))) {
          i = j;
          while (i < n && isDigit(source.charCodeAt(i))) i++;
        }
      }
      if (i < n && WORD_PART.test(source[i]!)) {
        let end = i;
        while (end < n && WORD_PART.test(source[end]!)) end++;
        if (!lenient) fail(`invalid number "${source.slice(start, end)}"`, start, end);
        push('error', start, end);
        i = end;
        continue;
      }
      push('number', start, i);
      continue;
    }

    // String literals with '' as the escaped quote.
    if (c === "'") {
      const start = i;
      let value = '';
      i++;
      let closed = false;
      while (i < n) {
        const ch = source[i]!;
        if (ch === "'") {
          if (source[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += ch;
        i++;
      }
      if (!closed) {
        if (!lenient) fail('unterminated string literal', start, start + 1);
        push('error', start, n);
        continue;
      }
      push('string', start, i, value.normalize('NFC'));
      continue;
    }

    // Quoted identifiers with "" as the escaped quote.
    if (c === '"') {
      const start = i;
      let value = '';
      i++;
      let closed = false;
      while (i < n) {
        const ch = source[i]!;
        if (ch === '"') {
          if (source[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += ch;
        i++;
      }
      if (!closed) {
        if (!lenient) fail('unterminated quoted identifier', start, start + 1);
        push('error', start, n);
        continue;
      }
      if (value.length === 0 && !lenient) fail('empty quoted identifier', start, i);
      push('quoted', start, i, value.normalize('NFC'));
      continue;
    }

    // Parameters: ? or $1.
    if (c === '?') {
      push('param', i, i + 1, '?');
      i++;
      continue;
    }
    if (c === '$' && isDigit(source.charCodeAt(i + 1))) {
      const start = i;
      i++;
      while (i < n && isDigit(source.charCodeAt(i))) i++;
      push('param', start, i);
      continue;
    }

    // Words: keywords and identifiers.
    const cp = source.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (WORD_START.test(ch)) {
      const start = i;
      i += ch.length;
      while (i < n) {
        const next = String.fromCodePoint(source.codePointAt(i)!);
        if (!WORD_PART.test(next)) break;
        i += next.length;
      }
      const text = source.slice(start, i);
      push('word', start, i, text.normalize('NFC').toUpperCase());
      continue;
    }

    // Operators and punctuation.
    const two = source.slice(i, i + 2);
    if (SYMBOLS_2.has(two)) {
      push('symbol', i, i + 2, two === '!=' ? '<>' : two === '==' ? '=' : two);
      i += 2;
      continue;
    }
    if (SYMBOLS_1.has(c)) {
      push('symbol', i, i + 1);
      i++;
      continue;
    }

    if (!lenient) fail(`unexpected character ${JSON.stringify(ch)}`, i, i + ch.length);
    push('error', i, i + ch.length);
    i += ch.length;
  }

  tokens.push({ kind: 'eof', text: '', start: n, end: n, value: '' });
  return tokens;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** Identifier name of a word token: unquoted names are case-insensitive (lower-cased). */
export function identifierOf(token: Token): string {
  return token.kind === 'quoted' ? token.value : token.text.normalize('NFC').toLowerCase();
}
