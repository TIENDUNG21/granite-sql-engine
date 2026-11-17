import { andAll, columnsOf, conjuncts, type BoundExpr, type ColumnId } from '../binder/bound.ts';
import type { IndexSchema } from '../catalog/schema.ts';
import { COST, Estimator, type PlannerContext } from './estimate.ts';
import { schemaOf, type LogicalPlan } from './logical.ts';
import type { IndexBounds, PhysicalPlan } from './physical.ts';
import { foldPlan, pushDown } from './rewrite.ts';

export type { PlannerContext } from './estimate.ts';

/** Joins with more relations than this are ordered greedily instead of by DP. */
const MAX_DP_RELATIONS = 10;

/**
 * Optimize a logical plan into an executable physical plan:
 * constant folding -> predicate pushdown -> access paths (seq vs index scan)
 * -> cost-based join order and join algorithm -> physical operators.
 */
export function planQuery(plan: LogicalPlan, ctx: PlannerContext): PhysicalPlan {
  const rewritten = pushDown(foldPlan(plan));
  return new Planner(new Estimator(ctx, [rewritten])).lower(rewritten);
}

type Scan = Extract<LogicalPlan, { kind: 'scan' }>;
type Join = Extract<LogicalPlan, { kind: 'join' }>;

class Planner {
  private readonly est: Estimator;

  constructor(est: Estimator) {
    this.est = est;
  }

  lower(plan: LogicalPlan): PhysicalPlan {
    switch (plan.kind) {
      case 'scan':
        return this.accessPath(plan);
      case 'values':
        return { op: 'Values', schema: [], rows: 1, cost: 0 };
      case 'empty':
        return { op: 'Empty', reason: plan.reason, schema: plan.schema, rows: 0, cost: 0 };
      case 'filter':
        return this.filter(this.lower(plan.input), plan.predicates);
      case 'join':
        return plan.joinType === 'left' ? this.leftJoin(plan) : this.innerJoinGroup(plan);
      case 'aggregate': {
        const input = this.lower(plan.input);
        let rows = 1;
        if (plan.groupKeys.length > 0) {
          rows = plan.groupKeys.reduce(
            (n, k) =>
              n *
              (k.expr.kind === 'column'
                ? this.est.distinct(k.expr.id)
                : Math.max(1, input.rows / 10)),
            1,
          );
          rows = Math.max(1, Math.min(rows, input.rows));
        }
        return {
          op: 'HashAggregate',
          input,
          groupKeys: plan.groupKeys,
          aggregates: plan.aggregates,
          schema: schemaOf(plan),
          rows,
          cost:
            input.cost +
            input.rows * COST.cpuOperator * (plan.groupKeys.length + plan.aggregates.length + 1),
        };
      }
      case 'project': {
        const input = this.lower(plan.input);
        return {
          op: 'Project',
          input,
          outputs: plan.outputs,
          schema: schemaOf(plan),
          rows: input.rows,
          cost: input.cost + input.rows * COST.cpuOperator * plan.outputs.length,
        };
      }
      case 'distinct': {
        const input = this.lower(plan.input);
        return {
          op: 'Distinct',
          input,
          schema: input.schema,
          rows: input.rows,
          cost: input.cost + input.rows * COST.cpuOperator,
        };
      }
      case 'sort': {
        const input = this.lower(plan.input);
        const n = Math.max(input.rows, 2);
        return {
          op: 'Sort',
          input,
          keys: plan.keys,
          schema: input.schema,
          rows: input.rows,
          cost: input.cost + n * Math.log2(n) * COST.cpuOperator * plan.keys.length,
        };
      }
      case 'limit': {
        const input = this.lower(plan.input);
        const rows = Math.min(Math.max(0, input.rows - plan.offset), plan.limit ?? Infinity);
        return {
          op: 'Limit',
          input,
          limit: plan.limit,
          offset: plan.offset,
          schema: input.schema,
          rows,
          cost: input.cost,
        };
      }
    }
  }

