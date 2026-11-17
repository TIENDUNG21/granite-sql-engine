import { GraniteError } from '../errors.ts';
import type { RowHeader } from '../storage/codec.ts';
import { HEADER, type Pager } from '../storage/pager.ts';
import { CommitLog, MAX_XID, type XidStatus } from './clog.ts';

/**
 * What a transaction can see: every transaction id below `xmax` that was not
 * in progress when the snapshot was taken. `xmin` is the oldest id that was
 * still running, used as the VACUUM horizon.
 */
export interface Snapshot {
  readonly xmin: number;
  readonly xmax: number;
  readonly active: ReadonlySet<number>;
}

export class Transaction {
  /** Assigned on the first write; read-only transactions never get one. */
  xid: number | undefined;
  snapshot: Snapshot | undefined;
  /** True for BEGIN ... COMMIT blocks, false for single autocommit statements. */
  readonly explicit: boolean;
  /** The xid was handed out by the statement now running (undone if it fails). */
  xidFromCurrentStatement = false;

  constructor(explicit: boolean) {
    this.explicit = explicit;
  }
}

export function serializationFailure(detail: string): GraniteError {
  return new GraniteError('serialization_failure', `could not serialize access due to ${detail}`, {
    hint: 'roll back and retry the transaction',
  });
}

/**
 * Snapshot isolation in the style of PostgreSQL: every row version carries the
 * id of the transaction that created it (xmin) and of the one that deleted it
 * (xmax); a snapshot decides which of those ids count as committed. Writers
 * never block readers, and a write-write conflict aborts the later writer
 * (first updater wins) because a single-threaded engine cannot wait for locks.
 */
export class TransactionManager {
  private readonly pager: Pager;
  readonly clog: CommitLog;
  /** Transactions with an assigned xid that have not finished. */
  private readonly running = new Map<number, Transaction>();
  /** Every unfinished transaction, including read-only ones (for the VACUUM horizon). */
  private readonly open = new Set<Transaction>();

  constructor(pager: Pager) {
    this.pager = pager;
    this.clog = new CommitLog(pager);
  }

  /** After a crash, transactions that never committed are aborted. */
  abortInterrupted(): number {
    const next = this.pager.headerU32(HEADER.nextXid);
    let n = 0;
    for (let xid = 1; xid < next; xid++) {
      if (this.clog.status(xid) === 'in-progress') {
        this.clog.set(xid, 'aborted');
        n++;
      }
    }
    return n;
  }

  begin(explicit: boolean): Transaction {
    const txn = new Transaction(explicit);
    this.open.add(txn);
    return txn;
  }

  /** Take the transaction's snapshot if it has none yet (first statement). */
  ensureSnapshot(txn: Transaction): Snapshot {
    if (!txn.snapshot) {
      const xmax = this.pager.headerU32(HEADER.nextXid);
      const active = new Set([...this.running.keys()].filter((x) => x !== txn.xid));
      txn.snapshot = { xmin: Math.min(xmax, ...active), xmax, active };
    }
    return txn.snapshot;
  }

  xidFor(txn: Transaction): number {
    if (txn.xid !== undefined) return txn.xid;
    const xid = this.pager.headerU32(HEADER.nextXid);
    if (xid > MAX_XID)
      throw new GraniteError('program_limit_exceeded', 'transaction ids are exhausted');
    this.pager.setHeaderU32(HEADER.nextXid, xid + 1);
    txn.xid = xid;
    txn.xidFromCurrentStatement = true;
    this.running.set(xid, txn);
    return xid;
  }

  /** The statement that assigned the xid failed and its page changes were undone. */
  forgetStatementXid(txn: Transaction): void {
    if (txn.xid !== undefined && txn.xidFromCurrentStatement) {
      this.running.delete(txn.xid);
      txn.xid = undefined;
    }
    txn.xidFromCurrentStatement = false;
  }

  commit(txn: Transaction): void {
    this.finish(txn, 'committed');
  }

  abort(txn: Transaction): void {
    this.finish(txn, 'aborted');
  }

  private finish(txn: Transaction, status: XidStatus): void {
    if (txn.xid !== undefined) {
      this.clog.set(txn.xid, status);
      this.running.delete(txn.xid);
    }
    this.open.delete(txn);
  }

  /** Roll back every unfinished transaction (the database is closing). */
  abortAll(): void {
    for (const txn of [...this.open]) this.abort(txn);
  }

  status(xid: number): XidStatus {
    return this.clog.status(xid);
  }

  /** Other explicit transactions are open (DDL is refused while they are). */
  othersOpen(txn: Transaction | undefined): boolean {
    for (const t of this.open) if (t !== txn && t.explicit) return true;
    return false;
  }

  /** Versions deleted by transactions below this id are invisible to everyone. */
  horizon(): number {
    let h = this.pager.headerU32(HEADER.nextXid);
    for (const t of this.open) {
      if (t.snapshot) h = Math.min(h, t.snapshot.xmin);
      if (t.xid !== undefined) h = Math.min(h, t.xid);
    }
    return h;
  }

  // ------------------------------------------------------------- visibility

  private committedFor(xid: number, txn: Transaction, snap: Snapshot): boolean {
    if (xid === 0) return true;
    if (xid === txn.xid) return true;
    if (xid >= snap.xmax || snap.active.has(xid)) return false;
    return this.clog.status(xid) === 'committed';
  }

  /** Is this row version part of the transaction's snapshot? */
  visible(header: RowHeader, txn: Transaction): boolean {
    const snap = this.ensureSnapshot(txn);
    if (!this.committedFor(header.xmin, txn, snap)) return false;
    return header.xmax === 0 || !this.committedFor(header.xmax, txn, snap);
  }

  /**
   * May `txn` delete or replace this (visible) version? Another deleter that is
   * still running, or that committed after our snapshot, is a conflict.
   */
  checkWritable(header: RowHeader, txn: Transaction): void {
    if (header.xmax === 0 || header.xmax === txn.xid) return;
    const status = this.clog.status(header.xmax);
    if (status === 'aborted') return;
    if (status === 'in-progress') throw serializationFailure('a concurrent update');
    throw serializationFailure('an update committed after this transaction started');
  }

  /** Does a version with this header occupy a unique key, from txn's point of view? */
  occupiesKey(header: RowHeader, txn: Transaction): boolean {
    const creator =
      header.xmin === 0 || header.xmin === txn.xid ? 'committed' : this.clog.status(header.xmin);
    if (creator === 'aborted') return false;
    if (creator === 'in-progress')
      throw serializationFailure('a concurrent insert of the same key');
    if (header.xmax === 0) return true;
    if (header.xmax === txn.xid) return false;
    const deleter = this.clog.status(header.xmax);
    if (deleter === 'aborted') return true;
    if (deleter === 'in-progress')
      throw serializationFailure('a concurrent delete of the same key');
    return false;
  }
}
