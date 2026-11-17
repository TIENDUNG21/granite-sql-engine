import { GraniteError } from '../errors.ts';
import type { BlockFile } from './file.ts';
import type { Wal } from './wal.ts';

export const PAGE_SIZE = 4096;

/** A page in the buffer cache. `view` is a DataView over `data`. */
export interface Page {
  readonly no: number;
  readonly data: Uint8Array;
  readonly view: DataView;
  /** Pager clock value of the last access, for eviction. */
  used: number;
}

/**
 * Layout of page 0, the database header. All integers are big-endian.
 */
export const HEADER = {
  magic: 0, // 8 bytes "GRANITE\0"
  version: 8, // u16
  pageSize: 10, // u16
  pageCount: 12, // u32
  freeHead: 16, // u32, first page of the free list (0 = empty)
  freeCount: 20, // u32
  nextXid: 24, // u32, next transaction id
  clogCount: 28, // u16, number of commit-log pages
  clogDir: 64, // u32[], page numbers of the commit-log pages
} as const;

export const MAGIC = new TextEncoder().encode('GRANITE\0');
export const FORMAT_VERSION = 1;
/** Free pages store the next free page here. */
const FREE_NEXT = 8;
export const PAGE_TYPE_FREE = 4;

function makePage(no: number, data: Uint8Array): Page {
  return { no, data, view: new DataView(data.buffer, data.byteOffset, data.byteLength), used: 0 };
}

export interface PagerOptions {
  /** Pages kept in memory between statements (dirty and unflushed pages always stay). */
  readonly cachePages?: number;
  /** Checkpoint once the write-ahead log grows beyond this many bytes. */
  readonly checkpointBytes?: number;
}

/**
 * The pager hands out fixed-size pages, caches them, tracks which ones changed
 * and decides when they reach the file. Higher layers never touch the file.
 *
 * Durability follows the write-ahead rule: a commit appends the images of the
 * changed pages to the log and fsyncs it; the data file is only updated by a
 * checkpoint, after which the log is emptied.
 *
 * A statement runs inside an atomic section: the first time it modifies a page
 * the pager keeps the page's previous bytes, so a failed statement can be
 * undone by restoring them.
 */
export class Pager {
  /** Cached pages; each remembers when it was last used. */
  private readonly cache = new Map<number, Page>();
  /** Advances on every page access. */
  private clock = 0;
  /** Pages modified since the last commit. */
  private readonly dirty = new Set<number>();
  /** Pages committed to the log but not yet written to the data file. */
  private readonly unflushed = new Set<number>();
  private preImages: Map<number, { data: Uint8Array | undefined; wasDirty: boolean }> | undefined;
  private readonly capacity: number;
  private readonly checkpointBytes: number;
  readonly file: BlockFile;
  readonly wal: Wal;
  /** Number of checkpoints since the pager was opened. */
  checkpoints = 0;

  private constructor(file: BlockFile, wal: Wal, options: PagerOptions) {
    this.file = file;
    this.wal = wal;
    this.capacity = Math.max(16, options.cachePages ?? 2048);
    this.checkpointBytes = options.checkpointBytes ?? 4 * 1024 * 1024;
  }

  /** Open a database file, formatting it if it is empty. Recovery must already have run. */
  static open(file: BlockFile, wal: Wal, options: PagerOptions = {}): Pager {
    const pager = new Pager(file, wal, options);
    if (file.size() === 0) pager.format();
    else pager.validate();
    return pager;
  }

  private format(): void {
    const header = makePage(0, new Uint8Array(PAGE_SIZE));
    header.data.set(MAGIC, HEADER.magic);
    header.view.setUint16(HEADER.version, FORMAT_VERSION);
    header.view.setUint16(HEADER.pageSize, PAGE_SIZE);
    header.view.setUint32(HEADER.pageCount, 1);
    header.view.setUint32(HEADER.nextXid, 1);
    this.cache.set(0, header);
    this.dirty.add(0);
  }

  private validate(): void {
    const size = this.file.size();
    const raw = this.file.read(0, PAGE_SIZE);
    const corrupt = (why: string) =>
      new GraniteError('corrupt_database', `not a Granite database file: ${why}`);
    if (raw.length < PAGE_SIZE) throw corrupt('file is shorter than one page');
    for (let i = 0; i < MAGIC.length; i++)
      if (raw[i] !== MAGIC[i]) throw corrupt('bad magic number');
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const version = view.getUint16(HEADER.version);
    if (version !== FORMAT_VERSION) throw corrupt(`unsupported format version ${version}`);
    if (view.getUint16(HEADER.pageSize) !== PAGE_SIZE) throw corrupt('unexpected page size');
    const count = view.getUint32(HEADER.pageCount);
    if (count < 1 || count * PAGE_SIZE > size) {
      throw corrupt(`header says ${count} pages but the file has ${Math.floor(size / PAGE_SIZE)}`);
    }
    this.cache.set(0, makePage(0, raw));
  }

  // --------------------------------------------------------------- header

  get pageCount(): number {
    return this.read(0).view.getUint32(HEADER.pageCount);
  }

  headerU32(offset: number): number {
    // Page 0 is always cached and never evicted.
    return this.cache.get(0)!.view.getUint32(offset);
  }

  setHeaderU32(offset: number, value: number): void {
    this.write(0).view.setUint32(offset, value);
  }

  // ---------------------------------------------------------------- pages

