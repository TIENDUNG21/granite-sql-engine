import type { IndexSchema, TableSchema } from '../catalog/schema.ts';
import { GraniteError } from '../errors.ts';
import type { IndexRange, RowStore, StoredRow } from '../exec/row-source.ts';
import type { Value } from '../types/datatype.ts';
import { compareValues, formatValue, hashKey } from '../types/value.ts';

/**
 * A volatile row store kept in JS maps. It implements the same contract as the
 * paged storage engine, with brute-force index access.
 */
export class MemoryRowStore implements RowStore {
  private readonly tables = new Map<string, Map<number, Value[]>>();
  private nextRowId = 1;

  private rows(table: TableSchema): Map<number, Value[]> {
    const rows = this.tables.get(table.name);
    if (!rows) throw new GraniteError('internal_error', `no storage for table ${table.name}`);
    return rows;
  }

  *scan(table: TableSchema): Generator<StoredRow> {
    for (const [rowid, values] of [...this.rows(table)]) yield { rowid, values };
  }

  *indexScan(table: TableSchema, index: IndexSchema, range: IndexRange): Generator<StoredRow> {
    const matches: StoredRow[] = [];
    for (const [rowid, values] of this.rows(table)) {
      const key: Value[] = index.columns.map((c) => values[c] ?? null);
      if (inRange(key, range)) matches.push({ rowid, values });
    }
    matches.sort((a, b) => {
      for (const c of index.columns) {
        const d = compareValues(a.values[c]!, b.values[c]!);
        if (d !== 0) return d;
      }
      return a.rowid - b.rowid;
    });
    yield* matches;
  }

  insert(table: TableSchema, values: Value[]): void {
    this.checkUnique(table, values, undefined);
    this.rows(table).set(this.nextRowId++, values);
  }

  update(table: TableSchema, rowid: number, _old: Value[], values: Value[]): void {
    this.checkUnique(table, values, rowid);
    this.rows(table).set(rowid, values);
  }

  delete(table: TableSchema, rowid: number): void {
    this.rows(table).delete(rowid);
  }

  rowCount(table: TableSchema): number {
    return this.tables.get(table.name)?.size ?? 0;
  }

  createTable(table: TableSchema): TableSchema {
    this.tables.set(table.name, new Map());
    return table;
  }

  dropTable(table: TableSchema): void {
    this.tables.delete(table.name);
  }

  createIndex(table: TableSchema, index: IndexSchema): IndexSchema {
    if (index.unique) {
      const seen = new Set<string>();
      for (const values of this.rows(table).values()) {
        const key: Value[] = index.columns.map((c) => values[c] ?? null);
        if (key.includes(null)) continue;
        const k = hashKey(key);
        if (seen.has(k)) throw uniqueViolation(table, index, key);
        seen.add(k);
      }
    }
    return index;
  }

  dropIndex(): void {}

  private checkUnique(table: TableSchema, values: Value[], self: number | undefined): void {
    for (const index of table.indexes) {
      if (!index.unique) continue;
      const key: Value[] = index.columns.map((c) => values[c] ?? null);
      if (key.includes(null)) continue;
      for (const [rowid, other] of this.rows(table)) {
        if (rowid === self) continue;
        if (index.columns.every((c, i) => compareValues(other[c]!, key[i]!) === 0)) {
          throw uniqueViolation(table, index, key);
        }
      }
    }
  }
}

function inRange(key: Value[], range: IndexRange): boolean {
  for (let i = 0; i < range.prefix.length; i++) {
    if (key[i] === null || compareValues(key[i]!, range.prefix[i]!) !== 0) return false;
  }
  const next = key[range.prefix.length];
  if (range.lower || range.upper) {
    if (next === null || next === undefined) return false;
    if (range.lower) {
      const c = compareValues(next, range.lower.value);
      if (c < 0 || (c === 0 && !range.lower.inclusive)) return false;
    }
    if (range.upper) {
      const c = compareValues(next, range.upper.value);
      if (c > 0 || (c === 0 && !range.upper.inclusive)) return false;
    }
  }
  return true;
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
