import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { GraniteError } from '../src/errors.ts';
import type { BinaryOp, Expr } from '../src/sql/ast.ts';
import { parse, parseExpression } from '../src/sql/parser.ts';
import { printExpr, stripSpans } from './support/sql-printer.ts';

const NO_SPAN = { start: 0, end: 0 };

/** Parse and require that failures are GraniteErrors located in the source. */
function parseOrGraniteError(sql: string): void {
  try {
    parse(sql);
  } catch (err) {
    if (!(err instanceof GraniteError)) throw err;
    expect(err.line).toBeGreaterThanOrEqual(1);
    expect(err.column).toBeGreaterThanOrEqual(1);
  }
}

const TOKENS = [
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP',
  'BY',
  'ORDER',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'JOIN',
  'LEFT',
  'ON',
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'NULL',
  'BETWEEN',
  'LIKE',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'CAST',
  'AS',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'CREATE',
  'TABLE',
  'INDEX',
  'DROP',
  'PRIMARY',
  'KEY',
  'INTEGER',
  'TEXT',
  'BEGIN',
  'COMMIT',
  'EXPLAIN',
  '(',
  ')',
  ',',
  ';',
  '.',
  '*',
  '+',
  '-',
  '/',
  '=',
  '<>',
  '<=',
  '||',
  '?',
  '$1',
  'a',
  'b',
  't',
  '"q"',
  "'s'",
  '1',
  '2.5',
  'count',
  'x',
];

describe('parser robustness', () => {
  it('never throws anything but GraniteError on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 80 }), (sql) => {
        parseOrGraniteError(sql);
      }),
      { numRuns: 500 },
    );
  });

  it('never throws anything but GraniteError on token soup', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...TOKENS), { maxLength: 30 }), (tokens) => {
        parseOrGraniteError(tokens.join(' '));
      }),
      { numRuns: 2000 },
    );
  });

  it('rejects absurd nesting with a limit error instead of a stack overflow', () => {
    const deep = `SELECT ${'('.repeat(100_000)}1${')'.repeat(100_000)}`;
    let caught: unknown;
    try {
      parse(deep);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraniteError);
    expect((caught as GraniteError).code).toBe('program_limit_exceeded');
    expect(() => parse(`SELECT ${'-'.repeat(100_000)}1`)).toThrow(GraniteError);
    expect(() => parse(`SELECT ${'NOT '.repeat(100_000)}TRUE`)).toThrow(GraniteError);
  });

  it('accepts reasonable nesting', () => {
    expect(() => parse(`SELECT ${'('.repeat(150)}1${')'.repeat(150)}`)).not.toThrow();
  });
});

// ---------------------------------------------------------------- round trip

const nfcString = fc.string({ unit: 'grapheme', maxLength: 8 }).map((s) => s.normalize('NFC'));
const name = nfcString.filter((s) => s.length > 0);
const ident = name.map((n) => ({ name: n, span: NO_SPAN }));

const literal: fc.Arbitrary<Expr> = fc.oneof(
  fc
    .integer({ min: 0, max: Number.MAX_SAFE_INTEGER })
    .map((v): Expr => ({ kind: 'literal', value: v, type: 'INTEGER', span: NO_SPAN })),
  fc
    .double({ min: 0, max: 1e9, noNaN: true })
    .map((v): Expr => ({ kind: 'literal', value: v, type: 'REAL', span: NO_SPAN })),
  nfcString.map((v): Expr => ({ kind: 'literal', value: v, type: 'TEXT', span: NO_SPAN })),
  fc.boolean().map((v): Expr => ({ kind: 'literal', value: v, type: 'BOOLEAN', span: NO_SPAN })),
  fc.constant<Expr>({ kind: 'literal', value: null, type: 'NULL', span: NO_SPAN }),
);

const column: fc.Arbitrary<Expr> = fc
  .tuple(fc.option(ident, { nil: undefined }), ident)
  .map(([table, n]): Expr => ({ kind: 'column', table, name: n, span: NO_SPAN }));

const param: fc.Arbitrary<Expr> = fc
  .integer({ min: 0, max: 20 })
  .map((index): Expr => ({ kind: 'param', index, span: NO_SPAN }));

const BINARY_OPS: BinaryOp[] = [
  'OR',
  'AND',
  '=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '||',
];

const { expr } = fc.letrec<{ expr: Expr }>((tie) => ({
  expr: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    literal,
    column,
    param,
    fc
      .tuple(fc.constantFrom<'-' | '+' | 'NOT'>('-', '+', 'NOT'), tie('expr'))
      .map(([op, operand]): Expr => ({ kind: 'unary', op, operand, span: NO_SPAN })),
    fc
      .tuple(fc.constantFrom(...BINARY_OPS), tie('expr'), tie('expr'))
      .map(([op, left, right]): Expr => ({ kind: 'binary', op, left, right, span: NO_SPAN })),
    fc
      .tuple(tie('expr'), fc.boolean())
      .map(([operand, negated]): Expr => ({ kind: 'is_null', operand, negated, span: NO_SPAN })),
    fc
      .tuple(tie('expr'), tie('expr'), tie('expr'), fc.boolean())
      .map(([operand, low, high, negated]): Expr => ({
        kind: 'between',
        operand,
        low,
        high,
        negated,
        span: NO_SPAN,
      })),
    fc
      .tuple(tie('expr'), fc.array(tie('expr'), { minLength: 1, maxLength: 3 }), fc.boolean())
      .map(([operand, list, negated]): Expr => ({
        kind: 'in_list',
        operand,
        list,
        negated,
        span: NO_SPAN,
      })),
    fc
      .tuple(tie('expr'), tie('expr'), fc.boolean())
      .map(([operand, pattern, negated]): Expr => ({
        kind: 'like',
        operand,
        pattern,
        negated,
        span: NO_SPAN,
      })),
    fc
      .tuple(
        fc.option(tie('expr'), { nil: undefined }),
        fc.array(fc.record({ when: tie('expr'), then: tie('expr') }), {
          minLength: 1,
          maxLength: 2,
        }),
        fc.option(tie('expr'), { nil: undefined }),
      )
      .map(([operand, whens, elseExpr]): Expr => ({
        kind: 'case',
        operand,
        whens,
        else: elseExpr,
        span: NO_SPAN,
      })),
    fc
      .tuple(tie('expr'), fc.constantFrom('INTEGER', 'REAL', 'TEXT', 'BOOLEAN' as const))
      .map(([operand, type]): Expr => ({ kind: 'cast', operand, type, span: NO_SPAN })),
    fc
      .tuple(
        fc.constantFrom('abs', 'coalesce', 'length', 'sum', 'f_1'),
        fc.array(tie('expr'), { maxLength: 3 }),
        fc.boolean(),
      )
      .map(([fname, args, distinct]): Expr => ({
        kind: 'call',
        name: { name: fname, span: NO_SPAN },
        args,
        star: false,
        distinct: distinct && args.length > 0,
        span: NO_SPAN,
      })),
  ),
}));

describe('print/parse round trip', () => {
  it('parse(print(e)) has the same tree as e', () => {
    fc.assert(
      fc.property(expr, (e) => {
        const printed = printExpr(e);
        expect(stripSpans(parseExpression(printed))).toEqual(stripSpans(e));
      }),
      { numRuns: 1000 },
    );
  });
});
