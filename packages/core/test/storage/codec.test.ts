import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareBytes } from '../../src/storage/btree.ts';
import {
  decodeRow,
  decodeRowHeader,
  decodeRowId,
  encodeIndexKey,
  encodeKey,
  encodeRow,
  encodeRowId,
  prefixEnd,
  rowIdOfIndexKey,
  setRowXmax,
} from '../../src/storage/codec.ts';
import { rangeKeys } from '../../src/storage/table-store.ts';
import type { DataType, Value } from '../../src/types/datatype.ts';
import { compareValues } from '../../src/types/value.ts';

/** Index order: like compareValues, except NULL sorts first. */
function indexOrder(a: Value, b: Value): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  return compareValues(a, b);
}

const keyValue: fc.Arbitrary<Value> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.integer({ min: -(2 ** 53) + 1, max: 2 ** 53 - 1 }),
  fc.string({ unit: 'grapheme', maxLength: 12 }),
  fc.constantFrom('', '\0', 'a\0', 'a', 'a\0b', '\u{1F600}', '～'),
);

describe('key encoding', () => {
  it('orders encoded single values like the values themselves', () => {
    fc.assert(
      fc.property(keyValue, keyValue, (a, b) => {
        expect(Math.sign(compareBytes(encodeKey([a]), encodeKey([b])))).toBe(
          Math.sign(indexOrder(a, b)),
        );
      }),
      { numRuns: 3000 },
    );
  });

  it('orders composite keys lexicographically by column', () => {
    fc.assert(
      fc.property(fc.tuple(keyValue, keyValue), fc.tuple(keyValue, keyValue), (a, b) => {
        const expected = indexOrder(a[0], b[0]) || indexOrder(a[1], b[1]);
        expect(Math.sign(compareBytes(encodeKey(a), encodeKey(b)))).toBe(Math.sign(expected));
      }),
      { numRuns: 2000 },
    );
  });

  it('treats -0 and 0 as the same key', () => {
    expect(encodeKey([-0])).toEqual(encodeKey([0]));
  });

  it('bounds every key with a given prefix', () => {
    fc.assert(
      fc.property(keyValue, keyValue, fc.integer({ min: 1, max: 1e9 }), (a, b, rowid) => {
        const prefix = encodeKey([a]);
        const key = encodeIndexKey([a, b], rowid);
        expect(compareBytes(key, prefix)).toBeGreaterThanOrEqual(0);
        expect(compareBytes(key, prefixEnd(prefix))).toBeLessThan(0);
        expect(rowIdOfIndexKey(key)).toBe(rowid);
      }),
    );
  });

  it('turns ranges into byte bounds that exclude NULLs', () => {
    const inRange = (v: Value, range: Parameters<typeof rangeKeys>[0]) => {
      const [lo, hi] = rangeKeys(range);
      const key = encodeIndexKey([7, v], 1);
      return compareBytes(key, lo) >= 0 && compareBytes(key, hi) < 0;
    };
    const lt5 = { prefix: [7], lower: undefined, upper: { value: 5, inclusive: false } };
    expect([null, 1, 4.9, 5, 6].map((v) => inRange(v, lt5))).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    const ge5 = { prefix: [7], lower: { value: 5, inclusive: true }, upper: undefined };
    expect([null, 4, 5, 1e9].map((v) => inRange(v, ge5))).toEqual([false, false, true, true]);
    const between = {
      prefix: [7],
      lower: { value: 2, inclusive: false },
      upper: { value: 4, inclusive: true },
    };
    expect([2, 3, 4, 5].map((v) => inRange(v, between))).toEqual([false, true, true, false]);
    const eq = { prefix: [7, 3], lower: undefined, upper: undefined };
    const [lo, hi] = rangeKeys(eq);
    const key = encodeIndexKey([7, 3], 99);
    expect(compareBytes(key, lo) >= 0 && compareBytes(key, hi) < 0).toBe(true);
  });

  it('encodes row ids in order', () => {
    expect(compareBytes(encodeRowId(2), encodeRowId(10))).toBe(-1);
    expect(decodeRowId(encodeRowId(123456789))).toBe(123456789);
  });
});

describe('row encoding', () => {
  const types: DataType[] = ['INTEGER', 'REAL', 'TEXT', 'BOOLEAN'];
  const row = fc.tuple(
    fc.option(fc.integer({ min: -(2 ** 53) + 1, max: 2 ** 53 - 1 }), { nil: null }),
    fc.option(fc.double({ noNaN: true }), { nil: null }),
    fc.option(fc.string({ unit: 'grapheme', maxLength: 300 }), { nil: null }),
    fc.option(fc.boolean(), { nil: null }),
  );

  it('round-trips values of every type, NULLs and astral text', () => {
    fc.assert(
      fc.property(row, fc.nat(), fc.nat(), (values, xmin, xmax) => {
        const bytes = encodeRow({ xmin, xmax }, values, types);
        expect(decodeRow(bytes, types)).toEqual(values);
        expect(decodeRowHeader(bytes)).toEqual({ xmin, xmax });
      }),
    );
  });

  it('stamps xmax in place', () => {
    const bytes = encodeRow({ xmin: 3, xmax: 0 }, [1, 2.5, 'x', true], types);
    setRowXmax(bytes, 9);
    expect(decodeRowHeader(bytes)).toEqual({ xmin: 3, xmax: 9 });
    expect(decodeRow(bytes, types)).toEqual([1, 2.5, 'x', true]);
  });

  it('detects a schema mismatch instead of misreading', () => {
    const bytes = encodeRow({ xmin: 0, xmax: 0 }, [1], ['INTEGER']);
    expect(() => decodeRow(bytes, types)).toThrow('row has 1 columns, schema has 4');
  });
});
