import {
  exprToString,
  type AggregateCall,
  type BoundExpr,
  type ColumnInfo,
  type OutputColumn,
  type SortKey,
} from '../binder/bound.ts';
import type { IndexSchema } from '../catalog/schema.ts';
import type { Relation } from './logical.ts';

/** Key range of an index scan: equality on a prefix, then an optional range on the next column. */
export interface IndexBounds {
  /** One entry per leading index column; each is a list of alternatives (IN) or a single value. */
  readonly prefix: readonly (readonly BoundExpr[])[];
  readonly lower: { readonly value: BoundExpr; readonly inclusive: boolean } | undefined;
  readonly upper: { readonly value: BoundExpr; readonly inclusive: boolean } | undefined;
}

interface Base {
  readonly schema: ColumnInfo[];
  /** Estimated output rows. */
  readonly rows: number;
  /** Estimated total cost (abstract units: one sequential page read = 1). */
  readonly cost: number;
}

export type PhysicalPlan = Base &
  (
    | { op: 'SeqScan'; relation: Relation; filter: BoundExpr | undefined; withRowId: boolean }
    | {
        op: 'IndexScan';
        relation: Relation;
        index: IndexSchema;
        bounds: IndexBounds;
        filter: BoundExpr | undefined;
        withRowId: boolean;
      }
    | { op: 'Values' }
    | { op: 'Filter'; input: PhysicalPlan; predicate: BoundExpr }
    | { op: 'Project'; input: PhysicalPlan; outputs: OutputColumn[] }
    | {
        op: 'NestedLoopJoin';
        joinType: 'inner' | 'left' | 'cross';
        left: PhysicalPlan;
        right: PhysicalPlan;
        condition: BoundExpr | undefined;
      }
    | {
        op: 'HashJoin';
        joinType: 'inner' | 'left';
        /** Probe side. */
        left: PhysicalPlan;
        /** Build side (hashed into memory). */
        right: PhysicalPlan;
        leftKeys: BoundExpr[];
        rightKeys: BoundExpr[];
        residual: BoundExpr | undefined;
      }
    | {
        op: 'HashAggregate';
        input: PhysicalPlan;
        groupKeys: OutputColumn[];
        aggregates: AggregateCall[];
      }
    | { op: 'Sort'; input: PhysicalPlan; keys: SortKey[] }
    | { op: 'Limit'; input: PhysicalPlan; limit: number | undefined; offset: number }
    | { op: 'Distinct'; input: PhysicalPlan }
  );

export function childrenOfPlan(plan: PhysicalPlan): PhysicalPlan[] {
  switch (plan.op) {
    case 'SeqScan':
    case 'IndexScan':
    case 'Values':
      return [];
    case 'NestedLoopJoin':
    case 'HashJoin':
      return [plan.left, plan.right];
    default:
      return [plan.input];
  }
}

