import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Database, MemoryFileSystem } from '../../src/index.ts';
import { FaultyFileSystem, SimulatedCrash, tornWrites } from '../support/faulty-fs.ts';

/**
 * Workload for crash tests: statement i either inserts key i or bumps the value
 * of an earlier key, so every prefix of the workload has a distinct state.
 */
function workload(n: number): string[] {
  const out = ['CREATE TABLE kv (k INTEGER PRIMARY KEY, v INTEGER, pad TEXT)'];
  for (let i = 1; i <= n; i++) {
    out.push(
      i % 4 === 0
        ? `UPDATE kv SET v = v + 1000 WHERE k = ${i - 2}`
        : `INSERT INTO kv VALUES (${i}, ${i}, '${'x'.repeat(200 + (i % 7) * 60)}')`,
    );
  }
  return out;
}

function stateOf(db: Database): string {
  if (!db.tables().some((t) => t.name === 'kv')) return 'no table';
  return JSON.stringify(db.query('SELECT k, v, length(pad) FROM kv ORDER BY k').rows);
}

/** Expected state of kv after each prefix of the workload (index = statements run). */
function prefixStates(statements: string[]): string[] {
  const db = Database.open();
  const states = [stateOf(db)];
  for (const sql of statements) {
    db.execute(sql);
    states.push(stateOf(db));
  }
  return states;
}

describe('crash recovery', () => {
  it('keeps committed statements when the process dies without closing', () => {
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs });
    db.execute('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2)');
    // No close(): the data file has not seen these changes, only the log has.
    fs.crash();
    const again = Database.open({ fs });
    expect(again.recovery.groups).toBe(2);
    expect(again.query('SELECT sum(a) FROM t').rows).toEqual([[3]]);
  });

  it('starts with an empty log after a clean close', () => {
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs });
    db.execute('CREATE TABLE t (a INTEGER)');
    db.close();
    expect(fs.contents('granite.db-wal').length).toBe(16);
    expect(Database.open({ fs }).recovery).toEqual({ groups: 0, pages: 0, discardedBytes: 0 });
  });

  it('checkpoints when the log grows past the threshold', () => {
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs, checkpointBytes: 64 * 1024 });
    db.execute('CREATE TABLE t (a INTEGER, pad TEXT)');
    for (let i = 0; i < 100; i++) db.execute(`INSERT INTO t VALUES (${i}, '${'p'.repeat(300)}')`);
    expect(db.storage.pager.checkpoints).toBeGreaterThan(0);
    expect(db.storage.pager.wal.size).toBeLessThan(64 * 1024 + 5 * 4096);
    fs.crash();
    expect(Database.open({ fs }).query('SELECT count(*) FROM t').rows).toEqual([[100]]);
  });

  it('supports an explicit CHECKPOINT statement', () => {
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs });
    db.execute('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (7); CHECKPOINT');
    expect(fs.durableContents('granite.db-wal').length).toBe(16);
    fs.crash();
    expect(Database.open({ fs }).query('SELECT a FROM t').rows).toEqual([[7]]);
  });

  it('recovers a committed prefix after a crash at every I/O operation', () => {
    const statements = workload(24);
    const expected = prefixStates(statements);
    const options = { checkpointBytes: 48 * 1024 };

    // Count the I/O operations of a complete run.
    const probe = new FaultyFileSystem();
    const db = Database.open({ fs: probe, ...options });
    for (const sql of statements) db.execute(sql);
    const total = probe.operations;
    expect(total).toBeGreaterThan(statements.length * 2);

    for (let crashAt = 1; crashAt <= total; crashAt++) {
      const fs = new FaultyFileSystem();
      fs.crashAt = crashAt;
      let completed = 0;
      try {
        const victim = Database.open({ fs, ...options });
        for (const sql of statements) {
          victim.execute(sql);
          completed++;
        }
      } catch (err) {
        if (!(err instanceof SimulatedCrash)) throw err;
      }
      fs.crash(tornWrites(crashAt));
      const recovered = Database.open({ fs, ...options });
      const state = stateOf(recovered);
      // Acknowledged statements survive; the one in flight may or may not.
      const ok = state === expected[completed] || state === expected[completed + 1];
      expect(ok, `crash at operation ${crashAt} after ${completed} statements: ${state}`).toBe(
        true,
      );
      // The recovered database keeps working and survives another reopen.
      recovered.execute(
        'CREATE TABLE IF NOT EXISTS after_crash (x INTEGER); INSERT INTO after_crash VALUES (1)',
      );
      recovered.close();
      expect(Database.open({ fs }).query('SELECT count(*) FROM after_crash').rows).toEqual([[1]]);
    }
  });

  it('recovers exactly the complete groups of a log cut at any byte', () => {
    const statements = workload(8);
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs });
    const boundaries: number[] = [];
    for (const sql of statements) {
      db.execute(sql);
      boundaries.push(fs.contents('granite.db-wal').length);
    }
    const data = fs.contents('granite.db');
    const log = fs.contents('granite.db-wal');
    const expected = prefixStates(statements);

    // The header was synced when the log was created, so cuts start after it.
    fc.assert(
      fc.property(
        fc.integer({ min: 16, max: log.length }),
        fc.uint8Array({ maxLength: 40 }),
        (cut, garbage) => {
          const copy = new MemoryFileSystem();
          copy.open('granite.db').write(0, data);
          const wal = copy.open('granite.db-wal');
          wal.write(0, log.subarray(0, cut));
          wal.write(cut, garbage);
          const complete = boundaries.filter((b) => b <= cut).length;
          const recovered = Database.open({ fs: copy });
          expect(recovered.recovery.groups).toBe(complete);
          expect(stateOf(recovered)).toBe(expected[complete]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('stops replay at the first damaged record', () => {
    const fs = new MemoryFileSystem();
    const db = Database.open({ fs });
    db.execute('CREATE TABLE t (a INTEGER)');
    const afterCreate = fs.contents('granite.db-wal').length;
    db.execute('INSERT INTO t VALUES (1)');
    db.execute('INSERT INTO t VALUES (2)');
    const log = fs.contents('granite.db-wal');
    // One flipped byte in the first INSERT's group: it and every later group are ignored.
    log[afterCreate + 100]! ^= 0xff;
    const copy = new MemoryFileSystem();
    copy.open('granite.db').write(0, fs.contents('granite.db'));
    copy.open('granite.db-wal').write(0, log);
    const recovered = Database.open({ fs: copy });
    expect(recovered.recovery.groups).toBe(1);
    expect(recovered.recovery.discardedBytes).toBe(log.length - afterCreate);
    expect(recovered.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
  });

  it('refuses a log with a foreign header instead of guessing', () => {
    const fs = new MemoryFileSystem();
    Database.open({ fs }).close();
    fs.open('granite.db-wal').write(0, new TextEncoder().encode('NOTAWAL!'));
    expect(() => Database.open({ fs })).toThrow('the write-ahead log has a bad header');
  });
});