  private filter(input: PhysicalPlan, predicates: BoundExpr[]): PhysicalPlan {
    const predicate = andAll(predicates);
    if (!predicate) return input;
    return {
      op: 'Filter',
      input,
      predicate,
      schema: input.schema,
      rows: input.rows * this.est.selectivity(predicate),
      cost: input.cost + input.rows * COST.cpuOperator,
    };
  }

  // ---------------------------------------------------------- access paths

  /** Choose between a sequential scan and each usable index. */
  private accessPath(scan: Scan): PhysicalPlan {
    const table = scan.relation.table;
    const n = this.est.tableRows(table);
    const predicates = scan.predicates.flatMap(conjuncts);
    const filter = andAll(predicates);
    const rows = n * (filter ? this.est.selectivity(filter) : 1);
    const schema = schemaOf(scan);
    let best: PhysicalPlan = {
      op: 'SeqScan',
      relation: scan.relation,
      filter,
      withRowId: scan.withRowId,
      schema,
      rows,
      cost: Math.ceil(n / COST.rowsPerPage) + n * COST.cpuTuple,
    };
    for (const index of table.indexes) {
      const match = matchIndex(index, scan, predicates);
      if (!match) continue;
      const matchedSel = match.used.reduce((s, p) => s * this.est.selectivity(p), 1);
      const fullKeyEquality =
        index.unique &&
        match.bounds.prefix.length === index.columns.length &&
        match.bounds.prefix.every((alts) => alts.length === 1);
      const matched = fullKeyEquality ? Math.min(1, n) : n * matchedSel;
      const probes = match.bounds.prefix.reduce((m, alts) => m * alts.length, 1);
      const cost = probes * 2 + matched * (COST.indexRow + COST.cpuTuple);
      if (cost < best.cost) {
        const residual = andAll(predicates.filter((p) => !match.used.includes(p)));
        best = {
          op: 'IndexScan',
          relation: scan.relation,
          index,
          bounds: match.bounds,
          filter: residual,
          withRowId: scan.withRowId,
          schema,
          rows: Math.min(rows, matched),
          cost,
        };
      }
    }
    return best;
  }

  // ----------------------------------------------------------------- joins

  private leftJoin(plan: Join): PhysicalPlan {
    const left = this.lower(plan.left);
    const right = this.lower(plan.right);
    return this.join('left', left, right, plan.conditions);
  }

