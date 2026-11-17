import type { IndexSchema, TableSchema } from '../catalog/schema.ts';
import { GraniteError } from '../errors.ts';
import type { IndexRange, RowStore, StoredRow } from '../exec/row-source.ts';
import type { DataType, Value } from '../types/datatype.ts';
import { formatValue } from '../types/value.ts';
import { BTree, MAX_KEY_SIZE } from './btree.ts';
import {
  afterNull,
  decodeRow,
  decodeRowId,
  encodeIndexKey,
  encodeKey,
  encodeRow,
  encodeRowId,
  extendKey,
  prefixEnd,
  rowIdOfIndexKey,
} from './codec.ts';
import type { Pager } from './pager.ts';

const EMPTY = new Uint8Array(0);

/**
 * Tables and indexes on top of B+trees:
 * - a table is a B+tree from row id to encoded row;
 * - an index is a B+tree whose keys are (indexed values..., row id) and whose
 *   values are empty, so equal values sort by row id and stay unique.
 */
export class PagedRowStore implements RowStore {
  private readonly pager: Pager;

  constructor(pager: Pager) {
    this.pager = pager;
  }

  private tree(root: number): BTree {
    return new BTree(this.pager, root);
  }

  *scan(table: TableSchema): Generator<StoredRow> {
    const types = typesOf(table);
    for (const [key, value] of this.tree(table.rootPage).scan()) {
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
      if (!value)
        throw new GraniteError(
          'corrupt_database',
          `index ${index.name} points at missing row ${rowid}`,
        );
      yield { rowid, values: decodeRow(value, types) };
    }
  }

  insert(table: TableSchema, values: Value[]): void {
    for (const index of table.indexes)
      if (index.unique) this.checkUnique(table, index, values, undefined);
    const rows = this.tree(table.rootPage);
    const rowid = rows.allocateRowId();
    rows.insert(encodeRowId(rowid), encodeRow({ xmin: 0, xmax: 0 }, values, typesOf(table)));
    rows.adjustCount(1);
    for (const index of table.indexes)
      this.tree(index.rootPage).insert(this.indexKey(index, values, rowid), EMPTY);
  }

  update(table: TableSchema, rowid: number, old: Value[], values: Value[]): void {
    const changed = table.indexes.filter((ix) => ix.columns.some((c) => old[c] !== values[c]));
    for (const index of changed) if (index.unique) this.checkUnique(table, index, values, rowid);
    this.tree(table.rootPage).update(
      encodeRowId(rowid),
      encodeRow({ xmin: 0, xmax: 0 }, values, typesOf(table)),
    );
    for (const index of changed) {
      const tree = this.tree(index.rootPage);
      tree.delete(this.indexKey(index, old, rowid));
      tree.insert(this.indexKey(index, values, rowid), EMPTY);
    }
  }

  delete(table: TableSchema, rowid: number, old: Value[]): void {
    const rows = this.tree(table.rootPage);
    if (!rows.delete(encodeRowId(rowid))) return;
    rows.adjustCount(-1);
    for (const index of table.indexes)
      this.tree(index.rootPage).delete(this.indexKey(index, old, rowid));
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
    // Read all rows first: the scan must not interleave with index page writes.
    for (const row of [...this.scan(table)]) {
      if (built.unique) this.checkUnique(table, built, row.values, row.rowid);
      tree.insert(this.indexKey(built, row.values, row.rowid), EMPTY);
    }
    return built;
  }

  dropIndex(_table: TableSchema, index: IndexSchema): void {
    this.tree(index.rootPage).destroy();
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

  /** Raise unique_violation if another row has the same non-NULL key. */
  private checkUnique(
    table: TableSchema,
    index: IndexSchema,
    values: Value[],
    self: number | undefined,
  ): void {
    const keyValues = index.columns.map((c) => values[c] ?? null);
    if (keyValues.includes(null)) return; // NULLs never conflict
    const prefix = encodeKey(keyValues);
    for (const key of this.tree(index.rootPage).keys(prefix, prefixEnd(prefix))) {
      if (rowIdOfIndexKey(key) !== self) throw uniqueViolation(table, index, keyValues);
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
