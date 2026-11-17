import type { IndexSchema, TableSchema } from '../catalog/schema.ts';
import type { Value } from '../types/datatype.ts';

export interface StoredRow {
  readonly rowid: number;
  readonly values: Value[];
}

/**
 * A contiguous range of index entries: the leading `prefix.length` columns are
 * equal to `prefix`, and the next column lies between `lower` and `upper`.
 */
export interface IndexRange {
  readonly prefix: readonly Value[];
  readonly lower: { readonly value: Value; readonly inclusive: boolean } | undefined;
  readonly upper: { readonly value: Value; readonly inclusive: boolean } | undefined;
}

/** Read access to stored rows, as seen by the scan operators. */
export interface RowSource {
  scan(table: TableSchema): Iterable<StoredRow>;
  /** Rows whose index key falls in the range, in index order. */
  indexScan(table: TableSchema, index: IndexSchema, range: IndexRange): Iterable<StoredRow>;
}

/** Everything the executor needs from storage: reads, writes and DDL. */
export interface RowStore extends RowSource {
  insert(table: TableSchema, values: Value[]): void;
  update(table: TableSchema, rowid: number, oldValues: Value[], newValues: Value[]): void;
  delete(table: TableSchema, rowid: number, values: Value[]): void;
  /** Estimated live rows (used by the planner). */
  rowCount(table: TableSchema): number;
  /** Allocate storage for a new table and its indexes; returns the schema with root pages set. */
  createTable(table: TableSchema): TableSchema;
  dropTable(table: TableSchema): void;
  /** Build a new index over existing rows; returns it with its root page set. */
  createIndex(table: TableSchema, index: IndexSchema): IndexSchema;
  dropIndex(table: TableSchema, index: IndexSchema): void;
}
