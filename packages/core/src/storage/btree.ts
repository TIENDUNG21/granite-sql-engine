import { GraniteError } from '../errors.ts';
import { PAGE_SIZE, type Page, type Pager } from './pager.ts';
import {
  INTERNAL,
  LEAF,
  NODE,
  OVERFLOW_FLAG,
  bytesNeeded,
  cellBytes,
  cellChild,
  cellCount,
  cellKey,
  cellOffset,
  initNode,
  insertCell,
  nodeType,
  removeCell,
  rewriteNode,
  rightPointer,
} from './slotted.ts';

/** Longest key a B+tree accepts; keeps at least four cells in every node. */
export const MAX_KEY_SIZE = 1000;
/** Cells larger than this move their value to an overflow chain. */
const MAX_LOCAL_CELL = Math.floor((PAGE_SIZE - NODE.slots) / 4) - 2;
const PAGE_TYPE_OVERFLOW = 3;
const OVERFLOW_NEXT = 8;
const OVERFLOW_DATA = 16;
const OVERFLOW_CAPACITY = PAGE_SIZE - OVERFLOW_DATA;

/** Lexicographic byte comparison (memcmp order). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

interface Split {
  /** Page that kept the lower half. */
  readonly left: number;
  /** New page holding the upper half. */
  readonly right: number;
  /** Smallest key of the upper half. */
  readonly separator: Uint8Array;
}

/**
 * A B+tree mapping byte-string keys to byte-string values, stored in slotted
 * pages. Leaves are chained left to right for range scans. The root page never
 * moves, so a tree is identified by its root page number for its whole life.
 *
 * Deletes do not merge underfull nodes (like many production B-trees); space
 * comes back when a node empties out and is reused by later inserts.
 */
export class BTree {
  readonly pager: Pager;
  readonly root: number;

  constructor(pager: Pager, root: number) {
    this.pager = pager;
    this.root = root;
  }

  /** Allocate an empty tree and return its root page number. */
  static create(pager: Pager): number {
    const page = pager.allocate();
    initNode(page, LEAF);
    return page.no;
  }

  // ------------------------------------------------------------- lookups

  private findLeaf(key: Uint8Array, path?: { no: number; index: number }[]): Page {
    let page = this.pager.read(this.root);
    while (nodeType(page) === INTERNAL) {
      const index = childIndex(page, key);
      path?.push({ no: page.no, index });
      page = this.pager.read(childAt(page, index));
    }
    return page;
  }

  get(key: Uint8Array): Uint8Array | undefined {
    const leaf = this.findLeaf(key);
    const pos = lowerBound(leaf, key);
    if (pos < cellCount(leaf) && compareBytes(cellKey(leaf, pos), key) === 0)
      return this.readValue(leaf, pos);
    return undefined;
  }

  /**
   * Entries with lower <= key < upper, in key order. Keys and values are copies.
   */
  *scan(lower?: Uint8Array, upper?: Uint8Array): Generator<[Uint8Array, Uint8Array]> {
    for (const [leaf, i] of this.positions(lower, upper)) {
      yield [cellKey(leaf, i).slice(), this.readValue(leaf, i)];
    }
  }

  /** Keys with lower <= key < upper, without reading values. */
  *keys(lower?: Uint8Array, upper?: Uint8Array): Generator<Uint8Array> {
    for (const [leaf, i] of this.positions(lower, upper)) yield cellKey(leaf, i).slice();
  }

  private *positions(lower?: Uint8Array, upper?: Uint8Array): Generator<[Page, number]> {
    let page = this.pager.read(this.root);
    while (nodeType(page) === INTERNAL) {
      page = this.pager.read(childAt(page, lower ? childIndex(page, lower) : 0));
    }
    let i = lower ? lowerBound(page, lower) : 0;
    while (true) {
      const count = cellCount(page);
      for (; i < count; i++) {
        if (upper && compareBytes(cellKey(page, i), upper) >= 0) return;
        yield [page, i];
      }
      const next = rightPointer(page);
      if (next === 0) return;
      page = this.pager.read(next);
      i = 0;
    }
  }

  // ------------------------------------------------------------- updates

  insert(key: Uint8Array, value: Uint8Array): void {
    if (key.length > MAX_KEY_SIZE) {
      throw new GraniteError(
        'program_limit_exceeded',
        `key of ${key.length} bytes exceeds the maximum of ${MAX_KEY_SIZE}`,
      );
    }
    const path: { no: number; index: number }[] = [];
    const found = this.findLeaf(key, path);
    const pos = lowerBound(found, key);
    if (pos < cellCount(found) && compareBytes(cellKey(found, pos), key) === 0) {
      throw new GraniteError('internal_error', 'duplicate key in B+tree insert');
    }
    const cell = this.makeLeafCell(key, value);
    const leaf = this.pager.write(found.no);
    if (insertCell(leaf, pos, cell)) return;

    const cells = allCells(leaf);
    cells.splice(pos, 0, cell);
    let split: Split | undefined = this.splitLeaf(leaf, cells);
    while (split) {
      const parentRef = path.pop();
      if (!parentRef) {
        this.growRoot(split);
        return;
      }
      split = this.insertSeparator(parentRef.no, parentRef.index, split);
    }
  }

