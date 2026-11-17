import { Catalog } from '../catalog/catalog.ts';
import type { TableSchema } from '../catalog/schema.ts';
import { GraniteError } from '../errors.ts';
import type { RowStore } from '../exec/row-source.ts';
import { parse } from '../sql/parser.ts';
import { MemoryRowStore } from '../storage/memory-store.ts';
import type { Value } from '../types/datatype.ts';
import type { QueryResult } from './result.ts';
import { executeStatement, type Engine } from './statements.ts';

/** An embedded database. Each Session is one connection to it. */
export class Database implements Engine {
  readonly catalog = new Catalog();
  readonly store: RowStore = new MemoryRowStore();
  private defaultSession: Session | undefined;
  private closed = false;

  static open(): Database {
    return new Database();
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
    const results = this.execute(sql, params);
    const last = results.at(-1);
    if (!last)
      throw new GraniteError('syntax_error', 'no statement to run', {
        span: { start: 0, end: sql.length },
      }).locate(sql);
    return last;
  }

  tables(): TableSchema[] {
    return this.catalog.tables();
  }

  close(): void {
    this.closed = true;
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
   * Parse and run every statement in `sql`. Errors are GraniteErrors located in
   * `sql` (line, column, caret excerpt via formatError).
   */
  execute(sql: string, params: readonly Value[] = []): QueryResult[] {
    this.db.assertOpen();
    const statements = parse(sql);
    const results: QueryResult[] = [];
    for (const stmt of statements) {
      try {
        results.push(executeStatement(this.db, stmt, params, sql));
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
