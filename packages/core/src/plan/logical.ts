import type {
  AggregateCall,
  BoundExpr,
  BoundFrom,
  BoundSelect,
  ColumnInfo,
  OutputColumn,
  SortKey,
} from '../binder/bound.ts';
import type { TableSchema } from '../catalog/schema.ts';

export type Relation = Extract<BoundFrom, { kind: 'relation' }>;

/** Hidden column carrying the row id of a scanned tuple (used by UPDATE/DELETE). */
export const ROWID_COLUMN_ID = 0;

/**
 * Relational algebra the optimizer rewrites. Every node knows its output schema
 * as a list of column ids, so rewrites never have to renumber positions.
 */
export type LogicalPlan =
  | {
      kind: 'scan';
      relation: Relation;
      /** Conjuncts pushed down to this scan. */
      predicates: BoundExpr[];
      withRowId: boolean;
    }
  | { kind: 'values' }
  /** A subtree proven to return no rows (e.g. WHERE 1 = 0). */
  | { kind: 'empty'; schema: ColumnInfo[]; reason: string }
  | { kind: 'filter'; input: LogicalPlan; predicates: BoundExpr[] }
  | {
      kind: 'join';
      joinType: 'inner' | 'left' | 'cross';
      left: LogicalPlan;
      right: LogicalPlan;
      /** Join conjuncts; empty for a cross product. */
      conditions: BoundExpr[];
    }
  | {
      kind: 'aggregate';
      input: LogicalPlan;
      groupKeys: OutputColumn[];
      aggregates: AggregateCall[];
    }
  | { kind: 'project'; input: LogicalPlan; outputs: OutputColumn[] }
  | { kind: 'distinct'; input: LogicalPlan }
  | { kind: 'sort'; input: LogicalPlan; keys: SortKey[] }
  | { kind: 'limit'; input: LogicalPlan; limit: number | undefined; offset: number };

export function schemaOf(plan: LogicalPlan): ColumnInfo[] {
  switch (plan.kind) {
    case 'scan':
      return plan.withRowId
        ? [...plan.relation.columns, rowIdColumn(plan.relation.table)]
        : plan.relation.columns;
    case 'values':
      return [];
    case 'empty':
      return plan.schema;
    case 'filter':
    case 'distinct':
    case 'sort':
    case 'limit':
      return schemaOf(plan.input);
    case 'join':
      return [...schemaOf(plan.left), ...schemaOf(plan.right)];
    case 'aggregate':
      return [
        ...plan.groupKeys.map((k) => ({ id: k.id, name: k.name, table: undefined, type: k.type })),
        ...plan.aggregates.map((a) => ({ id: a.id, name: a.name, table: undefined, type: a.type })),
      ];
    case 'project':
      return plan.outputs.map((o) => ({ id: o.id, name: o.name, table: undefined, type: o.type }));
  }
}

export function rowIdColumn(table: TableSchema): ColumnInfo {
  return { id: ROWID_COLUMN_ID, name: 'rowid', table: table.name, type: 'INTEGER' };
}

function fromToPlan(from: BoundFrom): LogicalPlan {
  if (from.kind === 'relation')
    return { kind: 'scan', relation: from, predicates: [], withRowId: false };
  return {
    kind: 'join',
    joinType: from.joinType,
    left: fromToPlan(from.left),
    right: fromToPlan(from.right),
    conditions: from.on ? [from.on] : [],
  };
}

/**
 * The canonical (unoptimized) plan of a SELECT:
 * FROM -> WHERE -> GROUP BY/aggregates -> HAVING -> project -> DISTINCT -> ORDER BY -> LIMIT -> drop hidden.
 */
export function selectToPlan(q: BoundSelect): LogicalPlan {
  let plan: LogicalPlan = q.from ? fromToPlan(q.from) : { kind: 'values' };
  if (q.where) plan = { kind: 'filter', input: plan, predicates: [q.where] };
  if (q.aggregated) {
    plan = { kind: 'aggregate', input: plan, groupKeys: q.groupKeys, aggregates: q.aggregates };
    if (q.having) plan = { kind: 'filter', input: plan, predicates: [q.having] };
  }
  plan = { kind: 'project', input: plan, outputs: [...q.outputs, ...q.hidden] };
  if (q.distinct) plan = { kind: 'distinct', input: plan };
  if (q.orderBy.length > 0) plan = { kind: 'sort', input: plan, keys: q.orderBy };
  if (q.limit !== undefined || q.offset > 0) {
    plan = { kind: 'limit', input: plan, limit: q.limit, offset: q.offset };
  }
  if (q.hidden.length > 0) {
    plan = {
      kind: 'project',
      input: plan,
      outputs: q.outputs.map((o) => ({
        expr: { kind: 'column', id: o.id, name: o.name, table: undefined, type: o.type },
        id: o.id,
        name: o.name,
        type: o.type,
      })),
    };
  }
  return plan;
}

/** Plan that reads the rows an UPDATE or DELETE touches, with their row ids. */
export function targetRowsPlan(relation: Relation, where: BoundExpr | undefined): LogicalPlan {
  const scan: LogicalPlan = { kind: 'scan', relation, predicates: [], withRowId: true };
  return where ? { kind: 'filter', input: scan, predicates: [where] } : scan;
}
