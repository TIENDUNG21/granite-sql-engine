import { describe, expect, it } from 'vitest';
import { GraniteError } from '../src/errors.ts';
import type { Expr, SelectStmt } from '../src/sql/ast.ts';
import { parse, parseExpression, parseStatement } from '../src/sql/parser.ts';
import { printExpr, stripSpans } from './support/sql-printer.ts';

/** Fully parenthesized rendering: a compact way to assert precedence. */
const shape = (sql: string) => printExpr(parseExpression(sql));

function select(sql: string): SelectStmt {
  const stmt = parseStatement(sql);
  if (stmt.kind !== 'select') throw new Error('not a select');
  return stmt;
}

function syntaxError(sql: string): GraniteError {
  try {
    parse(sql);
  } catch (err) {
    if (err instanceof GraniteError) return err;
    throw err;
  }
  throw new Error(`expected an error for: ${sql}`);
}

describe('expression precedence', () => {
  it.each([
    ['1 + 2 * 3', '(1 + (2 * 3))'],
    ['1 - 2 - 3', '((1 - 2) - 3)'],
    ['a OR b AND c', '("a" OR ("b" AND "c"))'],
    ['NOT a = b', '(NOT ("a" = "b"))'],
    ['NOT a AND b', '((NOT "a") AND "b")'],
    ["a || 'x' = 'y'", `(("a" || 'x') = 'y')`],
    ['-a * b', '((-"a") * "b")'],
    ['a + b BETWEEN 1 AND 2 AND c', '((("a" + "b") BETWEEN 1 AND 2) AND "c")'],
    ['a NOT BETWEEN 1 AND 2', '("a" NOT BETWEEN 1 AND 2)'],
    ['x IS NOT NULL OR y IS NULL', '(("x" IS NOT NULL) OR ("y" IS NULL))'],
    ['a NOT IN (1, 2)', '("a" NOT IN (1, 2))'],
    ["name NOT LIKE 'A%'", `("name" NOT LIKE 'A%')`],
    ['(1 + 2) * 3', '((1 + 2) * 3)'],
    ['a % 2 = 0', '(("a" % 2) = 0)'],
  ])('%s', (sql, expected) => {
    expect(shape(sql)).toBe(expected);
  });
});

describe('primary expressions', () => {
  it('distinguishes INTEGER and REAL literals', () => {
    expect(parseExpression('42')).toMatchObject({ kind: 'literal', value: 42, type: 'INTEGER' });
    expect(parseExpression('4.0')).toMatchObject({ kind: 'literal', value: 4, type: 'REAL' });
    expect(parseExpression('1e3')).toMatchObject({ type: 'REAL', value: 1000 });
  });

  it('reads TRUE, FALSE, NULL and strings', () => {
    expect(parseExpression('TRUE')).toMatchObject({ value: true, type: 'BOOLEAN' });
    expect(parseExpression('false')).toMatchObject({ value: false, type: 'BOOLEAN' });
    expect(parseExpression('NULL')).toMatchObject({ value: null, type: 'NULL' });
    expect(parseExpression("'x'")).toMatchObject({ value: 'x', type: 'TEXT' });
  });

  it('reads qualified columns and quoted names', () => {
    const e = parseExpression('o."Total"');
    expect(e).toMatchObject({ kind: 'column', table: { name: 'o' }, name: { name: 'Total' } });
  });

  it('numbers positional and numbered parameters', () => {
    const e = parseExpression('? + ? + $1') as Extract<Expr, { kind: 'binary' }>;
    expect(printExpr(e)).toBe('(($1 + $2) + $1)');
  });

  it('reads function calls, COUNT(*) and DISTINCT aggregates', () => {
    expect(parseExpression('COUNT(*)')).toMatchObject({
      kind: 'call',
      name: { name: 'count' },
      star: true,
    });
    expect(parseExpression('Sum(DISTINCT x)')).toMatchObject({
      kind: 'call',
      name: { name: 'sum' },
      distinct: true,
      args: [{ kind: 'column' }],
    });
    expect(parseExpression('coalesce(a, b, 0)')).toMatchObject({ args: [{}, {}, {}] });
  });

  it('reads simple and searched CASE', () => {
    expect(shape("CASE WHEN a > 1 THEN 'big' ELSE 'small' END")).toBe(
      `CASE WHEN ("a" > 1) THEN 'big' ELSE 'small' END`,
    );
    expect(shape("CASE status WHEN 1 THEN 'on' WHEN 0 THEN 'off' END")).toBe(
      `CASE "status" WHEN 1 THEN 'on' WHEN 0 THEN 'off' END`,
    );
  });

  it('reads CAST with type synonyms', () => {
    expect(parseExpression('CAST(x AS VARCHAR(20))')).toMatchObject({ kind: 'cast', type: 'TEXT' });
    expect(parseExpression('CAST(x AS double precision)')).toMatchObject({ type: 'REAL' });
  });

  it('reads IN and scalar subqueries', () => {
    const e = parseExpression('id IN (SELECT customer_id FROM orders WHERE total > 10)');
    expect(e).toMatchObject({ kind: 'in_subquery', query: { kind: 'select' } });
    expect(parseExpression('(SELECT MAX(x) FROM t)')).toMatchObject({ kind: 'subquery' });
  });

  it('records the source span of every node', () => {
    const sql = 'price * (1 + tax)';
    const e = parseExpression(sql);
    expect(e.span).toEqual({ start: 0, end: sql.length });
    const right = (e as Extract<Expr, { kind: 'binary' }>).right;
    expect(sql.slice(right.span.start, right.span.end)).toBe('(1 + tax)');
  });
});

