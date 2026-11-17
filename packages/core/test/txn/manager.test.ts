import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../../src/storage/file.ts';
import { Pager } from '../../src/storage/pager.ts';
import { Wal } from '../../src/storage/wal.ts';
import { MAX_XID } from '../../src/txn/clog.ts';
import { TransactionManager } from '../../src/txn/manager.ts';

function manager(): { txns: TransactionManager; pager: Pager } {
  const fs = new MemoryFileSystem();
  const pager = Pager.open(fs.open('t.db'), Wal.open(fs.open('t.db-wal'), { newDatabase: true }));
  return { txns: new TransactionManager(pager), pager };
}

describe('commit log', () => {
  it('starts every xid in progress and records commits and aborts', () => {
    const { txns } = manager();
    expect(txns.clog.status(5)).toBe('in-progress');
    txns.clog.set(5, 'committed');
    txns.clog.set(6, 'aborted');
    expect([txns.clog.status(4), txns.clog.status(5), txns.clog.status(6)]).toEqual([
      'in-progress',
      'committed',
      'aborted',
    ]);
    // Neighbours sharing a byte keep their bits.
    txns.clog.set(7, 'committed');
    txns.clog.set(5, 'aborted');
    expect([txns.clog.status(6), txns.clog.status(7)]).toEqual(['aborted', 'committed']);
  });

  it('treats xid 0 as committed and grows across pages', () => {
    const { txns, pager } = manager();
    expect(txns.clog.status(0)).toBe('committed');
    const before = pager.pageCount;
    txns.clog.set(16384 * 2 + 3, 'committed');
    expect(pager.pageCount).toBe(before + 3);
    expect(txns.clog.status(16384 * 2 + 3)).toBe('committed');
    expect(txns.clog.status(16384 + 3)).toBe('in-progress');
  });

  it('refuses ids past its capacity', () => {
    const { txns } = manager();
    expect(() => txns.clog.set(MAX_XID + 1, 'committed')).toThrow(
      'exceeds the commit log capacity',
    );
  });
});

describe('visibility', () => {
  it('follows the snapshot, not the commit order', () => {
    const { txns } = manager();
    const w1 = txns.begin(true);
    const x1 = txns.xidFor(w1); // running when the reader starts
    const reader = txns.begin(true);
    txns.ensureSnapshot(reader);
    txns.commit(w1);
    const w2 = txns.begin(true);
    const x2 = txns.xidFor(w2); // started after the reader's snapshot
    txns.commit(w2);

    const row = (xmin: number, xmax = 0): { xmin: number; xmax: number } => ({ xmin, xmax });
    // Created by a transaction that was running at snapshot time: invisible, even after commit.
    expect(txns.visible(row(x1), reader)).toBe(false);
    expect(txns.visible(row(x2), reader)).toBe(false);
    expect(txns.visible(row(0), reader)).toBe(true);
    // Deleted by those transactions: still visible to the reader.
    expect(txns.visible(row(0, x1), reader)).toBe(true);
    expect(txns.visible(row(0, x2), reader)).toBe(true);
    // A fresh snapshot sees both commits.
    const later = txns.begin(false);
    expect(txns.visible(row(x1), later)).toBe(true);
    expect(txns.visible(row(0, x2), later)).toBe(false);
  });

  it('shows a transaction its own changes and hides aborted ones', () => {
    const { txns } = manager();
    const t = txns.begin(true);
    const x = txns.xidFor(t);
    expect(txns.visible({ xmin: x, xmax: 0 }, t)).toBe(true);
    expect(txns.visible({ xmin: 0, xmax: x }, t)).toBe(false);
    const other = txns.begin(false);
    expect(txns.visible({ xmin: x, xmax: 0 }, other)).toBe(false);
    txns.abort(t);
    const after = txns.begin(false);
    expect(txns.visible({ xmin: x, xmax: 0 }, after)).toBe(false);
    expect(txns.visible({ xmin: 0, xmax: x }, after)).toBe(true);
  });

  it('moves the VACUUM horizon only when old snapshots finish', () => {
    const { txns } = manager();
    const old = txns.begin(true);
    txns.ensureSnapshot(old);
    const horizon = txns.horizon();
    const w = txns.begin(false);
    txns.xidFor(w);
    txns.commit(w);
    expect(txns.horizon()).toBe(horizon);
    txns.commit(old);
    expect(txns.horizon()).toBeGreaterThan(horizon);
  });

  it('marks transactions interrupted by a crash as aborted', () => {
    const { txns } = manager();
    const done = txns.begin(false);
    const x1 = txns.xidFor(done);
    txns.commit(done);
    const x2 = txns.xidFor(txns.begin(true));
    expect(txns.abortInterrupted()).toBe(1);
    expect([txns.status(x1), txns.status(x2)]).toEqual(['committed', 'aborted']);
  });
});
