import {
  childrenOf,
  columnsOf,
  conjuncts,
  mapChildren,
  type BoundExpr,
  type ColumnId,
} from '../binder/bound.ts';
import { evaluateConstant } from '../exec/eval.ts';
import { schemaOf, type LogicalPlan } from './logical.ts';

// ------------------------------------------------------- constant folding

const isConst = (e: BoundExpr, value: boolean | null): boolean =>
  e.kind === 'const' && e.value === value;

/**
 * Evaluate sub-expressions that do not depend on any row, and simplify boolean
 * identities (x AND TRUE = x, x OR TRUE = TRUE, ...). An expression whose
 * evaluation fails (1/0) is left alone, so the error only happens if a row
 * actually needs it.
 */
export function foldExpr(e: BoundExpr): BoundExpr {
  const folded = mapChildren(e, foldExpr);
  switch (folded.kind) {
    case 'const':
    case 'column':
    case 'scalar_subquery':
    case 'in_subquery':
      return folded;
    case 'and':
      if (isConst(folded.left, false) || isConst(folded.right, false)) {
        return { kind: 'const', value: false, type: 'BOOLEAN' };
      }
      if (isConst(folded.left, true)) return folded.right;
      if (isConst(folded.right, true)) return folded.left;
      break;
    case 'or':
      if (isConst(folded.left, true) || isConst(folded.right, true)) {
        return { kind: 'const', value: true, type: 'BOOLEAN' };
      }
      if (isConst(folded.left, false)) return folded.right;
      if (isConst(folded.right, false)) return folded.left;
      break;
    default:
      break;
  }
  if (childrenOf(folded).every((c) => c.kind === 'const')) {
    try {
      return { kind: 'const', value: evaluateConstant(folded), type: folded.type };
    } catch {
      return folded;
    }
  }
  return folded;
}

/**
 * Fold the predicates of a list. Returns undefined when one of them is a
 * constant FALSE or NULL: the node can never produce a row.
 */
function foldPredicates(list: BoundExpr[]): BoundExpr[] | undefined {
  const out: BoundExpr[] = [];
  for (const p of list.flatMap((x) => conjuncts(foldExpr(x)))) {
    if (p.kind === 'const') {
      if (p.value === true) continue;
      return undefined;
    }
    out.push(p);
  }
  return out;
}

/** Fold every expression in a plan; replace provably empty inputs by `empty`. */
export function foldPlan(plan: LogicalPlan): LogicalPlan {
  switch (plan.kind) {
    case 'scan': {
      const predicates = foldPredicates(plan.predicates);
      return predicates
        ? { ...plan, predicates }
        : { kind: 'empty', schema: schemaOf(plan), reason: 'contradiction' };
    }
    case 'values':
    case 'empty':
      return plan;
    case 'filter': {
      const input = foldPlan(plan.input);
      const predicates = foldPredicates(plan.predicates);
      if (!predicates) return { kind: 'empty', schema: schemaOf(plan), reason: 'contradiction' };
      return predicates.length ? { ...plan, input, predicates } : input;
    }
    case 'join': {
      const left = foldPlan(plan.left);
      const right = foldPlan(plan.right);
      const conditions = foldPredicates(plan.conditions);
      if (!conditions) {
        if (plan.joinType === 'left')
          return {
            ...plan,
            left,
            right: { kind: 'empty', schema: schemaOf(right), reason: 'contradiction' },
            conditions: [],
          };
        return { kind: 'empty', schema: schemaOf(plan), reason: 'contradiction' };
      }
      return { ...plan, left, right, conditions };
    }
    case 'aggregate':
      return {
        ...plan,
        input: foldPlan(plan.input),
        groupKeys: plan.groupKeys.map((k) => ({ ...k, expr: foldExpr(k.expr) })),
        aggregates: plan.aggregates.map((a) => ({ ...a, arg: a.arg && foldExpr(a.arg) })),
      };
    case 'project':
      return {
        ...plan,
        input: foldPlan(plan.input),
        outputs: plan.outputs.map((o) => ({ ...o, expr: foldExpr(o.expr) })),
      };
    case 'distinct':
    case 'limit':
      return { ...plan, input: foldPlan(plan.input) };
    case 'sort':
      return {
        ...plan,
        input: foldPlan(plan.input),
        keys: plan.keys.map((k) => ({ ...k, expr: foldExpr(k.expr) })),
      };
  }
}

// ----------------------------------------------------- predicate pushdown

function idsOf(plan: LogicalPlan): Set<ColumnId> {
  return new Set(schemaOf(plan).map((c) => c.id));
}

function within(e: BoundExpr, ids: ReadonlySet<ColumnId>): boolean {
  for (const id of columnsOf(e)) if (!ids.has(id)) return false;
  return true;
}

function withFilter(plan: LogicalPlan, predicates: BoundExpr[]): LogicalPlan {
  return predicates.length ? { kind: 'filter', input: plan, predicates } : plan;
}

/**
 * Move each WHERE/ON conjunct as close to the tables as its columns allow:
 * single-table predicates end up in the scans, two-sided ones in the join
 * that brings both sides together. LEFT JOIN is respected: a WHERE predicate
 * on the nullable side stays above the join, and an ON predicate on the
 * preserved side stays in the join condition.
 */
export function pushDown(plan: LogicalPlan, incoming: BoundExpr[] = []): LogicalPlan {
  switch (plan.kind) {
    case 'filter':
      return pushDown(plan.input, [...incoming, ...plan.predicates.flatMap(conjuncts)]);
    case 'scan':
      return incoming.length ? { ...plan, predicates: [...plan.predicates, ...incoming] } : plan;
    case 'empty':
      return plan;
    case 'values':
      return withFilter(plan, incoming);
    case 'join': {
      const leftIds = idsOf(plan.left);
      const rightIds = idsOf(plan.right);
      if (plan.joinType !== 'left') {
        const toLeft: BoundExpr[] = [];
        const toRight: BoundExpr[] = [];
        const here: BoundExpr[] = [];
        for (const p of [...incoming, ...plan.conditions.flatMap(conjuncts)]) {
          if (within(p, leftIds)) toLeft.push(p);
          else if (within(p, rightIds)) toRight.push(p);
          else here.push(p);
        }
        return {
          kind: 'join',
          joinType: here.length ? 'inner' : plan.joinType,
          left: pushDown(plan.left, toLeft),
          right: pushDown(plan.right, toRight),
          conditions: here,
        };
      }
      const toLeft: BoundExpr[] = [];
      const above: BoundExpr[] = [];
      for (const p of incoming) (within(p, leftIds) ? toLeft : above).push(p);
      const toRight: BoundExpr[] = [];
      const on: BoundExpr[] = [];
      for (const p of plan.conditions.flatMap(conjuncts)) {
        if (columnsOf(p).size > 0 && within(p, rightIds)) toRight.push(p);
        else on.push(p);
      }
      const join: LogicalPlan = {
        ...plan,
        left: pushDown(plan.left, toLeft),
        right: pushDown(plan.right, toRight),
        conditions: on,
      };
      return withFilter(join, above);
    }
    case 'aggregate':
    case 'project':
    case 'distinct':
    case 'sort':
    case 'limit':
      return withFilter({ ...plan, input: pushDown(plan.input) } as LogicalPlan, incoming);
  }
}