describe('SELECT', () => {
  it('parses every clause', () => {
    const s = select(`
      SELECT DISTINCT c.city, COUNT(*) AS n
      FROM customers c
      WHERE c.joined >= 2020
      GROUP BY c.city
      HAVING COUNT(*) > 1
      ORDER BY n DESC NULLS LAST, c.city
      LIMIT 10 OFFSET 5`);
    expect(s.distinct).toBe(true);
    expect(s.columns).toHaveLength(2);
    expect(s.columns[1]).toMatchObject({ kind: 'expr', alias: { name: 'n' } });
    expect(s.from).toMatchObject({
      kind: 'table',
      name: { name: 'customers' },
      alias: { name: 'c' },
    });
    expect(s.groupBy).toHaveLength(1);
    expect(s.having).toBeDefined();
    expect(s.orderBy).toMatchObject([
      { desc: true, nulls: 'last' },
      { desc: false, nulls: undefined },
    ]);
    expect(s.limit).toMatchObject({ value: 10 });
    expect(s.offset).toMatchObject({ value: 5 });
  });

  it('parses stars and qualified stars', () => {
    const s = select('SELECT *, o.* FROM orders o');
    expect(s.columns).toMatchObject([
      { kind: 'star', table: undefined },
      { kind: 'star', table: { name: 'o' } },
    ]);
  });

  it('accepts an alias without AS', () => {
    expect(select('SELECT price p FROM t').columns[0]).toMatchObject({ alias: { name: 'p' } });
  });

  it('builds left-deep join trees', () => {
    const s = select(
      'SELECT * FROM a JOIN b ON a.id = b.a_id LEFT OUTER JOIN c ON c.id = b.c_id, d CROSS JOIN e',
    );
    expect(stripSpans(s.from)).toMatchObject({
      kind: 'join',
      joinType: 'cross',
      left: {
        kind: 'join',
        joinType: 'cross',
        left: {
          kind: 'join',
          joinType: 'left',
          left: { kind: 'join', joinType: 'inner', right: { name: { name: 'b' } } },
          right: { name: { name: 'c' } },
        },
        right: { name: { name: 'd' } },
      },
      right: { name: { name: 'e' } },
    });
  });

  it('parses SELECT without FROM and OFFSET without LIMIT', () => {
    const s = select('SELECT 1 + 1 OFFSET 0');
    expect(s.from).toBeUndefined();
    expect(s.offset).toBeDefined();
  });
});