  /** Replace the value of an existing key (in place when the size allows). */
  update(key: Uint8Array, value: Uint8Array): void {
    const found = this.findLeaf(key);
    const pos = lowerBound(found, key);
    if (pos >= cellCount(found) || compareBytes(cellKey(found, pos), key) !== 0) {
      throw new GraniteError('internal_error', 'B+tree update of a missing key');
    }
    const offset = cellOffset(found, pos);
    const valLen = found.view.getUint16(offset + 2);
    if (!(valLen & OVERFLOW_FLAG) && valLen === value.length) {
      const page = this.pager.write(found.no);
      page.data.set(value, offset + 4 + key.length);
      return;
    }
    this.delete(key);
    this.insert(key, value);
  }

  delete(key: Uint8Array): boolean {
    const found = this.findLeaf(key);
    const pos = lowerBound(found, key);
    if (pos >= cellCount(found) || compareBytes(cellKey(found, pos), key) !== 0) return false;
    const leaf = this.pager.write(found.no);
    const offset = cellOffset(leaf, pos);
    if (leaf.view.getUint16(offset + 2) & OVERFLOW_FLAG) {
      this.freeOverflow(leaf.view.getUint32(offset + 4 + leaf.view.getUint16(offset) + 4));
    }
    removeCell(leaf, pos);
    return true;
  }

  /** Free every page of the tree, including the root. */
  destroy(): void {
    const stack = [this.root];
    while (stack.length > 0) {
      const page = this.pager.read(stack.pop()!);
      const count = cellCount(page);
      if (nodeType(page) === INTERNAL) {
        for (let i = 0; i < count; i++) stack.push(cellChild(page, i));
        stack.push(rightPointer(page));
      } else {
        for (let i = 0; i < count; i++) {
          const offset = cellOffset(page, i);
          if (page.view.getUint16(offset + 2) & OVERFLOW_FLAG) {
            this.freeOverflow(page.view.getUint32(offset + 4 + page.view.getUint16(offset) + 4));
          }
        }
      }
      this.pager.free(page.no);
    }
  }

  // ------------------------------------------------------- root metadata

  /** Tuple count kept on the root page by the table layer. */
  get count(): number {
    return this.pager.read(this.root).view.getUint32(NODE.metaCount);
  }

  adjustCount(delta: number): void {
    const page = this.pager.write(this.root);
    page.view.setUint32(NODE.metaCount, Math.max(0, page.view.getUint32(NODE.metaCount) + delta));
  }

  /** Hand out the next row id of a table tree. */
  allocateRowId(): number {
    const page = this.pager.write(this.root);
    const next = page.view.getFloat64(NODE.metaNextRowId) || 1;
    page.view.setFloat64(NODE.metaNextRowId, next + 1);
    return next;
  }

  // ----------------------------------------------------------- splitting

  private splitLeaf(leaf: Page, cells: Uint8Array[]): Split {
    const m = splitPoint(cells);
    const right = this.pager.allocate();
    rewriteNode(right, LEAF, cells.slice(m), rightPointer(leaf));
    rewriteNode(leaf, LEAF, cells.slice(0, m), right.no);
    return { left: leaf.no, right: right.no, separator: leafCellKey(cells[m]!) };
  }

  /** Put (left, separator) into the parent; returns a split if the parent overflowed. */
  private insertSeparator(parentNo: number, index: number, split: Split): Split | undefined {
    const parent = this.pager.write(parentNo);
    const cells = allCells(parent);
    let right = rightPointer(parent);
    const separatorCell = internalCell(split.left, split.separator);
    if (index === cells.length) {
      cells.push(separatorCell);
      right = split.right;
    } else {
      const moved = cells[index]!.slice();
      new DataView(moved.buffer).setUint32(0, split.right);
      cells[index] = moved;
      cells.splice(index, 0, separatorCell);
    }
    if (bytesNeeded(cells) <= PAGE_SIZE) {
      rewriteNode(parent, INTERNAL, cells, right);
      return undefined;
    }
    const m = splitPoint(cells);
    const middle = cells[m]!;
    const middleView = new DataView(middle.buffer, middle.byteOffset, middle.byteLength);
    const sibling = this.pager.allocate();
    rewriteNode(sibling, INTERNAL, cells.slice(m + 1), right);
    rewriteNode(parent, INTERNAL, cells.slice(0, m), middleView.getUint32(0));
    return {
      left: parent.no,
      right: sibling.no,
      separator: middle.slice(6, 6 + middleView.getUint16(4)),
    };
  }

