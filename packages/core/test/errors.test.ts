import { describe, expect, it } from 'vitest';
import { GraniteError, formatError, positionOf } from '../src/errors.ts';

describe('positionOf', () => {
  it('counts lines and code-point columns from 1', () => {
    expect(positionOf('SELECT 1', 0)).toEqual({ line: 1, column: 1 });
    expect(positionOf('SELECT\n  x', 9)).toEqual({ line: 2, column: 3 });
  });

  it('counts an astral character as one column', () => {
    const sql = "SELECT '\u{1F600}' x";
    expect(positionOf(sql, sql.indexOf('x'))).toEqual({ line: 1, column: 12 });
  });
});

describe('formatError', () => {
  it('draws a caret under the offending token', () => {
    const sql = 'SELECT * FORM t';
    const err = new GraniteError('syntax_error', 'expected FROM, found "FORM"', {
      span: { start: 9, end: 13 },
    }).locate(sql);
    expect(err.line).toBe(1);
    expect(err.column).toBe(10);
    expect(formatError(err)).toBe(
      [
        'error[syntax_error]: expected FROM, found "FORM"',
        ' --> line 1, column 10',
        '  |',
        '1 | SELECT * FORM t',
        '  |          ^^^^',
      ].join('\n'),
    );
  });

  it('shows the right line of a multi-line statement', () => {
    const sql = 'SELECT a,\n       b\nFROM nowhere';
    const start = sql.indexOf('nowhere');
    const err = new GraniteError('undefined_table', 'table "nowhere" does not exist', {
      span: { start, end: start + 7 },
    });
    const text = formatError(err, sql);
    expect(text).toContain('--> line 3, column 6');
    expect(text).toContain('3 | FROM nowhere');
    expect(text).toContain('  |      ^^^^^^^');
  });

  it('keeps tabs in the caret padding', () => {
    const sql = '\tSELECT ?';
    const err = new GraniteError('syntax_error', 'boom', { span: { start: 8, end: 9 } });
    expect(formatError(err, sql).split('\n').at(-1)).toBe('  | \t       ^');
  });

  it('uses at least one caret for an empty span at end of input', () => {
    const sql = 'SELECT';
    const err = new GraniteError('syntax_error', 'unexpected end of input', {
      span: { start: 6, end: 6 },
    });
    expect(formatError(err, sql).split('\n').at(-1)).toBe('  |       ^');
  });

  it('appends a hint line', () => {
    const err = new GraniteError('undefined_column', 'column "nme" does not exist', {
      hint: 'did you mean "name"?',
    });
    expect(formatError(err)).toBe(
      'error[undefined_column]: column "nme" does not exist\n  = hint: did you mean "name"?',
    );
  });

  it('reports foreign errors without a stack trace', () => {
    const text = formatError(new TypeError('x is not a function'));
    expect(text).toBe('internal error: x is not a function');
    expect(formatError('plain')).toBe('internal error: plain');
  });
});
