import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Value } from '../src/types/datatype.ts';
import {
  and3,
  codePointLength,
  compareText,
  compareValues,
  formatValue,
  hashKey,
  not3,
  or3,
  sqlCompare,
  typeOfValue,
} from '../src/types/value.ts';

const anyValue: fc.Arbitrary<Value> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.double({ noNaN: true }),
  fc.integer(),
  fc.string({ unit: 'grapheme' }),
);

describe('three-valued logic', () => {
  const T = true;
  const F = false;
  const N = null;
  it.each([
    [T, T, T, T],
    [T, F, F, T],
    [T, N, N, T],
    [F, F, F, F],
    [F, N, F, N],
    [N, N, N, N],
  ])('%s AND/OR %s', (a, b, and, or) => {
    expect(and3(a, b)).toBe(and);
    expect(and3(b, a)).toBe(and);
    expect(or3(a, b)).toBe(or);
    expect(or3(b, a)).toBe(or);
  });

  it('negates with NOT NULL = NULL', () => {
    expect(not3(true)).toBe(false);
    expect(not3(false)).toBe(true);
    expect(not3(null)).toBeNull();
  });

  it('compares with NULL to NULL', () => {
    expect(sqlCompare(null, 1)).toBeNull();
    expect(sqlCompare(1, null)).toBeNull();
    expect(sqlCompare(2, 1)).toBe(1);
  });
});

describe('compareText', () => {
  it('orders astral characters after the rest of the BMP', () => {
    // '～' (fullwidth tilde) < '\u{1F600}' by code point, but not by UTF-16 unit.
    expect('\u{1F600}' < '～').toBe(true);
    expect(compareText('～', '\u{1F600}')).toBe(-1);
    expect(compareText('\u{1F600}', '～')).toBe(1);
  });

  it('agrees with UTF-8 byte order', () => {
    const enc = new TextEncoder();
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), fc.string({ unit: 'grapheme' }), (a, b) => {
        const ea = enc.encode(a);
        const eb = enc.encode(b);
        let byteOrder = 0;
        for (let i = 0; i < Math.min(ea.length, eb.length) && byteOrder === 0; i++) {
          byteOrder = Math.sign(ea[i]! - eb[i]!);
        }
        if (byteOrder === 0) byteOrder = Math.sign(ea.length - eb.length);
        expect(compareText(a, b)).toBe(byteOrder);
      }),
    );
  });
});

describe('compareValues', () => {
  it('is a total order (antisymmetric and transitive)', () => {
    fc.assert(
      fc.property(anyValue, anyValue, anyValue, (a, b, c) => {
        expect(Math.sign(compareValues(a, b))).toBe(-Math.sign(compareValues(b, a)) || 0);
        if (compareValues(a, b) <= 0 && compareValues(b, c) <= 0) {
          expect(compareValues(a, c)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it('puts NULL after every other value', () => {
    expect([3, null, 1].sort(compareValues)).toEqual([1, 3, null]);
  });
});

describe('hashKey', () => {
  it('treats NULLs as one group and 1 as 1.0', () => {
    expect(hashKey([null])).toBe(hashKey([null]));
    expect(hashKey([1])).toBe(hashKey([1.0]));
    expect(hashKey([0])).toBe(hashKey([-0]));
  });

  it('never confuses values of different types or boundaries', () => {
    expect(hashKey(['1'])).not.toBe(hashKey([1]));
    expect(hashKey([true])).not.toBe(hashKey(['t']));
    expect(hashKey(['a|', 'b'])).not.toBe(hashKey(['a', '|b']));
  });

  it('is equal exactly when compareValues says equal', () => {
    fc.assert(
      fc.property(anyValue, anyValue, (a, b) => {
        expect(hashKey([a]) === hashKey([b])).toBe(compareValues(a, b) === 0);
      }),
    );
  });
});

describe('formatting and typing', () => {
  it('formats values for display', () => {
    expect(formatValue(null)).toBe('NULL');
    expect(formatValue(true)).toBe('true');
    expect(formatValue(2, 'REAL')).toBe('2.0');
    expect(formatValue(2, 'INTEGER')).toBe('2');
    expect(formatValue(0.1 + 0.2, 'REAL')).toBe('0.30000000000000004');
  });

  it('infers the type of parameter values', () => {
    expect(typeOfValue(3)).toBe('INTEGER');
    expect(typeOfValue(3.5)).toBe('REAL');
    expect(typeOfValue('x')).toBe('TEXT');
    expect(typeOfValue(false)).toBe('BOOLEAN');
    expect(typeOfValue(null)).toBe('NULL');
  });

  it('counts code points', () => {
    expect(codePointLength('Việt')).toBe(4);
    expect(codePointLength('\u{1F600}x')).toBe(2);
    expect(codePointLength('\uD800')).toBe(1);
  });
});
