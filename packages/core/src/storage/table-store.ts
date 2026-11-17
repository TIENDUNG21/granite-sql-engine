import type { IndexSchema, TableSchema } from '../catalog/schema.ts';
import { GraniteError } from '../errors.ts';
import type { IndexRange, RowStore, StoredRow } from '../exec/row-source.ts';
import type { DataType, Value } from '../types/datatype.ts';
import { formatValue } from '../types/value.ts';
import { BTree, MAX_KEY_SIZE } from './btree.ts';
import type { XidStatus } from '../txn/clog.ts';
import {
  afterNull,
  decodeRow,
  decodeRowHeader,
  decodeRowId,
  encodeIndexKey,
  encodeKey,
  encodeRow,
  encodeRowId,
  extendKey,
  prefixEnd,
  rowIdOfIndexKey,
  setRowXmax,
  type RowHeader,
} from './codec.ts';
import type { Pager } from './pager.ts';

const EMPTY = new Uint8Array(0);

/** How the store decides what a transaction sees and may change (see txn/manager.ts). */
export interface RowVisibility {
  /** Id stamped on versions this transaction writes; assigned on first use. */
  writerXid(): number;
  visible(header: RowHeader): boolean;
  /** Throws serialization_failure if the version may not be deleted or replaced. */
  checkWritable(header: RowHeader): void;
  /** Whether the version holds its unique key (may throw on a concurrent writer). */
  occupiesKey(header: RowHeader): boolean;
}

/**
 * Tables and indexes on top of B+trees:
 * - a table is a B+tree from row id to a row version (MVCC header + values);
 * - an index is a B+tree whose keys are (indexed values..., row id) and whose
 *   values are empty, so equal values sort by row id and stay unique.
 *
 * Rows are never updated in place. UPDATE stamps the old version with the
 * writer's xid (xmax) and inserts a new version under a new row id, with new
 * entries in every index; readers pick the version their snapshot can see.
 * Old versions and their index entries stay until VACUUM removes them.
 */
export class PagedRowStore implements RowStore {
  private readonly pager: Pager;
  private readonly mvcc: RowVisibility;

  constructor(pager: Pager, mvcc: RowVisibility) {
    this.pager = pager;
    this.mvcc = mvcc;
  }

  private tree(root: number): BTree {
    return new BTree(this.pager, root);
  }

  *scan(table: TableSchema): Generator<StoredRow> {
    const types = typesOf(table);
    for (const [key, value] of this.tree(table.rootPage).scan()) {
      if (!this.mvcc.visible(decodeRowHeader(value))) continue;
      yield { rowid: decodeRowId(key), values: decodeRow(value, types) };
    }
  }

  *indexScan(table: TableSchema, index: IndexSchema, range: IndexRange): Generator<StoredRow> {
    const types = typesOf(table);
    const rows = this.tree(table.rootPage);
    const [lower, upper] = rangeKeys(range);
    for (const key of this.tree(index.rootPage).keys(lower, upper)) {
      const rowid = rowIdOfIndexKey(key);
      const value = rows.get(encodeRowId(rowid));
      if (!value) {
        throw new GraniteError(
          'corrupt_database',
          `index ${index.name} points at missing row ${rowid}`,
        );
      }
      if (!this.mvcc.visible(decodeRowHeader(value))) continue;
      yield { rowid, values: decodeRow(value, types) };
    }
  }

  insert(table: TableSchema, values: Value[]): void {
    for (const index of table.indexes) if (index.unique) this.checkUnique(table, index, values);
    this.insertVersion(table, values);
  }

  private insertVersion(table: TableSchema, values: Value[]): void {
    const rows = this.tree(table.rootPage);
    const rowid = rows.allocateRowId();
    const header = { xmin: this.mvcc.writerXid(), xmax: 0 };
    rows.insert(encodeRowId(rowid), encodeRow(header, values, typesOf(table)));
    rows.adjustCount(1);
    for (const index of table.indexes) {
      this.tree(index.rootPage).insert(this.indexKey(index, values, rowid), EMPTY);
    }
  }

  update(table: TableSchema, rowid: number, old: Value[], values: Value[]): void {
    this.delete(table, rowid);
    // An unchanged key is only held by the version just deleted, so it cannot conflict.
    const changed = table.indexes.filter(
      (ix) => ix.unique && ix.columns.some((c) => old[c] !== values[c]),
    );
    for (const index of changed) this.checkUnique(table, index, values);
    this.insertVersion(table, values);
  }

  delete(table: TableSchema, rowid: number): void {
    const rows = this.tree(table.rootPage);
    const key = encodeRowId(rowid);
    // A copy: get() may return a view into a cached page, which must only change through update().
    const value = rows.get(key)?.slice();
    if (!value) throw new GraniteError('internal_error', `row ${rowid} of ${table.name} vanished`);
    this.mvcc.checkWritable(decodeRowHeader(value));
    setRowXmax(value, this.mvcc.writerXid());
    rows.update(key, value);
  }

  rowCount(table: TableSchema): number {
    return this.tree(table.rootPage).count;
  }

