import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Database, MemoryFileSystem } from '../../src/index.ts';

describe('transactions', () => {
  it('rolls back uncommitted work when the process dies', () => {
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs });
    db.execute('CREATE TABLE t (a INTEGER PRIMARY KEY); CREATE TABLE other (x INTEGER)');
    db.execute('INSERT INTO t VALUES (1)');
    const s = db.session();
    s.execute('BEGIN; INSERT INTO t VALUES (2); UPDATE t SET a = 10 WHERE a = 1');
    // Another session's commit logs every dirty page, including the open transaction's.
    db.execute('INSERT INTO other VALUES (1)');
    fs.crash();
    const again = Database.open({ fs });
    expect(again.abortedOnOpen).toBe(1);
    expect(again.query('SELECT a FROM t ORDER BY a').rows).toEqual([[1]]);
    // The aborted key 2 is free again, and the abort itself is durable.
    again.execute('INSERT INTO t VALUES (2)');
    fs.crash();
    const third = Database.open({ fs });
    expect(third.abortedOnOpen).toBe(0);
    expect(third.query('SELECT a FROM t ORDER BY a').rows).toEqual([[1], [2]]);
  });

  it('logs nothing for an open transaction until something commits', () => {
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs });
    db.execute('CREATE TABLE t (a INTEGER)');
    const logged = fs.contents('granite.db-wal').length;
    const s = db.session();
    s.execute('BEGIN; INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)');
    expect(fs.contents('granite.db-wal').length).toBe(logged);
    s.execute('COMMIT');
    expect(fs.contents('granite.db-wal').length).toBeGreaterThan(logged);
    fs.crash();
    const again = Database.open({ fs });
    expect(again.abortedOnOpen).toBe(0);
    expect(again.query('SELECT sum(a) FROM t').rows).toEqual([[3]]);
  });

  it('keeps a committed transaction across a crash', () => {
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs });
    const s = db.session();
    db.execute('CREATE TABLE t (a INTEGER)');
    s.execute('BEGIN; INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); COMMIT');
    fs.crash();
    expect(Database.open({ fs }).query('SELECT sum(a) FROM t').rows).toEqual([[3]]);
  });

  it('rolls back the open transaction when a session or the database closes', () => {
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs });
    db.execute('CREATE TABLE t (a INTEGER)');
    const s = db.session();
    s.execute('BEGIN; INSERT INTO t VALUES (1)');
    expect(s.inTransaction).toBe(true);
    s.close();
    expect(db.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
    expect(() => s.execute('SELECT 1')).toThrow('the session is closed');

    db.session().execute('BEGIN; INSERT INTO t VALUES (2)');
    db.close();
    const again = Database.open({ fs });
    expect(again.abortedOnOpen).toBe(0);
    expect(again.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
  });

  it('undoes a failed statement but keeps the transaction', () => {
    const db = Database.open();
    db.execute('CREATE TABLE t (a INTEGER PRIMARY KEY)');
    const s = db.session();
    s.execute('BEGIN; INSERT INTO t VALUES (1)');
    expect(() => s.execute('INSERT INTO t VALUES (2), (1)')).toThrow('duplicate key');
    s.execute('INSERT INTO t VALUES (3); COMMIT');
    expect(db.query('SELECT a FROM t ORDER BY a').rows).toEqual([[1], [3]]);
  });

  it('updates more pages in one statement than the cache holds', () => {
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs, cachePages: 16 });
    db.execute(
      'CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER, pad TEXT); CREATE INDEX t_b ON t (b)',
    );
    const rows = Array.from({ length: 3000 }, (_, i) => `(${i}, ${i % 7}, '${'x'.repeat(40)}')`);
    db.execute(`INSERT INTO t VALUES ${rows.join(', ')}`);
    // After a checkpoint the pages are clean, so the cache shrinks and the UPDATE reads them back.
    db.execute('CHECKPOINT');
    db.execute('UPDATE t SET b = b + 100');
    db.close();
    const again = Database.open({ fs, cachePages: 16 });
    expect(again.query('SELECT count(*), min(b), max(b) FROM t').rows).toEqual([[3000, 100, 106]]);
    expect(again.query('SELECT count(*) FROM t WHERE b = 103').rows).toEqual([[429]]);
  });

  it('VACUUM removes dead versions and their index entries', () => {
    const db = Database.open();
    db.execute('CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER); CREATE INDEX t_b ON t (b)');
    for (let i = 0; i < 50; i++) db.execute(`INSERT INTO t VALUES (${i}, ${i % 5})`);
    db.execute('UPDATE t SET b = b + 10 WHERE a < 20');
    db.execute('DELETE FROM t WHERE a >= 40');
    const s = db.session();
    s.execute('BEGIN; INSERT INTO t VALUES (100, 0)');
    s.execute('ROLLBACK');
    const table = db.tables().find((t) => t.name === 't')!;
    expect(db.store.rowCount(table)).toBe(50 + 20 + 1);
    // 20 replaced versions, 10 deleted rows, 1 aborted insert.
    expect(db.query('VACUUM t').rowsAffected).toBe(31);
    expect(db.store.rowCount(table)).toBe(40);
    expect(db.query('VACUUM').rowsAffected).toBe(0);
    expect(db.query('SELECT count(*) FROM t WHERE b >= 10').rows).toEqual([[20]]);
    expect(db.query('SELECT count(*) FROM t WHERE b = 0').rows).toEqual([[4]]);
    expect(db.query('SELECT sum(a) FROM t').rows).toEqual([[780]]);
  });

  it('VACUUM keeps versions an open snapshot still needs', () => {
    const db = Database.open();
    db.execute('CREATE TABLE t (a INTEGER)');
    db.execute('INSERT INTO t VALUES (1)');
    const reader = db.session();
    reader.execute('BEGIN; SELECT * FROM t');
    db.execute('UPDATE t SET a = 2');
    expect(db.query('VACUUM t').rowsAffected).toBe(0);
    expect(reader.executeOne('SELECT a FROM t').rows).toEqual([[1]]);
    reader.execute('COMMIT');
    expect(db.query('VACUUM t').rowsAffected).toBe(1);
    expect(db.query('SELECT a FROM t').rows).toEqual([[2]]);
  });

  it('matches a serial model under interleaved sessions', () => {
    // Random interleavings of two sessions doing increments. Under snapshot
    // isolation with first-updater-wins, every committed increment is counted
    // exactly once, whatever the order.
    type Op = { session: 0 | 1; action: 'begin' | 'inc' | 'commit' | 'rollback' };
    const op = fc.record({
      session: fc.constantFrom<0 | 1>(0, 1),
      action: fc.constantFrom<Op['action']>('begin', 'inc', 'inc', 'commit', 'rollback'),
    });
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        const db = Database.open();
        db.execute(
          'CREATE TABLE c (id INTEGER PRIMARY KEY, n INTEGER); INSERT INTO c VALUES (1, 0)',
        );
        const sessions = [db.session(), db.session()];
        const pending = [0, 0];
        let committed = 0;
        for (const { session, action } of ops) {
          const s = sessions[session]!;
          try {
            if (action === 'begin' && !s.inTransaction) s.execute('BEGIN');
            if (action === 'inc') {
              s.execute('UPDATE c SET n = n + 1 WHERE id = 1');
              if (s.inTransaction) pending[session]!++;
              else committed++;
            }
            if (action === 'commit' && s.inTransaction) {
              s.execute('COMMIT');
              committed += pending[session]!;
              pending[session] = 0;
            }
            if (action === 'rollback' && s.inTransaction) {
              s.execute('ROLLBACK');
              pending[session] = 0;
            }
          } catch (err) {
            expect((err as { code?: string }).code).toBe('serialization_failure');
          }
        }
        for (const s of sessions) s.close();
        expect(db.query('SELECT n FROM c').rows).toEqual([[committed]]);
      }),
      { numRuns: 200 },
    );
  });
});
