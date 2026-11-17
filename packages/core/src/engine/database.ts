import { Catalog } from '../catalog/catalog.ts';
import type { TableSchema } from '../catalog/schema.ts';
import { GraniteError } from '../errors.ts';
import type { Statement } from '../sql/ast.ts';
import { parse } from '../sql/parser.ts';
import { StorageEngine } from '../storage/engine.ts';
import { MemoryFileSystem, type FileSystem } from '../storage/file.ts';
import { PagedRowStore } from '../storage/table-store.ts';
import type { RecoveryReport } from '../storage/wal.ts';
import { TransactionManager, type Transaction } from '../txn/manager.ts';
import type { Value } from '../types/datatype.ts';
import { okResult, type QueryResult } from './result.ts';
import { executeStatement, type Engine } from './statements.ts';

export interface DatabaseOptions {
  /** Where the database files live; defaults to a fresh in-memory file system. */
  readonly fs?: FileSystem;
  /** Path of the database file within `fs` (default "granite.db"). */
  readonly path?: string;
  /** Clean pages kept in the buffer cache (default 2048 = 8 MiB). */
  readonly cachePages?: number;
  /** Checkpoint when the write-ahead log exceeds this size (default 4 MiB). */
  readonly checkpointBytes?: number;
}

/** Statements that change the schema; they are not transactional. */
const DDL = new Set<Statement['kind']>([
  'create_table',
  'drop_table',
  'create_index',
  'drop_index',
]);

/**
 * An embedded database. Each Session is one connection to it; sessions take
 * turns statement by statement, and their transactions are isolated by MVCC
 * snapshots (see txn/manager.ts).
 */
export class Database implements Engine {
  readonly storage: StorageEngine;
  readonly catalog: Catalog;
  readonly txns: TransactionManager;
  readonly store: PagedRowStore;
  /** Interrupted transactions found (and aborted) when the database was opened. */
  readonly abortedOnOpen: number;
  private defaultSession: Session | undefined;
  /** The transaction of the statement now running. */
  private current: Transaction | undefined;
  private closed = false;

  private constructor(storage: StorageEngine) {
    this.storage = storage;
    this.txns = new TransactionManager(storage.pager);
    this.abortedOnOpen = this.txns.abortInterrupted();
    if (this.abortedOnOpen > 0) storage.pager.commit();
    const txn = (): Transaction => {
      if (!this.current) throw new GraniteError('internal_error', 'row access outside a statement');
      return this.current;
    };
    this.store = new PagedRowStore(storage.pager, {
      writerXid: () => this.txns.xidFor(txn()),
      visible: (h) => this.txns.visible(h, txn()),
      checkWritable: (h) => this.txns.checkWritable(h, txn()),
      occupiesKey: (h) => this.txns.occupiesKey(h, txn()),
    });
    this.catalog = new Catalog(storage);
    this.catalog.load(storage.loadCatalog());
  }

  static open(options: DatabaseOptions = {}): Database {
    const fs = options.fs ?? new MemoryFileSystem();
    return new Database(StorageEngine.open(fs, options.path ?? 'granite.db', options));
  }

  session(): Session {
    this.assertOpen();
    return new Session(this);
  }

  /** Run SQL on the database's default session. */
  execute(sql: string, params: readonly Value[] = []): QueryResult[] {
    this.defaultSession ??= this.session();
    return this.defaultSession.execute(sql, params);
  }

  /** Run SQL and return the result of its last statement. */
  query(sql: string, params: readonly Value[] = []): QueryResult {
    const last = this.execute(sql, params).at(-1);
    if (!last) {
      throw new GraniteError('syntax_error', 'no statement to run', {
        span: { start: 0, end: sql.length },
      }).locate(sql);
    }
    return last;
  }

  tables(): TableSchema[] {
    return this.catalog.tables();
  }

  /** What crash recovery replayed when this database was opened. */
  get recovery(): RecoveryReport {
    return this.storage.recovery;
  }

  checkpoint(): void {
    this.storage.pager.checkpoint();
  }

  vacuum(table: TableSchema): number {
    return this.store.vacuum(table, this.txns.horizon(), (xid) => this.txns.status(xid));
  }

