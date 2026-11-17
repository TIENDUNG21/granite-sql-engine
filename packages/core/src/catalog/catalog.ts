import { GraniteError } from '../errors.ts';
import type { Ident } from '../sql/ast.ts';
import type { IndexSchema, TableSchema } from './schema.ts';

/**
 * The in-memory view of the schema: tables and their indexes by name.
 * Names are stored as resolved by the parser (bare names are lower-case).
 * Persistence is the storage layer's job; this class only keeps the maps
 * consistent and raises the right errors.
 */
export class Catalog {
  private readonly tableMap = new Map<string, TableSchema>();
  /** Bumped on every schema change so cached plans can be invalidated. */
  version = 0;

  tables(): TableSchema[] {
    return [...this.tableMap.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  getTable(name: string): TableSchema | undefined {
    return this.tableMap.get(name);
  }

  requireTable(ident: Ident): TableSchema {
    const table = this.tableMap.get(ident.name);
    if (!table) {
      const hint = this.suggest(ident.name, [...this.tableMap.keys()]);
      throw new GraniteError('undefined_table', `table "${ident.name}" does not exist`, {
        span: ident.span,
        hint: hint ? `did you mean "${hint}"?` : undefined,
      });
    }
    return table;
  }

  findIndex(name: string): { table: TableSchema; index: IndexSchema } | undefined {
    for (const table of this.tableMap.values()) {
      const index = table.indexes.find((ix) => ix.name === name);
      if (index) return { table, index };
    }
    return undefined;
  }

  /** Insert or replace a table definition. */
  putTable(table: TableSchema): void {
    this.tableMap.set(table.name, table);
    this.version++;
  }

  removeTable(name: string): void {
    this.tableMap.delete(name);
    this.version++;
  }

  clear(): void {
    this.tableMap.clear();
    this.version++;
  }

  /** Closest name by edit distance, if it is close enough to be a typo. */
  suggest(name: string, candidates: Iterable<string>): string | undefined {
    let best: string | undefined;
    let bestDistance = Math.max(2, Math.floor(name.length / 3)) + 1;
    for (const candidate of candidates) {
      const d = editDistance(name, candidate);
      if (d < bestDistance) {
        best = candidate;
        bestDistance = d;
      }
    }
    return best;
  }
}

export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}