  /**
   * Flatten a tree of inner/cross joins into relations + conditions and pick
   * the cheapest left-deep order (dynamic programming over subsets).
   */
  private innerJoinGroup(plan: Join): PhysicalPlan {
    const leaves: LogicalPlan[] = [];
    const conditions: BoundExpr[] = [];
    const flatten = (p: LogicalPlan): void => {
      if (p.kind === 'join' && p.joinType !== 'left') {
        flatten(p.left);
        flatten(p.right);
        conditions.push(...p.conditions.flatMap(conjuncts));
      } else leaves.push(p);
    };
    flatten(plan);
    const relations = leaves.map((leaf) => ({
      plan: this.lower(leaf),
      ids: new Set(schemaOf(leaf).map((c) => c.id)),
    }));
    const condColumns = conditions.map((c) => columnsOf(c));
    const covers = (ids: ReadonlySet<ColumnId>, i: number): boolean => {
      for (const id of condColumns[i]!) if (!ids.has(id)) return false;
      return true;
    };

    const n = relations.length;
    const idsOfMask = (mask: number): Set<ColumnId> => {
      const out = new Set<ColumnId>();
      relations.forEach((r, i) => {
        if (mask & (1 << i)) for (const id of r.ids) out.add(id);
      });
      return out;
    };
    const step = (prev: PhysicalPlan, prevMask: number, r: number): PhysicalPlan => {
      const mask = prevMask | (1 << r);
      const before = idsOfMask(prevMask);
      const after = idsOfMask(mask);
      const applicable = conditions.filter(
        (_, i) => covers(after, i) && !covers(before, i) && !covers(relations[r]!.ids, i),
      );
      return this.join('inner', prev, relations[r]!.plan, applicable);
    };

    let result: PhysicalPlan;
    const fullMask = (1 << n) - 1;
    if (n <= MAX_DP_RELATIONS) {
      const best = new Map<number, PhysicalPlan>();
      relations.forEach((r, i) => best.set(1 << i, r.plan));
      for (let mask = 1; mask <= fullMask; mask++) {
        if ((mask & (mask - 1)) === 0) continue; // single relation
        let winner: PhysicalPlan | undefined;
        for (let r = 0; r < n; r++) {
          if (!(mask & (1 << r))) continue;
          const prev = best.get(mask ^ (1 << r));
          if (!prev) continue;
          const candidate = step(prev, mask ^ (1 << r), r);
          if (!winner || candidate.cost < winner.cost) winner = candidate;
        }
        best.set(mask, winner!);
      }
      result = best.get(fullMask)!;
    } else {
      // Greedy: start from the smallest input, then add the cheapest next join.
      const start = relations.reduce(
        (b, r, i) => (r.plan.rows < relations[b]!.plan.rows ? i : b),
        0,
      );
      let mask = 1 << start;
      let current = relations[start]!.plan;
      while (mask !== fullMask) {
        let winner: { plan: PhysicalPlan; r: number } | undefined;
        for (let r = 0; r < n; r++) {
          if (mask & (1 << r)) continue;
          const candidate = step(current, mask, r);
          if (!winner || candidate.cost < winner.plan.cost) winner = { plan: candidate, r };
        }
        mask |= 1 << winner!.r;
        current = winner!.plan;
      }
      result = current;
    }
    // Conditions no join step takes: constant ones, or (defensively) single-relation ones.
    const leftover = conditions.filter(
      (_, i) => condColumns[i]!.size === 0 || relations.some((r) => covers(r.ids, i)),
    );
    return this.filter(result, leftover);
  }

  /** Build a join node: a hash join when there is an equality between the sides. */
  private join(
    type: 'inner' | 'left',
    left: PhysicalPlan,
    right: PhysicalPlan,
    conditions: BoundExpr[],
  ): PhysicalPlan {
    const leftIds = new Set(left.schema.map((c) => c.id));
    const rightIds = new Set(right.schema.map((c) => c.id));
    const leftKeys: BoundExpr[] = [];
    const rightKeys: BoundExpr[] = [];
    const residual: BoundExpr[] = [];
    for (const c of conditions) {
      const sides =
        c.kind === 'compare' && c.op === '=' ? equiSides(c, leftIds, rightIds) : undefined;
      if (sides) {
        leftKeys.push(sides[0]);
        rightKeys.push(sides[1]);
      } else residual.push(c);
    }
    const selectivity = conditions.reduce((s, c) => s * this.est.selectivity(c), 1);
    let rows = left.rows * right.rows * selectivity;
    if (type === 'left') rows = Math.max(rows, left.rows);
    const schema = [...left.schema, ...right.schema];
    const out = rows * COST.cpuTuple;

    if (leftKeys.length > 0) {
      // Hash the smaller input (only the right side may be hashed for LEFT JOIN).
      const swap = type === 'inner' && right.rows > left.rows;
      const probe = swap ? right : left;
      const build = swap ? left : right;
      return {
        op: 'HashJoin',
        joinType: type,
        left: probe,
        right: build,
        leftKeys: swap ? rightKeys : leftKeys,
        rightKeys: swap ? leftKeys : rightKeys,
        residual: andAll(residual),
        schema: swap ? [...right.schema, ...left.schema] : schema,
        rows,
        cost:
          left.cost +
          right.cost +
          build.rows * (COST.cpuTuple + COST.cpuOperator) +
          probe.rows * COST.cpuOperator * leftKeys.length +
          out,
      };
    }
    return {
      op: 'NestedLoopJoin',
      joinType: conditions.length === 0 && type === 'inner' ? 'cross' : type,
      left,
      right,
      condition: andAll(conditions),
      schema,
      rows,
      cost: left.cost + right.cost + left.rows * right.rows * COST.cpuOperator + out,
    };
  }
}

