import { describe, expect, it } from 'vitest';
import { Database, GraniteError, formatError } from '../src/index.ts';

function seeded(): Database {
  const db = Database.open();
  db.execute(`
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, stock INTEGER);
    INSERT INTO products VALUES (1, 'pen', 1.5, 100), (2, 'book', 12.0, 7), (3, 'lamp', 30.25, 0);
  `);
  return db;
}

describe('Session.execute', () => {
  it('returns one result per statement with columns and rows', () => {
    const db = seeded();
    const [select, count] = db.execute(
      'SELECT name, price FROM products WHERE stock > 0 ORDER BY id; SELECT count(*) FROM products',
    );
    expect(select).toMatchObject({
      command: 'SELECT',
      columns: [
        { name: 'name', type: 'TEXT' },
        { name: 'price', type: 'REAL' },
      ],
      rows: [
        ['pen', 1.5],
        ['book', 12],
      ],
      rowsAffected: 2,
    });
    expect(count!.rows).toEqual([[3]]);
  });

  it('reports affected rows for DML', () => {
    const db = seeded();
    expect(db.query("UPDATE products SET stock = stock + 1 WHERE name <> 'pen'")).toMatchObject({
      command: 'UPDATE',
      rowsAffected: 2,
    });
    expect(db.query('DELETE FROM products WHERE stock = 1')).toMatchObject({ rowsAffected: 1 });
    expect(db.query('INSERT INTO products VALUES (9, ?, ?, ?)', ['cup', 3, 4])).toMatchObject({
      command: 'INSERT',
      rowsAffected: 1,
    });
  });

  it('binds parameters', () => {
    const db = seeded();
    const r = db.query(
      'SELECT name FROM products WHERE price BETWEEN ? AND ? ORDER BY price',
      [1, 20],
    );
    expect(r.rows).toEqual([['pen'], ['book']]);
  });

  it('locates errors in multi-statement scripts', () => {
    const db = seeded();
    const sql = 'SELECT 1;\nSELECT name FROM products WHERE nope = 1';
    let caught: unknown;
    try {
      db.execute(sql);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraniteError);
    const err = caught as GraniteError;
    expect([err.line, err.column]).toEqual([2, 33]);
    expect(formatError(err)).toContain('2 | SELECT name FROM products WHERE nope = 1');
  });

  it('points runtime errors without a position at their statement', () => {
    const db = seeded();
    const sql = 'SELECT 1; SELECT stock / 0 FROM products';
    let caught: GraniteError | undefined;
    try {
      db.execute(sql);
    } catch (err) {
      caught = err as GraniteError;
    }
    expect(caught?.code).toBe('division_by_zero');
    expect(caught?.column).toBe(11);
  });

  it('keeps the effects of statements before a failing one', () => {
    const db = seeded();
    expect(() => db.execute("INSERT INTO products VALUES (4, 'mug', 2, 1); SELECT nope")).toThrow();
    expect(db.query('SELECT count(*) FROM products').rows).toEqual([[4]]);
  });

  it('rejects use after close', () => {
    const db = seeded();
    db.close();
    expect(() => db.execute('SELECT 1')).toThrow('the database is closed');
  });
});

describe('EXPLAIN', () => {
  it('returns the plan as text rows and as a tree', () => {
    const db = seeded();
    const r = db.query('EXPLAIN SELECT name FROM products WHERE stock > 0 ORDER BY price');
    expect(r.command).toBe('EXPLAIN');
    expect(r.columns).toEqual([{ name: 'QUERY PLAN', type: 'TEXT' }]);
    expect(r.plan?.op).toBe('Project');
    expect(r.rows.map((row) => row[0])).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^└─ Sort products\.price {2}\(rows=\d+ cost=/),
      ]),
    );
  });

  it('runs the statement under EXPLAIN ANALYZE and counts rows', () => {
    const db = seeded();
    const r = db.query('EXPLAIN ANALYZE SELECT name FROM products WHERE stock > 0');
    const scan = (function find(n: NonNullable<typeof r.plan>): NonNullable<typeof r.plan> {
      return n.children.length ? find(n.children[0]!) : n;
    })(r.plan!);
    // The WHERE clause is pushed into the scan, which therefore emits 2 rows.
    expect(scan).toMatchObject({
      op: 'SeqScan',
      detail: 'products filter: products.stock > 0',
      actualRows: 2,
    });
    expect(r.plan!.actualRows).toBe(2);
  });

  it('wraps DML plans in a node naming the target table', () => {
    const db = seeded();
    const r = db.query('EXPLAIN DELETE FROM products WHERE stock = 0');
    expect(r.plan).toMatchObject({ op: 'Delete', detail: 'products' });
    expect(db.query('SELECT count(*) FROM products').rows).toEqual([[3]]);
  });

  it('refuses statements without a plan', () => {
    const db = seeded();
    expect(() => db.execute('EXPLAIN CREATE TABLE x (a INTEGER)')).toThrow(
      'EXPLAIN is not available',
    );
  });
});
