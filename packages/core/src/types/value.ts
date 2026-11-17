import type { ExprType, Value } from './datatype.ts';

/**
 * Compare TEXT by Unicode code point. JS `<` compares UTF-16 code units, which
 * orders astral characters (emoji, rare CJK) before U+E000..U+FFFF; code-point
 * order matches the byte order of the UTF-8 keys stored in indexes.
 */
export function compareText(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca === cb) continue;
    const surrogateA = ca >= 0xd800 && ca <= 0xdfff;
    const surrogateB = cb >= 0xd800 && cb <= 0xdfff;
    if (surrogateA === surrogateB) return ca < cb ? -1 : 1;
    // A surrogate (astral code point) is larger than any BMP code unit.
    return surrogateA ? 1 : -1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * Total order over values used for sorting, grouping and keys:
 * booleans < numbers < text, false < true, NULL greater than everything.
 * Within a well-typed query only one kind of non-null value meets another.
 */
export function compareValues(a: Value, b: Value): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'string') return compareText(a, b as string);
  if (typeof a === 'number') {
    const bn = b as number;
    return a < bn ? -1 : a > bn ? 1 : 0;
  }
  return a === false ? -1 : 1;
}

function rank(v: boolean | number | string): number {
  return typeof v === 'boolean' ? 0 : typeof v === 'number' ? 1 : 2;
}

/** SQL comparison with three-valued logic: NULL if either side is NULL. */
export function sqlCompare(a: Value, b: Value): number | null {
  if (a === null || b === null) return null;
  return compareValues(a, b);
}

export function and3(a: Value, b: Value): boolean | null {
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return true;
}

export function or3(a: Value, b: Value): boolean | null {
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return false;
}

export function not3(a: Value): boolean | null {
  return a === null ? null : !a;
}

/**
 * A string key with the same equality as SQL grouping: NULLs are equal to each
 * other, 1 (INTEGER) equals 1.0 (REAL), TEXT compares exactly.
 */
export function hashKey(values: readonly Value[]): string {
  let key = '';
  for (const v of values) {
    if (v === null) key += 'n|';
    else if (typeof v === 'boolean') key += v ? 't|' : 'f|';
    else if (typeof v === 'number') key += `d${v === 0 ? 0 : v}|`;
    else key += `s${v.length}:${v}|`;
  }
  return key;
}

export function hashKey1(v: Value): string {
  if (v === null) return 'n';
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (typeof v === 'number') return `d${v === 0 ? 0 : v}`;
  return `s${v}`;
}

/** Render a value for people: NULL, true/false, REAL with a decimal point. */
export function formatValue(v: Value, type?: ExprType): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (type === 'REAL' && Number.isInteger(v) && Math.abs(v) < 1e21) return v.toFixed(1);
    return String(v);
  }
  return v;
}

/** The static type of a runtime value (used for parameters). */
export function typeOfValue(v: Value): ExprType {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return 'BOOLEAN';
  if (typeof v === 'string') return 'TEXT';
  return Number.isInteger(v) ? 'INTEGER' : 'REAL';
}

/** Number of Unicode code points in a string. */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}
