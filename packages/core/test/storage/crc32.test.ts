import { describe, expect, it } from 'vitest';
import { crc32 } from '../../src/storage/crc32.ts';

describe('crc32', () => {
  it('matches the IEEE check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('can be computed incrementally and over a slice', () => {
    const bytes = new TextEncoder().encode('granite write-ahead log');
    expect(crc32(bytes.subarray(8), crc32(bytes.subarray(0, 8)))).toBe(crc32(bytes));
    expect(crc32(bytes, 0, 2, 5)).toBe(crc32(bytes.subarray(2, 5)));
  });
});
