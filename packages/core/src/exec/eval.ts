import type { BoundExpr, ColumnId } from '../binder/bound.ts';
import { likeToRegExp, lookupFunction } from '../binder/functions.ts';
import { GraniteError } from '../errors.ts';
import type { DataType, ExprType, Value } from '../types/datatype.ts';
import { and3, compareValues, formatValue, hashKey1, not3, or3 } from '../types/value.ts';

export type Row = Value[];
export type Compiled = (row: Row) => Value;

/** Results of uncorrelated subqueries, computed once per statement on first use. */
export interface SubqueryResults {
  inSet(index: number): { readonly keys: ReadonlySet<string>; readonly hasNull: boolean };
  scalar(index: number): Value;
}

export const NO_SUBQUERIES: SubqueryResults = {
  inSet() {
    throw new GraniteError('internal_error', 'subquery used outside of a query');
  },
  scalar() {
    throw new GraniteError('internal_error', 'subquery used outside of a query');
  },
};

export type Layout = ReadonlyMap<ColumnId, number>;
export const EMPTY_LAYOUT: Layout = new Map();

export function layoutOf(columns: readonly { id: ColumnId }[]): Layout {
  return new Map(columns.map((c, i) => [c.id, i]));
}

/**
 * Compile a bound expression into a closure over a row. Compiling once per
 * operator (instead of walking the tree for every row) keeps the inner loop cheap.
 */
export function compileExpr(e: BoundExpr, layout: Layout, sub: SubqueryResults): Compiled {
  switch (e.kind) {
    case 'const': {
      const v = e.value;
      return () => v;
    }
    case 'column': {
      const pos = layout.get(e.id);
      if (pos === undefined) {
        throw new GraniteError(
          'internal_error',
          `column ${e.name} (#${e.id}) is not available here`,
        );
      }
      return (row) => row[pos]!;
    }
    case 'neg': {
      const f = compileExpr(e.operand, layout, sub);
      return (row) => {
        const v = f(row);
        return v === null ? null : -(v as number) || 0;
      };
    }
    case 'not': {
      const f = compileExpr(e.operand, layout, sub);
      return (row) => not3(f(row));
    }
    case 'arith': {
      const l = compileExpr(e.left, layout, sub);
      const r = compileExpr(e.right, layout, sub);
      const op = e.op;
      const integer = e.type === 'INTEGER';
      return (row) => {
        const a = l(row);
        if (a === null) return null;
        const b = r(row);
        if (b === null) return null;
        return arithmetic(op, a as number, b as number, integer);
      };
    }
    case 'concat': {
      const l = compileExpr(e.left, layout, sub);
      const r = compileExpr(e.right, layout, sub);
      const lt = e.left.type;
      const rt = e.right.type;
      return (row) => {
        const a = l(row);
        if (a === null) return null;
        const b = r(row);
        if (b === null) return null;
        return formatValue(a, lt) + formatValue(b, rt);
      };
    }
    case 'compare': {
      const l = compileExpr(e.left, layout, sub);
      const r = compileExpr(e.right, layout, sub);
      const test = COMPARATORS[e.op];
      return (row) => {
        const a = l(row);
        if (a === null) return null;
        const b = r(row);
        if (b === null) return null;
        return test(compareValues(a, b));
      };
    }
    case 'and': {
      const l = compileExpr(e.left, layout, sub);
      const r = compileExpr(e.right, layout, sub);
      return (row) => {
        const a = l(row);
        return a === false ? false : and3(a, r(row));
      };
    }
    case 'or': {
      const l = compileExpr(e.left, layout, sub);
      const r = compileExpr(e.right, layout, sub);
      return (row) => {
        const a = l(row);
        return a === true ? true : or3(a, r(row));
      };
    }
    case 'is_null': {
      const f = compileExpr(e.operand, layout, sub);
      const negated = e.negated;
      return (row) => (f(row) === null) !== negated;
    }
    case 'in_list': {
      const f = compileExpr(e.operand, layout, sub);
      const items = e.list.map((x) => compileExpr(x, layout, sub));
      const negated = e.negated;
      return (row) => {
        const v = f(row);
        if (v === null) return null;
        let sawNull = false;
        for (const item of items) {
          const w = item(row);
          if (w === null) sawNull = true;
          else if (compareValues(v, w) === 0) return !negated;
        }
        return sawNull ? null : negated;
      };
    }
    case 'in_subquery': {
      const f = compileExpr(e.operand, layout, sub);
      const index = e.subquery;
      const negated = e.negated;
      return (row) => {
        const { keys, hasNull } = sub.inSet(index);
        if (keys.size === 0 && !hasNull) return negated;
        const v = f(row);
        if (v === null) return null;
        if (keys.has(hashKey1(v))) return !negated;
        return hasNull ? null : negated;
      };
    }
    case 'scalar_subquery': {
      const index = e.subquery;
      return () => sub.scalar(index);
    }
    case 'like': {
      const f = compileExpr(e.operand, layout, sub);
      const p = compileExpr(e.pattern, layout, sub);
      const negated = e.negated;
      return (row) => {
        const v = f(row);
        if (v === null) return null;
        const pattern = p(row);
        if (pattern === null) return null;
        return likeToRegExp(pattern as string).test(v as string) !== negated;
      };
    }
    case 'case': {
      const operand = e.operand && compileExpr(e.operand, layout, sub);
      const whens = e.whens.map((w) => ({
        when: compileExpr(w.when, layout, sub),
        then: compileExpr(w.then, layout, sub),
      }));
      const otherwise = e.else ? compileExpr(e.else, layout, sub) : () => null;
      if (operand) {
        return (row) => {
          const v = operand(row);
          if (v !== null) {
            for (const w of whens) {
              const c = w.when(row);
              if (c !== null && compareValues(v, c) === 0) return w.then(row);
            }
          }
          return otherwise(row);
        };
      }
      return (row) => {
        for (const w of whens) if (w.when(row) === true) return w.then(row);
        return otherwise(row);
      };
    }
    case 'cast': {
      const f = compileExpr(e.operand, layout, sub);
      const from = e.operand.type;
      const to = e.type;
      return (row) => castValue(f(row), from, to);
    }
    case 'call': {
      const fn = lookupFunction(e.fn);
      if (!fn) throw new GraniteError('internal_error', `unknown function ${e.fn}`);
      const args = e.args.map((a) => compileExpr(a, layout, sub));
      const resultType = e.type;
      return (row) => {
        const values = args.map((a) => a(row));
        if (fn.strict && values.includes(null)) return null;
        const out = fn.eval(values);
        if (typeof out === 'number') checkNumber(out, resultType === 'INTEGER');
        return out;
      };
    }
  }
}

