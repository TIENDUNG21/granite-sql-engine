import { describe, expect, it } from 'vitest';
import { GraniteError } from '../src/errors.ts';
import { identifierOf, tokenize } from '../src/sql/lexer.ts';

const kinds = (sql: string) => tokenize(sql).map((t) => `${t.kind}:${t.value}`);

function lexError(sql: string): GraniteError {
  try {
    tokenize(sql);
  } catch (err) {
    if (err instanceof GraniteError) return err;
    throw err;
  }
  throw new Error(`expected a lexer error for ${sql}`);
}

describe('tokenize', () => {
  it('splits a simple query', () => {
    expect(kinds('SELECT a, b FROM t;')).toEqual([
      'word:SELECT',
      'word:A',
      'symbol:,',
      'word:B',
      'word:FROM',
      'word:T',
      'symbol:;',
      'eof:',
    ]);
  });

  it('records offsets for every token', () => {
    const tokens = tokenize('SELECT  x');
    expect(tokens[1]).toMatchObject({ text: 'x', start: 8, end: 9 });
    expect(tokens.at(-1)).toMatchObject({ kind: 'eof', start: 9, end: 9 });
  });

  it('reads numbers in all their shapes', () => {
    expect(kinds('1 1.5 .5 1e9 2.5E-3 7.')).toEqual([
      'number:1',
      'number:1.5',
      'number:.5',
      'number:1e9',
      'number:2.5E-3',
      'number:7.',
      'eof:',
    ]);
  });

  it('unescapes doubled quotes in strings and identifiers', () => {
    const [str, ident] = tokenize(`'it''s' "say ""hi"""`);
    expect(str).toMatchObject({ kind: 'string', value: "it's" });
    expect(ident).toMatchObject({ kind: 'quoted', value: 'say "hi"' });
  });

  it('normalizes string literals to NFC', () => {
    const nfd = "'Việt'";
    const nfc = "'Việt'";
    expect(tokenize(nfd)[0]!.value).toBe(tokenize(nfc)[0]!.value);
    expect(tokenize(nfd)[0]!.value).toBe('Việt');
  });

  it('keeps astral characters intact in strings', () => {
    expect(tokenize("'\u{1F600}\u{20000}'")[0]!.value).toBe('\u{1F600}\u{20000}');
  });

  it('skips comments', () => {
    expect(kinds('SELECT -- note\n 1 /* block\n comment */ + 2')).toEqual([
      'word:SELECT',
      'number:1',
      'symbol:+',
      'number:2',
      'eof:',
    ]);
  });

  it('reads two-character operators and canonicalizes synonyms', () => {
    expect(kinds('a<=b>=c<>d!=e||f==g')).toEqual([
      'word:A',
      'symbol:<=',
      'word:B',
      'symbol:>=',
      'word:C',
      'symbol:<>',
      'word:D',
      'symbol:<>',
      'word:E',
      'symbol:||',
      'word:F',
      'symbol:=',
      'word:G',
      'eof:',
    ]);
  });

  it('reads positional parameters', () => {
    expect(kinds('? $12')).toEqual(['param:?', 'param:$12', 'eof:']);
  });

  it('accepts Unicode letters in identifiers', () => {
    const [tok] = tokenize('Thành_phố');
    expect(tok).toMatchObject({ kind: 'word', text: 'Thành_phố' });
    expect(identifierOf(tok!)).toBe('thành_phố');
  });

  it('lower-cases bare identifiers but keeps quoted ones', () => {
    const [bare, quoted] = tokenize('Customers "Customers"');
    expect(identifierOf(bare!)).toBe('customers');
    expect(identifierOf(quoted!)).toBe('Customers');
  });
});

describe('tokenize errors', () => {
  it('points at the opening quote of an unterminated string', () => {
    const err = lexError("SELECT 'abc");
    expect(err.code).toBe('syntax_error');
    expect(err.message).toBe('unterminated string literal');
    expect([err.line, err.column]).toEqual([1, 8]);
  });

  it('reports an unexpected character with its column', () => {
    const err = lexError('SELECT a\n  FROM t @ x');
    expect(err.message).toBe('unexpected character "@"');
    expect([err.line, err.column]).toEqual([2, 10]);
  });

  it('rejects numbers glued to letters', () => {
    expect(lexError('SELECT 12abc').message).toBe('invalid number "12abc"');
  });

  it('rejects unterminated comments and identifiers', () => {
    expect(lexError('SELECT /* x').message).toBe('unterminated block comment');
    expect(lexError('SELECT "x').message).toBe('unterminated quoted identifier');
    expect(lexError('SELECT ""').message).toBe('empty quoted identifier');
  });

  it('never throws in lenient mode', () => {
    const tokens = tokenize("SELECT 'open -- x /* y @", { lenient: true });
    expect(tokens.map((t) => t.kind)).toEqual(['word', 'error', 'eof']);
    const withComment = tokenize('SELECT 1 -- done', { lenient: true });
    expect(withComment.map((t) => t.kind)).toEqual(['word', 'number', 'comment', 'eof']);
  });
});