/** For `a = b` with a on one side and b on the other, the [left, right] keys. */
function equiSides(
  c: Extract<BoundExpr, { kind: 'compare' }>,
  leftIds: ReadonlySet<ColumnId>,
  rightIds: ReadonlySet<ColumnId>,
): [BoundExpr, BoundExpr] | undefined {
  const l = columnsOf(c.left);
  const r = columnsOf(c.right);
  if (l.size === 0 || r.size === 0) return undefined;
  const inside = (cols: Set<ColumnId>, ids: ReadonlySet<ColumnId>) =>
    [...cols].every((id) => ids.has(id));
  if (inside(l, leftIds) && inside(r, rightIds)) return [c.left, c.right];
  if (inside(l, rightIds) && inside(r, leftIds)) return [c.right, c.left];
  return undefined;
}

// ------------------------------------------------------------ index matching

interface IndexMatch {
  readonly bounds: IndexBounds;
  /** Predicates fully answered by the index range. */
  readonly used: BoundExpr[];
}

/** A row-independent expression that can serve as an index key bound. */
function isKeyValue(e: BoundExpr): boolean {
  return columnsOf(e).size === 0 && e.kind !== 'in_subquery';
}

/** `column op value` normalized so the column is on the left, or undefined. */
function columnComparison(
  p: BoundExpr,
  columnId: ColumnId,
): { op: string; value: BoundExpr } | undefined {
  if (p.kind !== 'compare') return undefined;
  if (p.left.kind === 'column' && p.left.id === columnId && isKeyValue(p.right))
    return { op: p.op, value: p.right };
  if (p.right.kind === 'column' && p.right.id === columnId && isKeyValue(p.left)) {
    const flipped: Record<string, string> = {
      '<': '>',
      '>': '<',
      '<=': '>=',
      '>=': '<=',
      '=': '=',
      '<>': '<>',
    };
    return { op: flipped[p.op]!, value: p.left };
  }
  return undefined;
}

/**
 * Match predicates against an index: equality (or IN-list) on a prefix of its
 * columns, then optionally a range on the next column.
 */
function matchIndex(
  index: IndexSchema,
  scan: Scan,
  predicates: BoundExpr[],
): IndexMatch | undefined {
  const prefix: BoundExpr[][] = [];
  const used: BoundExpr[] = [];
  let lower: IndexBounds['lower'];
  let upper: IndexBounds['upper'];
  for (const position of index.columns) {
    const id = scan.relation.columns[position]!.id;
    const eq = predicates.find((p) => columnComparison(p, id)?.op === '=');
    if (eq) {
      prefix.push([columnComparison(eq, id)!.value]);
      used.push(eq);
      continue;
    }
    const list = predicates.find(
      (p) =>
        p.kind === 'in_list' &&
        !p.negated &&
        p.operand.kind === 'column' &&
        p.operand.id === id &&
        p.list.every(isKeyValue),
    );
    if (list && list.kind === 'in_list') {
      prefix.push(list.list);
      used.push(list);
      continue;
    }
    for (const p of predicates) {
      const cmp = columnComparison(p, id);
      if (!cmp) continue;
      if ((cmp.op === '>' || cmp.op === '>=') && !lower) {
        lower = { value: cmp.value, inclusive: cmp.op === '>=' };
        used.push(p);
      } else if ((cmp.op === '<' || cmp.op === '<=') && !upper) {
        upper = { value: cmp.value, inclusive: cmp.op === '<=' };
        used.push(p);
      }
    }
    break;
  }
  if (used.length === 0) return undefined;
  return { bounds: { prefix, lower, upper }, used };
}
