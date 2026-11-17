import { GraniteError } from '../errors.ts';
import { PAGE_SIZE, type Page } from './pager.ts';

/**
 * Slotted page layout used by B+tree nodes.
 *
 *   0   u8   page type (LEAF or INTERNAL)
 *   2   u16  number of cells
 *   4   u16  start of the cell content area (cells grow down from the end)
 *   6   u16  bytes lost to holes inside the content area
 *   8   u32  leaf: next leaf page / internal: rightmost child
 *   12  u32  tree metadata (root page only): tuple count
 *   16  f64  tree metadata (root page only): next row id
 *   24  u16[] slot array: offset of each cell, in key order
 *
 * Leaf cell:     [key length u16][value length u16][key][value]
 *                value length with the top bit set means the value lives in an
 *                overflow chain and the cell holds [total length u32][first page u32]
 * Internal cell: [child page u32][key length u16][key]   (child holds keys < key)
 */
export const NODE = {
  type: 0,
  count: 2,
  content: 4,
  fragmented: 6,
  right: 8,
  metaCount: 12,
  metaNextRowId: 16,
  slots: 24,
} as const;

export const LEAF = 1;
export const INTERNAL = 2;
export const OVERFLOW_FLAG = 0x8000;

export function initNode(page: Page, type: number): void {
  page.data.fill(0, 0, NODE.slots);
  page.data[NODE.type] = type;
  page.view.setUint16(NODE.count, 0);
  page.view.setUint16(NODE.content, PAGE_SIZE % 65536);
  page.view.setUint16(NODE.fragmented, 0);
}

export function nodeType(page: Page): number {
  const t = page.data[NODE.type]!;
  if (t !== LEAF && t !== INTERNAL) {
    throw new GraniteError('corrupt_database', `page ${page.no} is not a B+tree node (type ${t})`);
  }
  return t;
}

export function cellCount(page: Page): number {
  return page.view.getUint16(NODE.count);
}

function contentStart(page: Page): number {
  return page.view.getUint16(NODE.content) || PAGE_SIZE;
}

export function cellOffset(page: Page, index: number): number {
  return page.view.getUint16(NODE.slots + 2 * index);
}

export function rightPointer(page: Page): number {
  return page.view.getUint32(NODE.right);
}

export function setRightPointer(page: Page, value: number): void {
  page.view.setUint32(NODE.right, value);
}

/** Size in bytes of the cell starting at `offset`. */
export function cellSize(page: Page, offset: number): number {
  if (page.data[NODE.type] === LEAF) {
    const keyLen = page.view.getUint16(offset);
    const valLen = page.view.getUint16(offset + 2);
    return 4 + keyLen + (valLen & OVERFLOW_FLAG ? 8 : valLen);
  }
  return 6 + page.view.getUint16(offset + 4);
}

/** The key bytes of cell `index` (a view into the page, not a copy). */
export function cellKey(page: Page, index: number): Uint8Array {
  const offset = cellOffset(page, index);
  if (page.data[NODE.type] === LEAF) {
    const keyLen = page.view.getUint16(offset);
    return page.data.subarray(offset + 4, offset + 4 + keyLen);
  }
  const keyLen = page.view.getUint16(offset + 4);
  return page.data.subarray(offset + 6, offset + 6 + keyLen);
}

/** Child page of internal cell `index`. */
export function cellChild(page: Page, index: number): number {
  return page.view.getUint32(cellOffset(page, index));
}

export function setCellChild(page: Page, index: number, child: number): void {
  page.view.setUint32(cellOffset(page, index), child);
}

/** Copy of the raw bytes of cell `index`. */
export function cellBytes(page: Page, index: number): Uint8Array {
  const offset = cellOffset(page, index);
  return page.data.slice(offset, offset + cellSize(page, offset));
}

export function freeSpace(page: Page): number {
  return (
    contentStart(page) - (NODE.slots + 2 * cellCount(page)) + page.view.getUint16(NODE.fragmented)
  );
}

/** Insert raw cell bytes at slot `index`. Returns false if the page is full. */
export function insertCell(page: Page, index: number, cell: Uint8Array): boolean {
  const count = cellCount(page);
  const slotEnd = NODE.slots + 2 * count;
  let start = contentStart(page);
  if (start - slotEnd < cell.length + 2) {
    if (freeSpace(page) < cell.length + 2) return false;
    defragment(page);
    start = contentStart(page);
  }
  start -= cell.length;
  page.data.set(cell, start);
  page.view.setUint16(NODE.content, start);
  // Shift the slots after `index` one position right.
  page.data.copyWithin(NODE.slots + 2 * (index + 1), NODE.slots + 2 * index, slotEnd);
  page.view.setUint16(NODE.slots + 2 * index, start);
  page.view.setUint16(NODE.count, count + 1);
  return true;
}

export function removeCell(page: Page, index: number): void {
  const count = cellCount(page);
  const offset = cellOffset(page, index);
  const size = cellSize(page, offset);
  if (offset === contentStart(page)) page.view.setUint16(NODE.content, offset + size);
  else page.view.setUint16(NODE.fragmented, page.view.getUint16(NODE.fragmented) + size);
  page.data.copyWithin(
    NODE.slots + 2 * index,
    NODE.slots + 2 * (index + 1),
    NODE.slots + 2 * count,
  );
  page.view.setUint16(NODE.count, count - 1);
}

/** Rewrite the content area without holes, keeping slot order. */
export function defragment(page: Page): void {
  const count = cellCount(page);
  const cells: Uint8Array[] = [];
  for (let i = 0; i < count; i++) cells.push(cellBytes(page, i));
  let start = PAGE_SIZE;
  for (let i = 0; i < count; i++) {
    const cell = cells[i]!;
    start -= cell.length;
    page.data.set(cell, start);
    page.view.setUint16(NODE.slots + 2 * i, start);
  }
  page.data.fill(0, NODE.slots + 2 * count, start);
  page.view.setUint16(NODE.content, start % 65536);
  page.view.setUint16(NODE.fragmented, 0);
}

/** Replace all cells of a node with `cells` (which must fit). */
export function rewriteNode(
  page: Page,
  type: number,
  cells: readonly Uint8Array[],
  right: number,
): void {
  const metaCount = page.view.getUint32(NODE.metaCount);
  const metaNext = page.view.getFloat64(NODE.metaNextRowId);
  initNode(page, type);
  page.view.setUint32(NODE.metaCount, metaCount);
  page.view.setFloat64(NODE.metaNextRowId, metaNext);
  setRightPointer(page, right);
  cells.forEach((cell, i) => {
    if (!insertCell(page, i, cell))
      throw new GraniteError('internal_error', 'rewriteNode: cells do not fit');
  });
}

/** Bytes needed to store `cells` in one node. */
export function bytesNeeded(cells: readonly Uint8Array[]): number {
  let n = NODE.slots;
  for (const c of cells) n += c.length + 2;
  return n;
}
