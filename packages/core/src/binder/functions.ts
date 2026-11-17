import { GraniteError } from '../errors.ts';
import type { ExprType, Value } from '../types/datatype.ts';
import { codePointLength } from '../types/value.ts';
import type { AggregateFn } from './bound.ts';

/** What an argument position accepts. */
export type ArgKind = 'number' | 'integer' | 'text' | 'any';

export interface ScalarFunction {
  readonly name: string;
  readonly minArgs: number;
  readonly maxArgs: number;
  /** Accepted kind per position; the last entry repeats for variadic functions. */
  readonly params: readonly ArgKind[];
  /** Result type from the argument types (already checked against `params`). */
  readonly result: (types: readonly ExprType[]) => ExprType;
  /** True if any NULL argument makes the result NULL without calling `eval`. */
  readonly strict: boolean;
  readonly eval: (args: readonly Value[]) => Value;
}

const sameAsFirst = (types: readonly ExprType[]): ExprType =>
  types[0] === 'NULL' ? 'INTEGER' : types[0]!;

function roundHalfAway(x: number, digits: number): number {
  const f = 10 ** digits;
  const r = (Math.round(Math.abs(x) * f) / f) * Math.sign(x);
  return r === 0 ? 0 : r;
}

function substr(s: string, start: number, length?: number): string {
  const chars = Array.from(s);
  // SQL positions are 1-based; a start before 1 eats into the length (as in PostgreSQL).
  let from = start - 1;
  let to = length === undefined ? chars.length : from + length;
  if (length !== undefined && length < 0) {
    throw new GraniteError('invalid_parameter', 'negative substring length not allowed');
  }
  from = Math.max(0, from);
  to = Math.min(chars.length, to);
  return to <= from ? '' : chars.slice(from, to).join('');
}

const FUNCTIONS: ReadonlyMap<string, ScalarFunction> = new Map(
  (
    [
      {
        name: 'abs',
        minArgs: 1,
        maxArgs: 1,
        params: ['number'],
        result: sameAsFirst,
        strict: true,
        eval: ([x]) => Math.abs(x as number),
      },
      {
        name: 'round',
        minArgs: 1,
        maxArgs: 2,
        params: ['number', 'integer'],
        result: sameAsFirst,
        strict: true,
        eval: ([x, d]) => roundHalfAway(x as number, (d as number | undefined) ?? 0),
      },
      {
        name: 'length',
        minArgs: 1,
        maxArgs: 1,
        params: ['text'],
        result: () => 'INTEGER',
        strict: true,
        eval: ([s]) => codePointLength(s as string),
      },
      {
        name: 'upper',
        minArgs: 1,
        maxArgs: 1,
        params: ['text'],
        result: () => 'TEXT',
        strict: true,
        eval: ([s]) => (s as string).toUpperCase().normalize('NFC'),
      },
      {
        name: 'lower',
        minArgs: 1,
        maxArgs: 1,
        params: ['text'],
        result: () => 'TEXT',
        strict: true,
        eval: ([s]) => (s as string).toLowerCase().normalize('NFC'),
      },
      {
        name: 'substr',
        minArgs: 2,
        maxArgs: 3,
        params: ['text', 'integer', 'integer'],
        result: () => 'TEXT',
        strict: true,
        eval: ([s, start, len]) => substr(s as string, start as number, len as number | undefined),
      },
      {
        name: 'trim',
        minArgs: 1,
        maxArgs: 1,
        params: ['text'],
        result: () => 'TEXT',
        strict: true,
        eval: ([s]) => (s as string).trim(),
      },
      {
        name: 'replace',
        minArgs: 3,
        maxArgs: 3,
        params: ['text', 'text', 'text'],
        result: () => 'TEXT',
        strict: true,
        eval: ([s, from, to]) =>
          (from as string) === '' ? s : (s as string).replaceAll(from as string, to as string),
      },
      {
        name: 'coalesce',
        minArgs: 1,
        maxArgs: Infinity,
        params: ['any'],
        result: () => 'NULL', // unified by the binder
        strict: false,
        eval: (args) => args.find((a) => a !== null) ?? null,
      },
      {
        name: 'nullif',
        minArgs: 2,
        maxArgs: 2,
        params: ['any', 'any'],
        result: () => 'NULL', // unified by the binder
        strict: false,
        eval: ([a, b]) => (a !== null && b !== null && a === b ? null : (a ?? null)),
      },
    ] satisfies ScalarFunction[]
  ).map((f) => [f.name, f]),
);

/** `substring` is accepted as a synonym of `substr`. */
export function lookupFunction(name: string): ScalarFunction | undefined {
  return FUNCTIONS.get(name === 'substring' ? 'substr' : name);
}

export const AGGREGATES: ReadonlySet<string> = new Set<AggregateFn>([
  'count',
  'sum',
  'avg',
  'min',
  'max',
]);

export function functionNames(): string[] {
  return [...FUNCTIONS.keys(), ...AGGREGATES];
}

const likeCache = new Map<string, RegExp>();

/** Compile a LIKE pattern (% = any run, _ = one code point) to an anchored RegExp. */
export function likeToRegExp(pattern: string): RegExp {
  let re = likeCache.get(pattern);
  if (re) return re;
  let src = '^';
  for (const ch of pattern) {
    if (ch === '%') src += '.*';
    else if (ch === '_') src += '.';
    else src += ch.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
  }
  re = new RegExp(`${src}$`, 'su');
  if (likeCache.size > 256) likeCache.clear();
  likeCache.set(pattern, re);
  return re;
}
