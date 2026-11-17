import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Database, MemoryFileSystem } from '../../src/index.ts';
import { NodeFileSystem } from '../../src/node.ts';

describe('persistence', () => {
  it('keeps tables, rows and indexes across close and reopen', () => {
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs, path: 'shop.db' });
    db.execute(`
      CREATE TABLE p (id INTEGER PRIMARY KEY, name TEXT, price REAL);
      CREATE INDEX p_price ON p (price);
      INSERT INTO p VALUES (1, 'Phở', 45000), (2, 'Bánh mì', 20000), (3, 'Cà phê', 25000);
    `);
    db.close();

    const again = Database.open({ fs, path: 'shop.db' });
    expect(again.tables().map((t) => t.name)).toEqual(['p']);
    expect(again.tables()[0]!.indexes.map((ix) => ix.name)).toEqual(['p_pkey', 'p_price']);
    expect(again.query('SELECT name FROM p ORDER BY price').rows).toEqual([
      ['Bánh mì'],
      ['Cà phê'],
      ['Phở'],
    ]);
    expect(() => again.execute("INSERT INTO p VALUES (1, 'dup', 1)")).toThrow('duplicate key');
    again.execute("INSERT INTO p VALUES (4, 'Chè', 15000)");
    again.close();

    expect(Database.open({ fs, path: 'shop.db' }).query('SELECT count(*) FROM p').rows).toEqual([
      [4],
    ]);
  });

  it('continues row ids after a reopen', () => {
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs });
    db.execute('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2)');
    db.close();
    const again = Database.open({ fs });
    again.execute('INSERT INTO t VALUES (3)');
    expect(again.query('SELECT a FROM t ORDER BY a').rows).toEqual([[1], [2], [3]]);
  });

  it('stores rows larger than a page', () => {
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs });
    const long = 'Lorem ipsum dolor sit amet. '.repeat(1000);
    db.execute('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    db.execute('INSERT INTO notes VALUES (1, ?)', [long]);
    db.close();
    const row = Database.open({ fs }).query('SELECT length(body), body FROM notes').rows[0]!;
    expect(row[0]).toBe(long.length);
    expect(row[1]).toBe(long);
  });

  it('reuses the pages of dropped tables', () => {
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs });
    db.execute('CREATE TABLE big (id INTEGER PRIMARY KEY, pad TEXT)');
    const values = Array.from({ length: 500 }, (_, i) => `(${i}, '${'p'.repeat(100)}')`).join(',');
    db.execute(`INSERT INTO big VALUES ${values}`);
    const pagesBefore = db.storage.pager.pageCount;
    db.execute('DROP TABLE big');
    db.execute('CREATE TABLE big2 (id INTEGER PRIMARY KEY, pad TEXT)');
    db.execute(`INSERT INTO big2 VALUES ${values}`);
    expect(db.storage.pager.pageCount).toBe(pagesBefore);
  });
});

describe('statement atomicity', () => {
  it('undoes a multi-row INSERT that fails half way', () => {
    const db = Database.open();
    db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.execute("INSERT INTO t VALUES (2, 'two')");
    expect(() => db.execute("INSERT INTO t VALUES (1, 'one'), (2, 'again'), (3, 'three')")).toThrow(
      'duplicate key',
    );
    expect(db.query('SELECT id FROM t ORDER BY id').rows).toEqual([[2]]);
    db.execute("INSERT INTO t VALUES (1, 'one'), (3, 'three')");
    expect(db.query('SELECT count(*) FROM t').rows).toEqual([[3]]);
  });

  it('undoes an UPDATE that fails on a later row, including index changes', () => {
    const db = Database.open();
    db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER UNIQUE)');
    db.execute('INSERT INTO t VALUES (1, 10), (2, 20), (3, 30)');
    expect(() => db.execute('UPDATE t SET n = 20 WHERE id <> 2')).toThrow('duplicate key');
    expect(db.query('SELECT id, n FROM t ORDER BY id').rows).toEqual([
      [1, 10],
      [2, 20],
      [3, 30],
    ]);
    expect(db.query('SELECT id FROM t WHERE n = 10').rows).toEqual([[1]]);
  });

  it('undoes a failed CREATE INDEX and keeps the catalog consistent', () => {
    const db = Database.open();
    db.execute('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (1)');
    expect(() => db.execute('CREATE UNIQUE INDEX t_a ON t (a)')).toThrow('duplicate key');
    expect(db.tables()[0]!.indexes).toEqual([]);
    expect(db.storage.loadCatalog()[0]!.indexes).toEqual([]);
    db.execute('CREATE INDEX t_a ON t (a)');
    expect(db.tables()[0]!.indexes.map((ix) => ix.name)).toEqual(['t_a']);
  });
});

describe('NodeFileSystem databases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'granite-db-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('persists to a real file', () => {
    const path = join(dir, 'real.db');
    const db = Database.open({ fs: new NodeFileSystem(), path });
    db.execute(
      "CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER); INSERT INTO kv VALUES ('a', 1), ('b', 2)",
    );
    db.close();
    const again = Database.open({ fs: new NodeFileSystem(), path });
    expect(again.query('SELECT sum(v) FROM kv').rows).toEqual([[3]]);
    again.close();
  });
});
