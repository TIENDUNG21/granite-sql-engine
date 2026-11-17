import { Catalog } from '../catalog/catalog.ts';
import type { TableSchema } from '../catalog/schema.ts';
import { GraniteError } from '../errors.ts';
import type { RowStore } from '../exec/row-source.ts';
import { parse } from '../sql/parser.ts';
import { StorageEngine } from '../storage/engine.ts';
import { MemoryFileSystem, type FileSystem } from '../storage/file.ts';
import type { RecoveryReport } from '../storage/wal.ts';
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

/** An embedded database. Each Session is one connection to it. */
export class Database implements Engine {
  readonly storage: StorageEngine;
  readonly catalog: Catalog;
  private defaultSession: Session | undefined;
  private closed = false;

  private constructor(storage: StorageEngine) {
    this.storage = storage;
    this.catalog = new Catalog(storage);
    this.catalog.load(storage.loadCatalog());
  }

  static open(options: DatabaseOptions = {}): Database {
    const fs = options.fs ?? new MemoryFileSystem();
    return new Database(StorageEngine.open(fs, options.path ?? 'granite.db', options));
  }

  get store(): RowStore {
    return this.storage.rows;
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

  /** Run one statement atomically; on failure every change it made is undone. */
  runAtomic<T>(fn: () => T): T {
    try {
      return this.storage.atomic(fn);
    } catch (err) {
      this.catalog.load(this.storage.loadCatalog());
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.storage.close();
  }

  assertOpen(): void {
    if (this.closed) throw new GraniteError('invalid_transaction_state', 'the database is closed');
  }
}

export class Session {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Parse and run every statement in `sql`. Each statement is atomic. Errors are
   * GraniteErrors located in `sql` (line, column, caret excerpt via formatError).
   */
  execute(sql: string, params: readonly Value[] = []): QueryResult[] {
    this.db.assertOpen();
    const statements = parse(sql);
    const results: QueryResult[] = [];
    for (const stmt of statements) {
      try {
        if (stmt.kind === 'checkpoint') {
          // Not a data change: it must run outside the statement's atomic section.
          this.db.checkpoint();
          results.push(okResult('CHECKPOINT'));
          continue;
        }
        results.push(this.db.runAtomic(() => executeStatement(this.db, stmt, params, sql)));
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
}