  /**
   * Run one statement atomically inside `txn`, or as its own transaction when
   * `txn` is undefined. On failure every page change it made is undone, and an
   * explicit transaction stays usable.
   */
  runStatement<T>(txn: Transaction | undefined, fn: () => T): T {
    const t = txn ?? this.txns.begin(false);
    this.current = t;
    try {
      // Snapshot isolation: an explicit transaction keeps the snapshot of its first statement.
      this.txns.ensureSnapshot(t);
      // Inside BEGIN ... COMMIT nothing needs to be durable before COMMIT, so the
      // pages a statement changed are logged (once) by the next commit of any session.
      return this.storage.atomic(() => {
        const result = fn();
        if (!t.explicit) this.txns.commit(t);
        return result;
      }, !t.explicit);
    } catch (err) {
      this.catalog.load(this.storage.loadCatalog());
      this.txns.forgetStatementXid(t);
      if (!t.explicit) this.txns.abort(t);
      throw err;
    } finally {
      t.xidFromCurrentStatement = false;
      this.current = undefined;
    }
  }

  /** COMMIT or ROLLBACK: one durable commit-log change. */
  finish(txn: Transaction, commit: boolean): void {
    this.storage.atomic(() => (commit ? this.txns.commit(txn) : this.txns.abort(txn)));
  }

  /** Schema changes are refused inside a transaction and while others are open. */
  checkDdl(txn: Transaction | undefined, kind: string): void {
    const what = kind.replace('_', ' ').toUpperCase();
    if (txn) {
      throw new GraniteError(
        'invalid_transaction_state',
        `${what} cannot run inside a transaction block`,
        {
          hint: 'schema changes are not transactional; run them outside BEGIN ... COMMIT',
        },
      );
    }
    if (this.txns.othersOpen(txn)) {
      throw new GraniteError(
        'invalid_transaction_state',
        `${what} cannot run while other transactions are open`,
        {
          hint: 'commit or roll back the open transactions first',
        },
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Transactions still open are rolled back, as if their sessions had closed.
    this.txns.abortAll();
    this.storage.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  assertOpen(): void {
    if (this.closed) throw new GraniteError('invalid_transaction_state', 'the database is closed');
  }
}

export class Session {
  private readonly db: Database;
  private txn: Transaction | undefined;
  private closed = false;

  constructor(db: Database) {
    this.db = db;
  }

  /** Inside BEGIN ... COMMIT. */
  get inTransaction(): boolean {
    return this.txn !== undefined;
  }

  /** Run SQL and return the result of its last statement. */
  executeOne(sql: string, params: readonly Value[] = []): QueryResult {
    const last = this.execute(sql, params).at(-1);
    if (!last) {
      throw new GraniteError('syntax_error', 'no statement to run', {
        span: { start: 0, end: sql.length },
      }).locate(sql);
    }
    return last;
  }

  /** Close the session; an open transaction is rolled back. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.txn && !this.db.isClosed) this.db.finish(this.txn, false);
    this.txn = undefined;
  }

  /**
   * Parse and run every statement in `sql`. Each statement is atomic. Errors are
   * GraniteErrors located in `sql` (line, column, caret excerpt via formatError).
   */
  execute(sql: string, params: readonly Value[] = []): QueryResult[] {
    this.db.assertOpen();
    if (this.closed) throw new GraniteError('invalid_transaction_state', 'the session is closed');
    const statements = parse(sql);
    const results: QueryResult[] = [];
    for (const stmt of statements) {
      try {
        results.push(this.run(stmt, params, sql));
      } catch (err) {
        if (err instanceof GraniteError) {
          // Errors raised without a position point at the whole statement.
          const located = err.span
            ? err
            : new GraniteError(err.code, err.message, {
                span: stmt.span,
                hint: err.hint,
                cause: err,
              });
          throw located.locate(sql);
        }
        throw err;
      }
    }
    return results;
  }

  private run(stmt: Statement, params: readonly Value[], sql: string): QueryResult {
    switch (stmt.kind) {
      case 'checkpoint':
        // Not a data change: it runs outside any atomic section.
        this.db.checkpoint();
        return okResult('CHECKPOINT');
      case 'begin':
        if (this.txn) {
          throw new GraniteError(
            'invalid_transaction_state',
            'a transaction is already in progress',
          );
        }
        this.txn = this.db.txns.begin(true);
        return okResult('BEGIN');
      case 'commit':
      case 'rollback': {
        const txn = this.txn;
        if (!txn)
          throw new GraniteError(
            'invalid_transaction_state',
            'there is no transaction in progress',
          );
        this.txn = undefined;
        this.db.finish(txn, stmt.kind === 'commit');
        return okResult(stmt.kind === 'commit' ? 'COMMIT' : 'ROLLBACK');
      }
      case 'vacuum':
        if (this.txn) {
          throw new GraniteError(
            'invalid_transaction_state',
            'VACUUM cannot run inside a transaction block',
          );
        }
        break;
      default:
        if (DDL.has(stmt.kind)) this.db.checkDdl(this.txn, stmt.kind);
    }
    return this.db.runStatement(this.txn, () => executeStatement(this.db, stmt, params, sql));
  }
}
