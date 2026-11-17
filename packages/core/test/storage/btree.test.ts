import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BTree, MAX_KEY_SIZE, compareBytes } from '../../src/storage/btree.ts';
import { MemoryFileSystem } from '../../src/storage/file.ts';
import { PAGE_SIZE, Pager } from '../../src/storage/pager.ts';
import { Wal } from '../../src/storage/wal.ts';
import {
  INTERNAL,
  LEAF,
  cellCount,
  cellKey,
  defragment,
  freeSpace,
  initNode,
  insertCell,
  removeCell,
} from '../../src/storage/slotted.ts';

function newPager(): Pager {
  const fs = new MemoryFileSystem();
  const pager = Pager.open(fs.open('db'), Wal.open(fs.open('db-wal')), { cachePages: 64 });
  pager.commit();
  return pager;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const k = (n: number) => enc.encode(String(n).padStart(8, '0'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('slotted pages', () => {
  it('keeps cells in slot order and reclaims space by defragmenting', () => {
    const pager = newPager();
    const page = pager.allocate();
    initNode(page, LEAF);
    const cell = (key: string, size: number) => {
      const c = new Uint8Array(4 + key.length + size);
      const v = new DataView(c.buffer);
      v.setUint16(0, key.length);
      v.setUint16(2, size);
      c.set(enc.encode(key), 4);
      return c;
    };
    expect(insertCell(page, 0, cell('b', 10))).toBe(true);
    expect(insertCell(page, 0, cell('a', 10))).toBe(true);
    expect(insertCell(page, 2, cell('c', 10))).toBe(true);
    expect([0, 1, 2].map((i) => dec.decode(cellKey(page, i)))).toEqual(['a', 'b', 'c']);

    // Fill the page, then free a middle cell: the hole is only usable after defragmenting.
    const big = cell('x', 1000);
    let n = 3;
    while (insertCell(page, n, big)) n++;
    const before = freeSpace(page);
    removeCell(page, 1);
    expect(freeSpace(page)).toBe(before + 17);
    defragment(page);
    expect(freeSpace(page)).toBe(before + 17);
    expect(cellCount(page)).toBe(n - 1);
    expect(dec.decode(cellKey(page, 1))).toBe('c');
  });
});

describe('BTree', () => {
  it('grows through many splits and scans in order', () => {
    const pager = newPager();
    const tree = new BTree(pager, BTree.create(pager));
    const keys = shuffle(Array.from({ length: 5000 }, (_, i) => i));
    for (const i of keys) tree.insert(k(i), enc.encode(`v${i}`));
    expect(pager.read(tree.root).data[0]).toBe(INTERNAL);
    const scanned = [...tree.scan()].map(([key]) => Number(dec.decode(key)));
    expect(scanned).toEqual(Array.from({ length: 5000 }, (_, i) => i));
    expect(dec.decode(tree.get(k(1234))!)).toBe('v1234');
    expect(tree.get(k(5000))).toBeUndefined();
  });

  it('scans half-open ranges', () => {
    const pager = newPager();
    const tree = new BTree(pager, BTree.create(pager));
    for (let i = 0; i < 1000; i += 2) tree.insert(k(i), new Uint8Array(0));
    const range = [...tree.keys(k(101), k(111))].map((key) => Number(dec.decode(key)));
    expect(range).toEqual([102, 104, 106, 108, 110]);
    expect([...tree.keys(k(990))].length).toBe(5);
    expect([...tree.keys(undefined, k(4))].length).toBe(2);
  });

  it('updates in place and through reinsertion when the size changes', () => {
    const pager = newPager();
    const tree = new BTree(pager, BTree.create(pager));
    tree.insert(k(1), enc.encode('aaaa'));
    tree.update(k(1), enc.encode('bbbb'));
    expect(dec.decode(tree.get(k(1))!)).toBe('bbbb');
    tree.update(k(1), enc.encode('a much longer value'));
    expect(dec.decode(tree.get(k(1))!)).toBe('a much longer value');
    expect(tree.delete(k(1))).toBe(true);
    expect(tree.delete(k(1))).toBe(false);
    expect(() => tree.update(k(1), new Uint8Array(1))).toThrow('missing key');
  });

  it('rejects duplicate and oversized keys', () => {
    const pager = newPager();
    const tree = new BTree(pager, BTree.create(pager));
    tree.insert(k(1), new Uint8Array(0));
    expect(() => tree.insert(k(1), new Uint8Array(0))).toThrow('duplicate key');
    expect(() => tree.insert(new Uint8Array(MAX_KEY_SIZE + 1), new Uint8Array(0))).toThrow(
      'exceeds the maximum',
    );
  });

  it('stores values larger than a page in overflow chains and frees them', () => {
    const pager = newPager();
    const tree = new BTree(pager, BTree.create(pager));
    const big = new Uint8Array(3 * PAGE_SIZE + 123).map((_, i) => i % 251);
    tree.insert(k(1), big);
    tree.insert(k(2), enc.encode('small'));
    expect(hex(tree.get(k(1))!)).toBe(hex(big));
    const pagesWithChain = pager.pageCount;
    tree.delete(k(1));
    expect(pager.freeCount).toBe(4);
    tree.insert(k(3), big);
    expect(pager.pageCount).toBe(pagesWithChain);
    expect(hex(tree.get(k(3))!)).toBe(hex(big));
  });

  it('keeps root metadata across root splits', () => {
    const pager = newPager();
    const tree = new BTree(pager, BTree.create(pager));
    expect(tree.allocateRowId()).toBe(1);
    expect(tree.allocateRowId()).toBe(2);
    tree.adjustCount(7);
    for (let i = 0; i < 2000; i++) tree.insert(k(i), enc.encode('x'.repeat(40)));
    expect(tree.count).toBe(7);
    expect(tree.allocateRowId()).toBe(3);
  });

  it('returns every page to the free list on destroy', () => {
    const pager = newPager();
    const tree = new BTree(pager, BTree.create(pager));
    for (let i = 0; i < 3000; i++) tree.insert(k(i), new Uint8Array(30));
    tree.insert(k(99999), new Uint8Array(PAGE_SIZE * 2));
    const used = pager.pageCount - 1;
    tree.destroy();
    expect(pager.freeCount).toBe(used);
  });

  it('behaves like a sorted map under random operations', () => {
    const key = fc.uint8Array({ minLength: 0, maxLength: 24 });
    const value = fc.oneof(
      { weight: 9, arbitrary: fc.uint8Array({ maxLength: 60 }) },
      { weight: 1, arbitrary: fc.uint8Array({ minLength: 1100, maxLength: 9000 }) },
    );
    const op = fc.oneof(
      fc.record({ kind: fc.constant('put' as const), key, value }),
      fc.record({ kind: fc.constant('del' as const), key }),
      fc.record({ kind: fc.constant('range' as const), lo: key, hi: key }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 400 }), (ops) => {
        const pager = newPager();
        const tree = new BTree(pager, BTree.create(pager));
        const model = new Map<string, Uint8Array>();
        for (const o of ops) {
          if (o.kind === 'put') {
            const id = hex(o.key);
            if (model.has(id)) tree.update(o.key, o.value);
            else tree.insert(o.key, o.value);
            model.set(id, o.value);
          } else if (o.kind === 'del') {
            expect(tree.delete(o.key)).toBe(model.delete(hex(o.key)));
          } else {
            const [lo, hi] = compareBytes(o.lo, o.hi) <= 0 ? [o.lo, o.hi] : [o.hi, o.lo];
            const expected = [...model.keys()]
              .map((h) => Uint8Array.from(Buffer.from(h, 'hex')))
              .filter((b) => compareBytes(b, lo) >= 0 && compareBytes(b, hi) < 0)
              .sort(compareBytes)
              .map(hex);
            expect([...tree.keys(lo, hi)].map(hex)).toEqual(expected);
          }
        }
        const all = [...tree.scan()];
        expect(all.map(([kk]) => hex(kk))).toEqual(
          [...model.keys()].sort((a, b) =>
            compareBytes(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')),
          ),
        );
        for (const [kk, v] of all) expect(hex(v)).toBe(hex(model.get(hex(kk))!));
      }),
      { numRuns: 60 },
    );
  });
});

/** Deterministic Fisher-Yates shuffle. */
function shuffle<T>(items: T[]): T[] {
  let seed = 42;
  for (let i = items.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}
