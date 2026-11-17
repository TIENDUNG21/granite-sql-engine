import type { DataType, Value } from '../types/datatype.ts';

export interface ColumnSchema {
  readonly name: string;
  readonly type: DataType;
  readonly notNull: boolean;
  /** Constant default, already coerced to the column type. */
  readonly default: Value;
}

export interface IndexSchema {
  readonly name: string;
  readonly table: string;
  /** Positions of the indexed columns in the table. */
  readonly columns: readonly number[];
  readonly unique: boolean;
  /** True for the index that enforces the PRIMARY KEY. */
  readonly primary: boolean;
  /** Root page of the index B+tree (0 while the engine has no paged storage). */
  readonly rootPage: number;
}

export interface ColumnStats {
  /** Number of distinct non-null values. */
  readonly distinct: number;
  /** Fraction of rows where the column is NULL. */
  readonly nullFraction: number;
  readonly min: Value;
  readonly max: Value;
}

export interface TableStats {
  readonly rowCount: number;
  readonly columns: readonly ColumnStats[];
}

export interface TableSchema {
  readonly name: string;
  readonly columns: readonly ColumnSchema[];
  /** Root page of the table B+tree (rows keyed by an internal row id). */
  readonly rootPage: number;
  readonly indexes: readonly IndexSchema[];
  /** Statistics collected by ANALYZE, if it ran. */
  readonly stats: TableStats | undefined;
}

export function columnIndex(table: TableSchema, name: string): number {
  return table.columns.findIndex((c) => c.name === name);
}

/** Render a CREATE TABLE statement for a schema (used by .schema and Studio). */
export function describeTable(table: TableSchema): string {
  const pk = table.indexes.find((ix) => ix.primary);
  const lines = table.columns.map((c, i) => {
    let line = `  ${quoteIdent(c.name)} ${c.type}`;
    if (pk && pk.columns.length === 1 && pk.columns[0] === i) line += ' PRIMARY KEY';
    else if (c.notNull) line += ' NOT NULL';
    if (c.default !== null) line += ` DEFAULT ${literal(c.default)}`;
    return line;
  });
  if (pk && pk.columns.length > 1) {
    lines.push(
      `  PRIMARY KEY (${pk.columns.map((i) => quoteIdent(table.columns[i]!.name)).join(', ')})`,
    );
  }
  const out = [`CREATE TABLE ${quoteIdent(table.name)} (\n${lines.join(',\n')}\n);`];
  for (const ix of table.indexes) {
    if (ix.primary) continue;
    const cols = ix.columns.map((i) => quoteIdent(table.columns[i]!.name)).join(', ');
    out.push(
      `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(ix.name)} ON ${quoteIdent(table.name)} (${cols});`,
    );
  }
  return out.join('\n');
}

/** Quote an identifier only when it would not survive as a bare word. */
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

function literal(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return `'${v.replaceAll("'", "''")}'`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}
