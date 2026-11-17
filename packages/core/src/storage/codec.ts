import { GraniteError } from '../errors.ts';
import type { DataType, Value } from '../types/datatype.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Growable byte buffer with big-endian writers. */
class ByteWriter {
  private buf = new Uint8Array(64);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.length++] = v;
  }

  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.length, v);
    this.length += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, v);
    this.length += 4;
  }

  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.length, v);
    this.length += 8;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

// ------------------------------------------------------------------- keys

/**
 * Tags of the order-preserving key encoding. Encoded keys compare with memcmp
 * in the same order as the values: NULL < false < true < numbers < text.
 */
const TAG_NULL = 0x01;
const TAG_FALSE = 0x02;
const TAG_TRUE = 0x03;
const TAG_NUMBER = 0x04;
const TAG_TEXT = 0x05;
/** Greater than every tag: `prefix + [0xff]` bounds all keys that start with `prefix`. */
const AFTER_ALL = 0xff;

function writeKeyValue(w: ByteWriter, v: Value): void {
  if (v === null) w.u8(TAG_NULL);
  else if (v === false) w.u8(TAG_FALSE);
  else if (v === true) w.u8(TAG_TRUE);
  else if (typeof v === 'number') {
    w.u8(TAG_NUMBER);
    // IEEE 754 doubles sort like integers once the sign bit is flipped for
    // positives and every bit is flipped for negatives.
    const tmp = new DataView(new ArrayBuffer(8));
    tmp.setFloat64(0, v === 0 ? 0 : v);
    const hi = tmp.getUint32(0);
    const lo = tmp.getUint32(4);
    if (hi & 0x80000000) {
      w.u32(~hi >>> 0);
      w.u32(~lo >>> 0);
    } else {
      w.u32((hi | 0x80000000) >>> 0);
      w.u32(lo);
    }
  } else {
    w.u8(TAG_TEXT);
    // UTF-8 bytes in code-point order; 0x00 is escaped as 00 ff and the
    // string ends with 00 00, so shorter prefixes sort first.
    for (const b of encoder.encode(v)) {
      w.u8(b);
      if (b === 0) w.u8(0xff);
    }
    w.u8(0);
    w.u8(0);
  }
}

/** Encode values so that byte order equals value order. */
export function encodeKey(values: readonly Value[]): Uint8Array {
  const w = new ByteWriter();
  for (const v of values) writeKeyValue(w, v);
  return w.finish();
}

/** Index entry key: the indexed values followed by the row id. */
export function encodeIndexKey(values: readonly Value[], rowid: number): Uint8Array {
  const w = new ByteWriter();
  for (const v of values) writeKeyValue(w, v);
  w.f64(rowid);
  return w.finish();
}

export function rowIdOfIndexKey(key: Uint8Array): number {
  return new DataView(key.buffer, key.byteOffset, key.byteLength).getFloat64(key.length - 8);
}

/** Table B+tree key: the row id, big-endian. */
export function encodeRowId(rowid: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, rowid);
  return out;
}

export function decodeRowId(key: Uint8Array): number {
  return new DataView(key.buffer, key.byteOffset, key.byteLength).getFloat64(0);
}

/** Smallest byte string greater than every key that starts with `prefix`. */
export function prefixEnd(prefix: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + 1);
  out.set(prefix);
  out[prefix.length] = AFTER_ALL;
  return out;
}

/** `prefix` followed by the encoding of one more value. */
export function extendKey(prefix: Uint8Array, value: Value): Uint8Array {
  const w = new ByteWriter();
  w.bytes(prefix);
  writeKeyValue(w, value);
  return w.finish();
}

/** Lowest key after `prefix` that skips a NULL in the next column. */
export function afterNull(prefix: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + 1);
  out.set(prefix);
  out[prefix.length] = TAG_NULL + 1;
  return out;
}

// ------------------------------------------------------------------- rows

/** Transaction ids stamped on a stored row version (MVCC header). */
export interface RowHeader {
  xmin: number;
  xmax: number;
}

/**
 * Row layout: [xmin u32][xmax u32][column count u16][null bitmap][values].
 * Values follow the column types: numbers as f64, BOOLEAN as one byte, TEXT as
 * a u32 byte length and UTF-8.
 */
export function encodeRow(
  header: RowHeader,
  values: readonly Value[],
  types: readonly DataType[],
): Uint8Array {
  const w = new ByteWriter();
  w.u32(header.xmin);
  w.u32(header.xmax);
  w.u16(values.length);
  const bitmap = new Uint8Array(Math.ceil(values.length / 8));
  values.forEach((v, i) => {
    if (v === null) bitmap[i >> 3]! |= 1 << (i & 7);
  });
  w.bytes(bitmap);
  values.forEach((v, i) => {
    if (v === null) return;
    switch (types[i]) {
      case 'INTEGER':
      case 'REAL':
        w.f64(v as number);
        break;
      case 'BOOLEAN':
        w.u8(v ? 1 : 0);
        break;
      case 'TEXT': {
        const bytes = encoder.encode(v as string);
        w.u32(bytes.length);
        w.bytes(bytes);
        break;
      }
      default:
        throw new GraniteError('internal_error', `no type for column ${i}`);
    }
  });
  return w.finish();
}

export const ROW_HEADER_SIZE = 8;

export function decodeRowHeader(bytes: Uint8Array): RowHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { xmin: view.getUint32(0), xmax: view.getUint32(4) };
}

export function decodeRow(bytes: Uint8Array, types: readonly DataType[]): Value[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint16(ROW_HEADER_SIZE);
  if (n !== types.length) {
    throw new GraniteError('corrupt_database', `row has ${n} columns, schema has ${types.length}`);
  }
  let pos = ROW_HEADER_SIZE + 2;
  const bitmap = bytes.subarray(pos, pos + Math.ceil(n / 8));
  pos += bitmap.length;
  const values = new Array<Value>(n);
  for (let i = 0; i < n; i++) {
    if (bitmap[i >> 3]! & (1 << (i & 7))) {
      values[i] = null;
      continue;
    }
    switch (types[i]) {
      case 'INTEGER':
      case 'REAL':
        values[i] = view.getFloat64(pos);
        pos += 8;
        break;
      case 'BOOLEAN':
        values[i] = bytes[pos++] === 1;
        break;
      default: {
        const len = view.getUint32(pos);
        pos += 4;
        values[i] = decoder.decode(bytes.subarray(pos, pos + len));
        pos += len;
      }
    }
  }
  return values;
}

/** Overwrite xmax of an encoded row in place. */
export function setRowXmax(bytes: Uint8Array, xmax: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(4, xmax);
}