  createTable(table: TableSchema): TableSchema {
    const rootPage = BTree.create(this.pager);
    const indexes = table.indexes.map((ix) => ({ ...ix, rootPage: BTree.create(this.pager) }));
    return { ...table, rootPage, indexes };
  }

  dropTable(table: TableSchema): void {
    for (const index of table.indexes) this.tree(index.rootPage).destroy();
    this.tree(table.rootPage).destroy();
  }

  createIndex(table: TableSchema, index: IndexSchema): IndexSchema {
    const built = { ...index, rootPage: BTree.create(this.pager) };
    const tree = this.tree(built.rootPage);
    const types = typesOf(table);
    // Every stored version gets an entry, visible or not: an older snapshot may need it.
    // Read everything first so the scan does not interleave with index writes.
    const versions = [...this.tree(table.rootPage).scan()];
    for (const [key, value] of versions) {
      const rowid = decodeRowId(key);
      const values = decodeRow(value, types);
      if (built.unique && this.mvcc.occupiesKey(decodeRowHeader(value))) {
        this.checkUnique(table, built, values);
      }
      tree.insert(this.indexKey(built, values, rowid), EMPTY);
    }
    return built;
  }

  dropIndex(_table: TableSchema, index: IndexSchema): void {
    this.tree(index.rootPage).destroy();
  }

  /**
   * Physically remove versions no snapshot can see any more: those created by
   * aborted transactions, and those deleted by a transaction that committed
   * before `horizon`. Returns how many versions were removed.
   */
  vacuum(table: TableSchema, horizon: number, status: (xid: number) => XidStatus): number {
    const rows = this.tree(table.rootPage);
    const types = typesOf(table);
    const dead: { rowid: number; values: Value[] }[] = [];
    for (const [key, value] of rows.scan()) {
      const { xmin, xmax } = decodeRowHeader(value);
      const aborted = xmin !== 0 && status(xmin) === 'aborted';
      const deleted = xmax !== 0 && xmax < horizon && status(xmax) === 'committed';
      if (aborted || deleted)
        dead.push({ rowid: decodeRowId(key), values: decodeRow(value, types) });
    }
    for (const { rowid, values } of dead) {
      rows.delete(encodeRowId(rowid));
      for (const index of table.indexes) {
        this.tree(index.rootPage).delete(this.indexKey(index, values, rowid));
      }
    }
    rows.adjustCount(-dead.length);
    return dead.length;
  }

  private indexKey(index: IndexSchema, values: Value[], rowid: number): Uint8Array {
    const key = encodeIndexKey(
      index.columns.map((c) => values[c] ?? null),
      rowid,
    );
    if (key.length > MAX_KEY_SIZE) {
      throw new GraniteError(
        'program_limit_exceeded',
        `index row of ${key.length} bytes exceeds the maximum of ${MAX_KEY_SIZE} for index "${index.name}"`,
        { hint: 'index shorter values, or drop the index' },
      );
    }
    return key;
  }

  /** Raise unique_violation if another version holds the same non-NULL key. */
  private checkUnique(table: TableSchema, index: IndexSchema, values: Value[]): void {
    const keyValues = index.columns.map((c) => values[c] ?? null);
    if (keyValues.includes(null)) return; // NULLs never conflict
    const prefix = encodeKey(keyValues);
    const rows = this.tree(table.rootPage);
    for (const key of [...this.tree(index.rootPage).keys(prefix, prefixEnd(prefix))]) {
      const version = rows.get(encodeRowId(rowIdOfIndexKey(key)));
      if (version && this.mvcc.occupiesKey(decodeRowHeader(version))) {
        throw uniqueViolation(table, index, keyValues);
      }
    }
  }
}

export function typesOf(table: TableSchema): DataType[] {
  return table.columns.map((c) => c.type);
}

/** Byte bounds [lower, upper) of an index range. */
export function rangeKeys(range: IndexRange): [Uint8Array, Uint8Array] {
  const prefix = encodeKey(range.prefix);
  let lower: Uint8Array;
  let upper: Uint8Array;
  if (range.lower) {
    const k = extendKey(prefix, range.lower.value);
    lower = range.lower.inclusive ? k : prefixEnd(k);
  } else {
    // A range on the next column never includes NULL.
    lower = range.upper ? afterNull(prefix) : prefix;
  }
  if (range.upper) {
    const k = extendKey(prefix, range.upper.value);
    upper = range.upper.inclusive ? prefixEnd(k) : k;
  } else {
    upper = prefixEnd(prefix);
  }
  return [lower, upper];
}

export function uniqueViolation(
  table: TableSchema,
  index: IndexSchema,
  key: Value[],
): GraniteError {
  const cols = index.columns.map((c) => table.columns[c]!.name).join(', ');
  const vals = key.map((v) => formatValue(v)).join(', ');
  return new GraniteError(
    'unique_violation',
    `duplicate key value violates unique constraint "${index.name}"`,
    {
      hint: `key (${cols})=(${vals}) already exists`,
    },
  );
}