  /** The root split: move its lower half to a new page and make the root internal. */
  private growRoot(split: Split): void {
    const root = this.pager.write(this.root);
    const lower = this.pager.allocate();
    lower.data.set(root.data);
    lower.view.setUint32(NODE.metaCount, 0);
    lower.view.setFloat64(NODE.metaNextRowId, 0);
    rewriteNode(root, INTERNAL, [internalCell(lower.no, split.separator)], split.right);
  }

  // ------------------------------------------------------------- values

  private makeLeafCell(key: Uint8Array, value: Uint8Array): Uint8Array {
    const local = 4 + key.length + value.length <= MAX_LOCAL_CELL;
    const cell = new Uint8Array(4 + key.length + (local ? value.length : 8));
    const view = new DataView(cell.buffer);
    view.setUint16(0, key.length);
    cell.set(key, 4);
    if (local) {
      view.setUint16(2, value.length);
      cell.set(value, 4 + key.length);
    } else {
      view.setUint16(2, OVERFLOW_FLAG);
      view.setUint32(4 + key.length, value.length);
      view.setUint32(4 + key.length + 4, this.writeOverflow(value));
    }
    return cell;
  }

  private readValue(page: Page, index: number): Uint8Array {
    const offset = cellOffset(page, index);
    const keyLen = page.view.getUint16(offset);
    const valLen = page.view.getUint16(offset + 2);
    const start = offset + 4 + keyLen;
    if (!(valLen & OVERFLOW_FLAG)) return page.data.slice(start, start + valLen);
    const total = page.view.getUint32(start);
    const out = new Uint8Array(total);
    let next = page.view.getUint32(start + 4);
    let filled = 0;
    while (filled < total) {
      if (next === 0) throw new GraniteError('corrupt_database', 'overflow chain ends early');
      const chunk = this.pager.read(next);
      const n = Math.min(OVERFLOW_CAPACITY, total - filled);
      out.set(chunk.data.subarray(OVERFLOW_DATA, OVERFLOW_DATA + n), filled);
      filled += n;
      next = chunk.view.getUint32(OVERFLOW_NEXT);
    }
    return out;
  }

  private writeOverflow(value: Uint8Array): number {
    const chunks = Math.ceil(value.length / OVERFLOW_CAPACITY);
    const pages = Array.from({ length: chunks }, () => this.pager.allocate());
    pages.forEach((page, i) => {
      page.data[0] = PAGE_TYPE_OVERFLOW;
      page.view.setUint32(OVERFLOW_NEXT, pages[i + 1]?.no ?? 0);
      page.data.set(
        value.subarray(i * OVERFLOW_CAPACITY, (i + 1) * OVERFLOW_CAPACITY),
        OVERFLOW_DATA,
      );
    });
    return pages[0]!.no;
  }

  private freeOverflow(first: number): void {
    for (let no = first; no !== 0;) {
      const next = this.pager.read(no).view.getUint32(OVERFLOW_NEXT);
      this.pager.free(no);
      no = next;
    }
  }
}

// ------------------------------------------------------------------ helpers

/** First slot whose key is >= key. */
function lowerBound(page: Page, key: Uint8Array): number {
  let lo = 0;
  let hi = cellCount(page);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBytes(cellKey(page, mid), key) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the child to follow for `key` (cellCount means the right pointer). */
function childIndex(page: Page, key: Uint8Array): number {
  let lo = 0;
  let hi = cellCount(page);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBytes(key, cellKey(page, mid)) < 0) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function childAt(page: Page, index: number): number {
  return index < cellCount(page) ? cellChild(page, index) : rightPointer(page);
}

function allCells(page: Page): Uint8Array[] {
  const out: Uint8Array[] = [];
  const n = cellCount(page);
  for (let i = 0; i < n; i++) out.push(cellBytes(page, i));
  return out;
}

/** Index that splits `cells` into two halves of similar byte size (both non-empty). */
function splitPoint(cells: readonly Uint8Array[]): number {
  const total = cells.reduce((n, c) => n + c.length + 2, 0);
  let acc = 0;
  for (let i = 0; i < cells.length; i++) {
    acc += cells[i]!.length + 2;
    if (acc >= total / 2) return Math.min(Math.max(i, 1), cells.length - 1);
  }
  return cells.length - 1;
}

function internalCell(child: number, key: Uint8Array): Uint8Array {
  const cell = new Uint8Array(6 + key.length);
  const view = new DataView(cell.buffer);
  view.setUint32(0, child);
  view.setUint16(4, key.length);
  cell.set(key, 6);
  return cell;
}

function leafCellKey(cell: Uint8Array): Uint8Array {
  const keyLen = new DataView(cell.buffer, cell.byteOffset, cell.byteLength).getUint16(0);
  return cell.slice(4, 4 + keyLen);
}
