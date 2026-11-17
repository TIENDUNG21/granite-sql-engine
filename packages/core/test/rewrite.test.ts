import { describe, expect, it } from 'vitest';
import type { BoundExpr } from '../src/binder/bound.ts';
import { foldExpr } from '../src/plan/rewrite.ts';

const int = (value: number): BoundExpr => ({ kind: 'const', value, type: 'INTEGER' });
const bool = (value: boolean | null): BoundExpr => ({ kind: 'const', value, type: 'BOOLEAN' });
const col: BoundExpr = { kind: 'column', id: 1, name: 'x', table: 't', type: 'INTEGER' };
const gt = (l: BoundExpr, r: BoundExpr): BoundExpr => ({
  kind: 'compare',
  op: '>',
  left: l,
  right: r,
  type: 'BOOLEAN',
});

describe('constant folding', () => {
  it('evaluates row-independent sub-expressions', () => {
    const e: BoundExpr = {
      kind: 'arith',
      op: '*',
      left: { kind: 'arith', op: '+', left: int(1), right: int(2), type: 'INTEGER' },
      right: col,
      type: 'INTEGER',
    };
    expect(foldExpr(e)).toMatchObject({ left: { kind: 'const', value: 3 } });
  });

  it('applies boolean identities without changing NULL semantics', () => {
    const p = gt(col, int(1));
    expect(foldExpr({ kind: 'and', left: p, right: bool(true), type: 'BOOLEAN' })).toEqual(p);
    expect(foldExpr({ kind: 'and', left: p, right: bool(false), type: 'BOOLEAN' })).toMatchObject({
      value: false,
    });
    expect(foldExpr({ kind: 'or', left: bool(true), right: p, type: 'BOOLEAN' })).toMatchObject({
      value: true,
    });
    expect(foldExpr({ kind: 'or', left: bool(false), right: p, type: 'BOOLEAN' })).toEqual(p);
    // NULL AND p stays as is: it is NULL or FALSE depending on p.
    expect(foldExpr({ kind: 'and', left: bool(null), right: p, type: 'BOOLEAN' }).kind).toBe('and');
  });

  it('leaves failing constant expressions for run time', () => {
    const e: BoundExpr = { kind: 'arith', op: '/', left: int(1), right: int(0), type: 'INTEGER' };
    expect(foldExpr(e)).toEqual(e);
  });
});
