import type { TableSchema } from '../catalog/schema.ts';
import { GraniteError } from '../errors.ts';
import { BTree } from './btree.ts';
import type { FileSystem } from './file.ts';
import { PAGE_SIZE, Pager } from './pager.ts';
import { WAL_HEADER_SIZE, Wal, type RecoveryReport } from './wal.ts';

/** The catalog B+tree always lives on page 1. */
export const CATALOG_ROOT = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface StorageOptions {
  readonly cachePages?: number;
  readonly checkpointBytes?: number;
}

/**
 * Owns the database file: the pager, the write-ahead log and the catalog tree that
 * maps table names to their JSON-encoded schemas.
 */
export class StorageEngine {
  readonly pager: Pager;
  /** What crash recovery found when the database was opened. */
  readonly recovery: RecoveryReport;
  private readonly catalogTree: BTree;

  private constructor(pager: Pager, recovery: RecoveryReport) {
    this.pager = pager;
    this.recovery = recovery;
    this.catalogTree = new BTree(pager, CATALOG_ROOT);
  }

  /**
   * Open (or create) a database: replay the write-ahead log into the data file,
   * then start the pager on the recovered file.
   */
  static open(fs: FileSystem, path: string, options: StorageOptions = {}): StorageEngine {
    const data = fs.open(path);
    const wal = Wal.open(fs.open(`${path}-wal`), { newDatabase: data.size() === 0 });
    const recovery = wal.recover((page, image) => data.write(page * PAGE_SIZE, image));
    if (recovery.groups > 0) data.sync();
    if (wal.size > WAL_HEADER_SIZE) wal.reset();
    const pager = Pager.open(data, wal, options);
    if (pager.pageCount === 1) {
      const root = BTree.create(pager);
      if (root !== CATALOG_ROOT)
        throw new GraniteError('internal_error', 'catalog root must be page 1');
      // Commit through the log first, so a crash while formatting is recoverable.
      pager.commit();
      pager.checkpoint();
    }
    return new StorageEngine(pager, recovery);
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