  /** A page for reading. Do not modify the returned bytes. */
  read(no: number): Page {
    const cached = this.cache.get(no);
    if (cached) {
      // A counter instead of reordering the map: reads are the hottest path in the engine.
      cached.used = ++this.clock;
      return cached;
    }
    if (no < 0 || !Number.isInteger(no)) {
      throw new GraniteError('internal_error', `invalid page number ${no}`);
    }
    const count = this.cache.get(0)!.view.getUint32(HEADER.pageCount);
    if (no >= count)
      throw new GraniteError(
        'corrupt_database',
        `page ${no} is beyond the end of the database (${count} pages)`,
      );
    const raw = this.file.read(no * PAGE_SIZE, PAGE_SIZE);
    const data = new Uint8Array(PAGE_SIZE);
    data.set(raw);
    const page = makePage(no, data);
    page.used = ++this.clock;
    // No eviction here: callers may still hold pages they read earlier in the
    // statement, so the cache only shrinks between statements (see commit).
    this.cache.set(no, page);
    return page;
  }

  /** A page for writing: marks it dirty and remembers its old bytes for rollback. */
  write(no: number): Page {
    const page = this.read(no);
    if (this.preImages && !this.preImages.has(no)) {
      this.preImages.set(no, { data: page.data.slice(), wasDirty: this.dirty.has(no) });
    }
    this.dirty.add(no);
    return page;
  }

  /** A fresh zeroed page, reused from the free list when possible. */
  allocate(): Page {
    const head = this.headerU32(HEADER.freeHead);
    if (head !== 0) {
      const page = this.write(head);
      const next = page.view.getUint32(FREE_NEXT);
      this.setHeaderU32(HEADER.freeHead, next);
      this.setHeaderU32(HEADER.freeCount, this.headerU32(HEADER.freeCount) - 1);
      page.data.fill(0);
      return page;
    }
    const no = this.pageCount;
    this.setHeaderU32(HEADER.pageCount, no + 1);
    const page = makePage(no, new Uint8Array(PAGE_SIZE));
    if (this.preImages && !this.preImages.has(no))
      this.preImages.set(no, { data: undefined, wasDirty: false });
    this.cache.set(no, page);
    this.dirty.add(no);
    return page;
  }

  /** Return a page to the free list. */
  free(no: number): void {
    if (no === 0) throw new GraniteError('internal_error', 'cannot free the header page');
    const page = this.write(no);
    page.data.fill(0);
    page.data[0] = PAGE_TYPE_FREE;
    page.view.setUint32(FREE_NEXT, this.headerU32(HEADER.freeHead));
    this.setHeaderU32(HEADER.freeHead, no);
    this.setHeaderU32(HEADER.freeCount, this.headerU32(HEADER.freeCount) + 1);
  }

  get freeCount(): number {
    return this.headerU32(HEADER.freeCount);
  }

  /**
   * Drop the least recently used clean pages once the cache is over capacity,
   * down to 90% of it so that the sort is paid for rarely. Dirty pages and pages
   * not yet checkpointed must stay: the data file does not have their contents.
   */
  private evict(): void {
    if (this.cache.size <= this.capacity) return;
    const clean: Page[] = [];
    for (const page of this.cache.values()) {
      if (page.no !== 0 && !this.dirty.has(page.no) && !this.unflushed.has(page.no))
        clean.push(page);
    }
    clean.sort((a, b) => a.used - b.used);
    const excess = this.cache.size - Math.floor(this.capacity * 0.9);
    for (const page of clean.slice(0, excess)) this.cache.delete(page.no);
  }

  // ------------------------------------------------------ atomic sections

  get inAtomic(): boolean {
    return this.preImages !== undefined;
  }

  beginAtomic(): void {
    if (this.preImages) throw new GraniteError('internal_error', 'atomic sections do not nest');
    this.preImages = new Map();
  }

  /** Keep the changes made since beginAtomic. */
  endAtomic(): void {
    this.preImages = undefined;
  }

  /** Undo every page change made since beginAtomic. */
  abortAtomic(): void {
    const images = this.preImages;
    this.preImages = undefined;
    if (!images) return;
    for (const [no, image] of images) {
      if (image.data === undefined) {
        this.cache.delete(no);
        this.dirty.delete(no);
        continue;
      }
      this.cache.set(no, makePage(no, image.data));
      if (!image.wasDirty) this.dirty.delete(no);
    }
  }

  // ----------------------------------------------------------- durability

  /** Pages changed since the last commit, in page order. */
  dirtyPages(): number[] {
    return [...this.dirty].sort((a, b) => a - b);
  }

  /**
   * Make every change so far durable: one commit group in the write-ahead log.
   * Every statement ends here, so this is also where the cache is trimmed back
   * to its capacity.
   */
  commit(): void {
    if (this.preImages) throw new GraniteError('internal_error', 'commit inside an atomic section');
    if (this.dirty.size > 0) {
      this.flushToLog();
      if (this.wal.size >= this.checkpointBytes) this.checkpoint();
    }
    this.evict();
  }

  private flushToLog(): void {
    if (this.dirty.size === 0) return;
    const pages = this.dirtyPages().map((no) => ({ no, data: this.cache.get(no)!.data }));
    this.wal.appendGroup(pages);
    for (const no of this.dirty) this.unflushed.add(no);
    this.dirty.clear();
  }

  /**
   * Copy every logged page to the data file, fsync it, then empty the log.
   * A crash at any point leaves either the old log (replayed again, which is
   * harmless because page images are idempotent) or a synced data file.
   */
  checkpoint(): void {
    if (this.preImages)
      throw new GraniteError('internal_error', 'checkpoint inside an atomic section');
    this.flushToLog();
    if (this.unflushed.size === 0) return;
    for (const no of [...this.unflushed].sort((a, b) => a - b)) {
      this.file.write(no * PAGE_SIZE, this.cache.get(no)!.data);
    }
    this.file.sync();
    this.wal.reset();
    this.unflushed.clear();
    this.checkpoints++;
    this.evict();
  }

  close(): void {
    this.checkpoint();
    this.file.close();
    this.wal.close();
  }
}
