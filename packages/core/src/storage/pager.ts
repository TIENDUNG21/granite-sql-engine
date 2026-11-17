import { GraniteError } from '../errors.ts';
import type { BlockFile } from './file.ts';

export const PAGE_SIZE = 4096;

/** A page in the buffer cache. `view` is a DataView over `data`. */
export interface Page {
  readonly no: number;
  readonly data: Uint8Array;
  readonly view: DataView;
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
  return { no, data, view: new DataView(data.buffer, data.byteOffset, data.byteLength) };
}

export interface PagerOptions {
  /** Maximum number of clean pages kept in memory. */
  readonly cachePages?: number;
}

/**
 * The pager hands out fixed-size pages, caches them, tracks which ones changed
 * and decides when they reach the file. Higher layers never touch the file.
 *
 * A statement runs inside an atomic section: the first time it modifies a page
 * the pager keeps the page's previous bytes, so a failed statement can be
 * undone by restoring them.
 */
export class Pager {
  /** Cached pages in least-recently-used order (Map iteration order). */
  private readonly cache = new Map<number, Page>();
  /** Pages modified since the last commit. */
  private readonly dirty = new Set<number>();
  private preImages: Map<number, { data: Uint8Array | undefined; wasDirty: boolean }> | undefined;
  private readonly capacity: number;
  readonly file: BlockFile;

  private constructor(file: BlockFile, options: PagerOptions) {
    this.file = file;
    this.capacity = Math.max(16, options.cachePages ?? 2048);
  }

  /** Open a database file, formatting it if it is empty. */
  static open(file: BlockFile, options: PagerOptions = {}): Pager {
    const pager = new Pager(file, options);
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
    return this.read(0).view.getUint32(offset);
  }

  setHeaderU32(offset: number, value: number): void {
    this.write(0).view.setUint32(offset, value);
  }

  // ---------------------------------------------------------------- pages

  /** A page for reading. Do not modify the returned bytes. */
  read(no: number): Page {
    const cached = this.cache.get(no);
    if (cached) {
      // Refresh LRU position.
      this.cache.delete(no);
      this.cache.set(no, cached);
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
    this.cache.set(no, page);
    this.evict();
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

  private evict(): void {
    if (this.cache.size <= this.capacity) return;
    for (const no of this.cache.keys()) {
      if (this.cache.size <= this.capacity) break;
      if (no === 0 || this.dirty.has(no)) continue;
      this.cache.delete(no);
    }
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

  /** Write every dirty page to the file and fsync it. */
  commit(): void {
    if (this.preImages) throw new GraniteError('internal_error', 'commit inside an atomic section');
    if (this.dirty.size === 0) return;
    for (const no of this.dirtyPages()) {
      this.file.write(no * PAGE_SIZE, this.cache.get(no)!.data);
    }
    this.file.sync();
    this.dirty.clear();
    this.evict();
  }

  close(): void {
    this.commit();
    this.file.close();
  }
}