/** One-line description of what a node does, for EXPLAIN. */
export function describePlan(plan: PhysicalPlan): string {
  switch (plan.op) {
    case 'SeqScan': {
      const name = scanName(plan.relation);
      return plan.filter ? `${name} filter: ${exprToString(plan.filter)}` : name;
    }
    case 'IndexScan': {
      const cols = plan.index.columns.map((i) => plan.relation.table.columns[i]!.name);
      const parts: string[] = [];
      plan.bounds.prefix.forEach((alts, i) => {
        parts.push(
          alts.length === 1
            ? `${cols[i]} = ${exprToString(alts[0]!)}`
            : `${cols[i]} IN (${alts.map(exprToString).join(', ')})`,
        );
      });
      const next = cols[plan.bounds.prefix.length];
      if (plan.bounds.lower) {
        parts.push(
          `${next} ${plan.bounds.lower.inclusive ? '>=' : '>'} ${exprToString(plan.bounds.lower.value)}`,
        );
      }
      if (plan.bounds.upper) {
        parts.push(
          `${next} ${plan.bounds.upper.inclusive ? '<=' : '<'} ${exprToString(plan.bounds.upper.value)}`,
        );
      }
      let text = `${scanName(plan.relation)} using ${plan.index.name}`;
      if (parts.length > 0) text += ` (${parts.join(' AND ')})`;
      if (plan.filter) text += ` filter: ${exprToString(plan.filter)}`;
      return text;
    }
    case 'Values':
      return 'one row';
    case 'Filter':
      return exprToString(plan.predicate);
    case 'Project':
      return plan.outputs.map((o) => exprToString(o.expr)).join(', ');
    case 'NestedLoopJoin': {
      const kind = plan.joinType.toUpperCase();
      return plan.condition ? `${kind} on ${exprToString(plan.condition)}` : kind;
    }
    case 'HashJoin': {
      const keys = plan.leftKeys.map(
        (k, i) => `${exprToString(k)} = ${exprToString(plan.rightKeys[i]!)}`,
      );
      let text = `${plan.joinType.toUpperCase()} on ${keys.join(' AND ')}`;
      if (plan.residual) text += ` filter: ${exprToString(plan.residual)}`;
      return text;
    }
    case 'HashAggregate': {
      const aggs = plan.aggregates.map((a) => a.name);
      const keys = plan.groupKeys.map((k) => exprToString(k.expr));
      return [keys.length ? `group by ${keys.join(', ')}` : '', aggs.join(', ')]
        .filter(Boolean)
        .join('; ');
    }
    case 'Sort':
      return plan.keys
        .map(
          (k) =>
            `${exprToString(k.expr)}${k.desc ? ' DESC' : ''}${k.nullsFirst !== k.desc ? (k.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST') : ''}`,
        )
        .join(', ');
    case 'Limit':
      return [
        plan.limit !== undefined ? `limit ${plan.limit}` : '',
        plan.offset ? `offset ${plan.offset}` : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'Distinct':
      return '';
  }
}

function scanName(relation: Relation): string {
  return relation.alias === relation.table.name
    ? relation.table.name
    : `${relation.table.name} ${relation.alias}`;
}

/** EXPLAIN output as a tree of plain objects (what Studio draws). */
export interface PlanNodeInfo {
  readonly op: string;
  readonly detail: string;
  readonly rows: number;
  readonly cost: number;
  /** Rows actually produced (EXPLAIN ANALYZE only). */
  readonly actualRows?: number | undefined;
  /** Wall time spent in the node and its children, in ms (EXPLAIN ANALYZE only). */
  readonly timeMs?: number | undefined;
  readonly children: PlanNodeInfo[];
}

export function planToInfo(
  plan: PhysicalPlan,
  actual?: (node: PhysicalPlan) => { rows: number; timeMs: number } | undefined,
): PlanNodeInfo {
  const stats = actual?.(plan);
  return {
    op: plan.op,
    detail: describePlan(plan),
    rows: Math.round(plan.rows),
    cost: Math.round(plan.cost * 100) / 100,
    actualRows: stats?.rows,
    timeMs: stats ? Math.round(stats.timeMs * 1000) / 1000 : undefined,
    children: childrenOfPlan(plan).map((c) => planToInfo(c, actual)),
  };
}

/** Render a plan tree as indented text lines with box-drawing connectors. */
export function planToText(info: PlanNodeInfo): string[] {
  const lines: string[] = [];
  const visit = (node: PlanNodeInfo, prefix: string, childPrefix: string): void => {
    let line = `${prefix}${node.op}`;
    if (node.detail) line += ` ${node.detail}`;
    line += `  (rows=${node.rows} cost=${node.cost}`;
    if (node.actualRows !== undefined) line += ` actual=${node.actualRows} time=${node.timeMs}ms`;
    line += ')';
    lines.push(line);
    node.children.forEach((child, i) => {
      const last = i === node.children.length - 1;
      visit(
        child,
        `${childPrefix}${last ? '└─ ' : '├─ '}`,
        `${childPrefix}${last ? '   ' : '│  '}`,
      );
    });
  };
  visit(info, '', '');
  return lines;
}