describe('DDL', () => {
  it('parses CREATE TABLE with column and table constraints', () => {
    const stmt = parseStatement(`
      CREATE TABLE IF NOT EXISTS order_items (
        order_id INTEGER NOT NULL,
        line INT,
        sku VARCHAR(32) UNIQUE,
        qty INTEGER DEFAULT 1,
        price REAL NULL,
        gift BOOLEAN DEFAULT FALSE,
        PRIMARY KEY (order_id, line)
      )`);
    expect(stripSpans(stmt)).toMatchObject({
      kind: 'create_table',
      ifNotExists: true,
      name: { name: 'order_items' },
      columns: [
        { name: { name: 'order_id' }, type: 'INTEGER', notNull: true },
        { name: { name: 'line' }, type: 'INTEGER', notNull: false },
        { name: { name: 'sku' }, type: 'TEXT', unique: true },
        { name: { name: 'qty' }, default: { value: 1 } },
        { name: { name: 'price' }, type: 'REAL' },
        { name: { name: 'gift' }, type: 'BOOLEAN', default: { value: false } },
      ],
      constraints: [{ kind: 'primary_key', columns: [{ name: 'order_id' }, { name: 'line' }] }],
    });
  });

  it('marks a PRIMARY KEY column as NOT NULL', () => {
    const stmt = parseStatement('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(stmt).toMatchObject({ columns: [{ primaryKey: true, notNull: true }] });
  });

  it('parses CREATE [UNIQUE] INDEX and DROP', () => {
    expect(parseStatement('CREATE UNIQUE INDEX IF NOT EXISTS ix ON t (a, b)')).toMatchObject({
      kind: 'create_index',
      unique: true,
      ifNotExists: true,
      table: { name: 't' },
      columns: [{ name: 'a' }, { name: 'b' }],
    });
    expect(parseStatement('DROP TABLE IF EXISTS t')).toMatchObject({
      kind: 'drop_table',
      ifExists: true,
    });
    expect(parseStatement('DROP INDEX ix')).toMatchObject({ kind: 'drop_index', ifExists: false });
  });
});

describe('DML and control statements', () => {
  it('parses multi-row INSERT with a column list', () => {
    const stmt = parseStatement("INSERT INTO t (a, b) VALUES (1, 'x'), (2, NULL)");
    expect(stmt).toMatchObject({
      kind: 'insert',
      columns: [{ name: 'a' }, { name: 'b' }],
      source: {
        kind: 'values',
        rows: [
          [{}, {}],
          [{}, {}],
        ],
      },
    });
  });

  it('parses INSERT ... SELECT', () => {
    expect(parseStatement('INSERT INTO t SELECT * FROM u')).toMatchObject({
      source: { kind: 'select', query: { kind: 'select' } },
    });
  });

  it('parses UPDATE and DELETE', () => {
    expect(parseStatement('UPDATE t SET a = a + 1, b = NULL WHERE id = 3')).toMatchObject({
      kind: 'update',
      assignments: [{ column: { name: 'a' } }, { column: { name: 'b' } }],
      where: { kind: 'binary' },
    });
    expect(parseStatement('DELETE FROM t')).toMatchObject({ kind: 'delete', where: undefined });
  });

  it('parses transactions, EXPLAIN, ANALYZE and VACUUM', () => {
    const kinds = parse(
      'BEGIN; BEGIN TRANSACTION; COMMIT; ROLLBACK; EXPLAIN ANALYZE SELECT 1; ANALYZE; ANALYZE t; VACUUM',
    ).map((s) => s.kind);
    expect(kinds).toEqual([
      'begin',
      'begin',
      'commit',
      'rollback',
      'explain',
      'analyze',
      'analyze',
      'vacuum',
    ]);
  });

  it('splits scripts on semicolons and ignores empty statements', () => {
    const stmts = parse(';;SELECT 1;; SELECT 2;');
    expect(stmts).toHaveLength(2);
    expect(stmts[1]!.span).toEqual({ start: 13, end: 21 });
    expect(parse('  -- only a comment\n')).toEqual([]);
  });
});

describe('syntax errors', () => {
  it.each([
    ['SELECT * FORM t', 'expected ";" or end of input, found "FORM"', 1, 10],
    ['SELECT a,\nFROM t', 'expected an expression, found "FROM"', 2, 1],
    ['SELECT (1 + 2', 'expected ")", found end of input', 1, 14],
    ['INSERT INTO t VALUES (1, 2', 'expected ")", found end of input', 1, 27],
    ['CREATE TABLE t ()', 'expected a column name, found ")"', 1, 17],
    [
      'SELEC 1',
      'expected a statement (SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ...), found "SELEC"',
      1,
      1,
    ],
    ['UPDATE t SET WHERE x = 1', 'expected a column name, found reserved word "WHERE"', 1, 14],
    ['SELECT 1 ORDER BY x NULLS', 'expected FIRST or LAST, found end of input', 1, 26],
    ['CREATE TABLE t (a BLOB)', 'unknown type "BLOB"', 1, 19],
    ['SELECT CASE END', 'expected an expression, found "END"', 1, 13],
    ['DROP VIEW v', 'expected TABLE or INDEX, found "VIEW"', 1, 6],
    ['EXPLAIN EXPLAIN SELECT 1', 'EXPLAIN cannot be nested', 1, 9],
  ])('%s', (sql, message, line, column) => {
    const err = syntaxError(sql);
    expect(err.message).toBe(message);
    expect([err.line, err.column]).toEqual([line, column]);
  });

  it('suggests quoting a reserved word used as a name', () => {
    const err = syntaxError('CREATE TABLE order (id INTEGER)');
    expect(err.hint).toBe('quote it to use it as a name: "order"');
  });

  it('rejects integers beyond the safe range with their position', () => {
    const err = syntaxError('SELECT 9007199254740993');
    expect(err.code).toBe('numeric_out_of_range');
    expect(err.column).toBe(8);
  });

  it('reports unsupported features with a dedicated code', () => {
    expect(syntaxError('SELECT * FROM (SELECT 1) x').code).toBe('feature_not_supported');
    expect(syntaxError('SELECT EXISTS (SELECT 1)').code).toBe('feature_not_supported');
  });

  it('does not take unsupported keywords for aliases', () => {
    const right = syntaxError('SELECT * FROM a RIGHT JOIN b ON a.x = b.x');
    expect([right.code, right.message, right.hint]).toEqual([
      'feature_not_supported',
      'RIGHT JOIN is not supported',
      'swap the two tables and use LEFT JOIN',
    ]);
    expect(right.column).toBe(17);
    expect(syntaxError('SELECT * FROM a FULL OUTER JOIN b ON true').message).toBe(
      'FULL JOIN is not supported',
    );
    for (const op of ['UNION', 'INTERSECT', 'EXCEPT']) {
      const err = syntaxError(`SELECT 1 ${op} SELECT 2`);
      expect([err.code, err.message, err.column]).toEqual([
        'feature_not_supported',
        `${op} is not supported`,
        10,
      ]);
    }
  });
});
