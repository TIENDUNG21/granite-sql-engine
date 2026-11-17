import { describe, expect, it } from 'vitest';
import type { BoundSelect, BoundStatement } from '../src/binder/bound.ts';
import { exprToString } from '../src/binder/bound.ts';
import { bindStatement } from '../src/binder/binder.ts';
import { Catalog } from '../src/catalog/catalog.ts';
import { GraniteError } from '../src/errors.ts';
import { parseStatement } from '../src/sql/parser.ts';
import type { Value } from '../src/types/datatype.ts';

function catalog(): Catalog {
  const c = new Catalog();
  for (const sql of [
    'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT, vip BOOLEAN)',
    'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total REAL, placed TEXT)',
  ]) {
    const bound = bindStatement(parseStatement(sql), { catalog: c, params: [], source: sql });
    if (bound.kind !== 'create_table') throw new Error('expected create_table');
    c.putTable(bound.table);
  }
  return c;
}

function bind(sql: string, params: Value[] = []): BoundStatement {
  return bindStatement(parseStatement(sql), { catalog: catalog(), params, source: sql });
}

function bindSelect(sql: string, params: Value[] = []): BoundSelect {
  const b = bind(sql, params);
  if (b.kind !== 'select') throw new Error('not a select');
  return b.query;
}

function bindError(sql: string): GraniteError {
  try {
    bind(sql);
  } catch (err) {
    if (err instanceof GraniteError) return err.locate(sql);
    throw err;
  }
  throw new Error(`expected a bind error: ${sql}`);
}

describe('output columns', () => {
  it('names columns after aliases, column names or the source text', () => {
    const q = bindSelect(
      'SELECT c.id, name AS n, total * 2, count(*) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id, name, total',
    );
    expect(q.outputs.map((o) => o.name)).toEqual(['id', 'n', 'total * 2', 'count(*)']);
  });

  it('infers result types', () => {
    const q = bindSelect(
      'SELECT c.id / 2, total / 2, c.id || name, avg(c.id), sum(c.id), sum(total), min(name) FROM customers c, orders GROUP BY c.id, total, name',
    );
    expect(q.outputs.map((o) => o.type)).toEqual([
      'INTEGER',
      'REAL',
      'TEXT',
      'REAL',
      'INTEGER',
      'REAL',
      'TEXT',
    ]);
  });

  it('expands stars in FROM order', () => {
    const q = bindSelect('SELECT o.*, c.name FROM customers c, orders o');
    expect(q.outputs.map((o) => o.name)).toEqual(['id', 'customer_id', 'total', 'placed', 'name']);
  });
});

describe('grouping', () => {
  it('accepts GROUP BY positions and output aliases', () => {
    const byPosition = bindSelect('SELECT city, count(*) FROM customers GROUP BY 1');
    expect(byPosition.groupKeys).toHaveLength(1);
    const byAlias = bindSelect('SELECT upper(city) AS c, count(*) FROM customers GROUP BY c');
    expect(exprToString(byAlias.groupKeys[0]!.expr)).toBe('upper(customers.city)');
  });

  it('matches grouped expressions structurally', () => {
    const q = bindSelect('SELECT upper(city), count(*) FROM customers GROUP BY upper(city)');
    expect(q.outputs[0]!.expr).toMatchObject({ kind: 'column', id: q.groupKeys[0]!.id });
  });

  it('shares one accumulator between identical aggregate calls', () => {
    const q = bindSelect('SELECT count(*) FROM customers HAVING count(*) > 1 ORDER BY count(*)');
    expect(q.aggregates).toHaveLength(1);
  });

  it('marks a query with only aggregates as aggregated', () => {
    expect(bindSelect('SELECT max(id) FROM customers').aggregated).toBe(true);
    expect(bindSelect('SELECT id FROM customers').aggregated).toBe(false);
  });
});

describe('ORDER BY', () => {
  it('resolves output names before input columns', () => {
    const q = bindSelect('SELECT name AS id FROM customers ORDER BY id');
    expect(q.hidden).toHaveLength(0);
    expect(q.orderBy[0]!.expr).toMatchObject({ id: q.outputs[0]!.id });
  });

  it('adds hidden columns for expressions not in the select list', () => {
    const q = bindSelect('SELECT name FROM customers ORDER BY id DESC');
    expect(q.hidden).toHaveLength(1);
    expect(q.orderBy[0]).toMatchObject({ desc: true, nullsFirst: true });
  });
});

describe('parameters', () => {
  it('binds positional parameters as typed constants', () => {
    const q = bindSelect('SELECT ?, ?, ?, ? FROM customers', [1, 2.5, 'x', null]);
    expect(q.outputs.map((o) => o.type)).toEqual(['INTEGER', 'REAL', 'TEXT', 'NULL']);
  });

  it('normalizes text parameters to NFC', () => {
    const q = bindSelect('SELECT $1 FROM customers', ['Vie\u0302\u0323t']);
    expect(q.outputs[0]!.expr).toMatchObject({ kind: 'const', value: 'Việt' });
  });

  it('rejects missing and unsupported parameter values', () => {
    expect(() => bind('SELECT $2', [1])).toThrow('no value supplied for parameter $2');
    expect(() => bind('SELECT ?', [Number.NaN])).toThrow(
      'must be a string, finite number, boolean or null',
    );
    expect(() => bind('SELECT ?', [2 ** 60])).toThrow('out of the INTEGER range');
  });

  it('type-checks parameters like literals', () => {
    expect(() => bind('SELECT * FROM customers WHERE id = ?', ['x'])).toThrow(
      'cannot compare column "id" (INTEGER) with TEXT',
    );
  });
});

describe('error positions', () => {
  it('points at the misspelled column', () => {
    const err = bindError('SELECT id,\n  nmae FROM customers');
    expect(err.code).toBe('undefined_column');
    expect([err.line, err.column]).toEqual([2, 3]);
    expect(err.hint).toBe('did you mean "name"?');
  });

  it('points at the whole ill-typed expression', () => {
    const sql = 'SELECT name - 1 FROM customers';
    const err = bindError(sql);
    expect(sql.slice(err.span!.start, err.span!.end)).toBe('name - 1');
  });

  it('suggests qualified names for ambiguous columns', () => {
    const err = bindError('SELECT id FROM customers, orders');
    expect(err.hint).toBe('qualify it: customers.id or orders.id');
  });
});

describe('DDL binding', () => {
  it('creates a primary-key index first and marks key columns NOT NULL', () => {
    const b = bind('CREATE TABLE t (a INTEGER, b TEXT UNIQUE, PRIMARY KEY (a))');
    if (b.kind !== 'create_table') throw new Error();
    expect(b.table.indexes.map((ix) => [ix.name, ix.primary, ix.unique])).toEqual([
      ['t_pkey', true, true],
      ['t_b_key', false, true],
    ]);
    expect(b.table.columns[0]!.notNull).toBe(true);
  });

  it('evaluates constant defaults once, at CREATE time', () => {
    const b = bind("CREATE TABLE t (a REAL DEFAULT 1 + 1, s TEXT DEFAULT 'a' || 'b')");
    if (b.kind !== 'create_table') throw new Error();
    expect(b.table.columns.map((c) => c.default)).toEqual([2, 'ab']);
  });

  it('rejects an index on a missing column', () => {
    expect(() => bind('CREATE INDEX ix ON orders (nope)')).toThrow(
      'column "nope" of table "orders" does not exist',
    );
  });
});
