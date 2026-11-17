import { describe, expect, it } from 'vitest';
import { GraniteError } from '../../src/errors.ts';
import { MemoryFileSystem } from '../../src/storage/file.ts';
import { HEADER, PAGE_SIZE, Pager } from '../../src/storage/pager.ts';
import { Wal } from '../../src/storage/wal.ts';

function open(fs: MemoryFileSystem, name = 'db', cachePages?: number): Pager {
  return Pager.open(fs.open(name), Wal.open(fs.open(`${name}-wal`)), { cachePages });
}

function fresh(cachePages?: number): { fs: MemoryFileSystem; pager: Pager } {
  const fs = new MemoryFileSystem();
  const pager = open(fs, 'db', cachePages);
  pager.checkpoint();
  return { fs, pager };
}

describe('Pager', () => {
  it('logs commits to the WAL and only writes the data file at checkpoints', () => {
    const { fs, pager } = fresh();
    pager.allocate().data[7] = 7;
    pager.commit();
    expect(fs.contents('db').length).toBe(PAGE_SIZE);
    expect(pager.wal.size).toBeGreaterThan(2 * PAGE_SIZE);
    pager.checkpoint();
    expect(fs.contents('db').length).toBe(2 * PAGE_SIZE);
    expect(fs.contents('db')[PAGE_SIZE + 7]).toBe(7);
    expect(pager.wal.size).toBe(16);
  });

  it('formats an empty file with a header page', () => {
    const { fs, pager } = fresh();
    expect(pager.pageCount).toBe(1);
    const file = fs.contents('db');
    expect(file.length).toBe(PAGE_SIZE);
    expect(new TextDecoder().decode(file.subarray(0, 7))).toBe('GRANITE');
  });

  it('allocates new pages and persists them on commit', () => {
    const { fs, pager } = fresh();
    const p = pager.allocate();
    expect(p.no).toBe(1);
    p.data[100] = 42;
    pager.checkpoint();
    const reopened = open(fs);
    expect(reopened.pageCount).toBe(2);
    expect(reopened.read(1).data[100]).toBe(42);
  });

  it('reuses freed pages before growing the file', () => {
    const { pager } = fresh();
    const a = pager.allocate().no;
    const b = pager.allocate().no;
    pager.free(a);
    expect(pager.freeCount).toBe(1);
    const c = pager.allocate();
    expect(c.no).toBe(a);
    expect(c.data.every((x) => x === 0)).toBe(true);
    expect(pager.freeCount).toBe(0);
    expect(pager.allocate().no).toBe(b + 1);
  });

  it('undoes page writes, allocations and frees when an atomic section aborts', () => {
    const { pager } = fresh();
    const keep = pager.allocate();
    keep.data[0] = 7;
    pager.commit();

    pager.beginAtomic();
    pager.write(keep.no).data[0] = 99;
    const extra = pager.allocate().no;
    pager.free(keep.no);
    expect(pager.pageCount).toBe(3);
    pager.abortAtomic();

    expect(pager.pageCount).toBe(2);
    expect(pager.freeCount).toBe(0);
    expect(pager.read(keep.no).data[0]).toBe(7);
    expect(() => pager.read(extra)).toThrow(GraniteError);
    expect(pager.dirtyPages()).toEqual([]);
  });

  it('keeps pages that were already dirty before the section dirty after abort', () => {
    const { pager } = fresh();
    const p = pager.allocate();
    p.data[1] = 1;
    pager.beginAtomic();
    pager.write(p.no).data[1] = 2;
    pager.abortAtomic();
    expect(pager.read(p.no).data[1]).toBe(1);
    expect(pager.dirtyPages()).toContain(p.no);
  });

  it('keeps changes when the section ends normally', () => {
    const { pager } = fresh();
    pager.beginAtomic();
    pager.allocate().data[5] = 5;
    pager.endAtomic();
    expect(pager.pageCount).toBe(2);
    expect(() => pager.beginAtomic()).not.toThrow();
    expect(() => pager.beginAtomic()).toThrow('atomic sections do not nest');
  });

  it('evicts clean pages but never dirty ones', () => {
    const { pager } = fresh(16);
    const nos: number[] = [];
    for (let i = 0; i < 40; i++) {
      const p = pager.allocate();
      p.data[0] = i;
      nos.push(p.no);
    }
    pager.checkpoint();
    for (const no of nos) pager.read(no);
    nos.forEach((no, i) => expect(pager.read(no).data[0]).toBe(i));
  });

  it('rejects files that are not Granite databases', () => {
    const fs = new MemoryFileSystem();
    fs.open('bad').write(0, new TextEncoder().encode('SQLite format 3\0'.padEnd(PAGE_SIZE, '\0')));
    expect(() => open(fs, 'bad')).toThrow('not a Granite database file: bad magic number');
    fs.open('short').write(0, new Uint8Array(10));
    expect(() => open(fs, 'short')).toThrow('shorter than one page');
  });

  it('rejects a header that claims more pages than the file has', () => {
    const { fs, pager } = fresh();
    pager.setHeaderU32(HEADER.pageCount, 50);
    pager.checkpoint();
    expect(() => open(fs)).toThrow('header says 50 pages');
  });
});
