import type { TableSchema } from '../catalog/schema.ts';
import { GraniteError } from '../errors.ts';
import { BTree } from './btree.ts';
import type { FileSystem } from './file.ts';
import { Pager } from './pager.ts';
import { PagedRowStore } from './table-store.ts';

/** The catalog B+tree always lives on page 1. */
export const CATALOG_ROOT = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface StorageOptions {
  readonly cachePages?: number;
}

/**
 * Owns the database file: the pager, the row store and the catalog tree that
 * maps table names to their JSON-encoded schemas.
 */
export class StorageEngine {
  readonly pager: Pager;
  readonly rows: PagedRowStore;
  private readonly catalogTree: BTree;

  private constructor(pager: Pager) {
    this.pager = pager;
    this.rows = new PagedRowStore(pager);
    this.catalogTree = new BTree(pager, CATALOG_ROOT);
  }

  static open(fs: FileSystem, path: string, options: StorageOptions = {}): StorageEngine {
    const pager = Pager.open(fs.open(path), { cachePages: options.cachePages });
    if (pager.pageCount === 1) {
      const root = BTree.create(pager);
      if (root !== CATALOG_ROOT)
        throw new GraniteError('internal_error', 'catalog root must be page 1');
      pager.commit();
    }
    return new StorageEngine(pager);
  }

  loadCatalog(): TableSchema[] {
    const tables: TableSchema[] = [];
    for (const [, value] of this.catalogTree.scan()) {
      try {
        tables.push(JSON.parse(decoder.decode(value)) as TableSchema);
      } catch (err) {
        throw new GraniteError('corrupt_database', 'unreadable catalog entry', { cause: err });
      }
    }
    return tables;
  }

  putTable(table: TableSchema): void {
    const key = encoder.encode(table.name);
    const value = encoder.encode(JSON.stringify(table));
    if (this.catalogTree.get(key)) this.catalogTree.update(key, value);
    else this.catalogTree.insert(key, value);
  }

  removeTable(name: string): void {
    this.catalogTree.delete(encoder.encode(name));
  }

  /**
   * Run `fn` as one atomic unit: either all of its page changes are kept and
   * committed, or none are.
   */
  atomic<T>(fn: () => T): T {
    this.pager.beginAtomic();
    let result: T;
    try {
      result = fn();
    } catch (err) {
      this.pager.abortAtomic();
      throw err;
    }
    this.pager.endAtomic();
    this.pager.commit();
    return result;
  }

  close(): void {
    this.pager.close();
  }
}