const COMPARATORS: Record<string, (c: number) => boolean> = {
  '=': (c) => c === 0,
  '<>': (c) => c !== 0,
  '<': (c) => c < 0,
  '<=': (c) => c <= 0,
  '>': (c) => c > 0,
  '>=': (c) => c >= 0,
};

export function arithmetic(op: string, a: number, b: number, integer: boolean): number {
  let out: number;
  switch (op) {
    case '+':
      out = a + b;
      break;
    case '-':
      out = a - b;
      break;
    case '*':
      out = a * b;
      break;
    case '/':
      if (b === 0) throw new GraniteError('division_by_zero', 'division by zero');
      // (a - a % b) is an exact multiple of b, so the division is exact for integers.
      out = integer ? (a - (a % b)) / b : a / b;
      break;
    case '%':
      if (b === 0) throw new GraniteError('division_by_zero', 'division by zero');
      out = a % b;
      break;
    default:
      throw new GraniteError('internal_error', `unknown operator ${op}`);
  }
  checkNumber(out, integer);
  return out === 0 ? 0 : out;
}

export function checkNumber(n: number, integer: boolean): void {
  if (integer) {
    if (!Number.isSafeInteger(n)) {
      throw new GraniteError('numeric_out_of_range', 'integer out of range', {
        hint: `INTEGER values must be within +/-${Number.MAX_SAFE_INTEGER}`,
      });
    }
  } else if (!Number.isFinite(n)) {
    throw new GraniteError('numeric_out_of_range', 'value out of range for REAL');
  }
}

const INTEGER_TEXT = /^\s*[+-]?\d+\s*$/;
const REAL_TEXT = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

/** Explicit conversion between types (CAST). */
export function castValue(v: Value, from: ExprType, to: DataType): Value {
  if (v === null) return null;
  switch (to) {
    case 'INTEGER': {
      let n: number;
      if (typeof v === 'number') n = Math.trunc(v);
      else if (typeof v === 'boolean') n = v ? 1 : 0;
      else {
        if (!INTEGER_TEXT.test(v)) throw invalidText(v, to);
        n = Number(v);
      }
      checkNumber(n, true);
      return n === 0 ? 0 : n;
    }
    case 'REAL': {
      if (typeof v === 'number') return v;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (!REAL_TEXT.test(v)) throw invalidText(v, to);
      const n = Number(v);
      checkNumber(n, false);
      return n;
    }
    case 'TEXT':
      return typeof v === 'string' ? v : formatValue(v, from);
    case 'BOOLEAN': {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      const t = v.trim().toLowerCase();
      if (t === 'true' || t === 't' || t === 'yes' || t === '1') return true;
      if (t === 'false' || t === 'f' || t === 'no' || t === '0') return false;
      throw invalidText(v, to);
    }
  }
}

function invalidText(v: string, to: DataType): GraniteError {
  const shown = v.length > 40 ? `${v.slice(0, 40)}...` : v;
  return new GraniteError(
    'invalid_text_representation',
    `invalid input for type ${to}: ${JSON.stringify(shown)}`,
  );
}

/** Evaluate an expression without columns or subqueries (DEFAULT, LIMIT, folding). */
export function evaluateConstant(e: BoundExpr): Value {
  return compileExpr(e, EMPTY_LAYOUT, NO_SUBQUERIES)([]);
}
