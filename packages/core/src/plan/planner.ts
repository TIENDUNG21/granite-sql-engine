import { andAll, type BoundExpr } from '../binder/bound.ts';
import type { TableSchema } from '../catalog/schema.ts';
import { schemaOf, type LogicalPlan } from './logical.ts';
import type { PhysicalPlan } from './physical.ts';

/** What the planner needs to know about stored data. */
export interface PlannerContext {
  /** Current number of rows in a table (an estimate is fine). */
  rowCount(table: TableSchema): number;
}

/** Cost constants, in units of one sequential page read. */
export const COST = {
  cpuTuple: 0.01,
  cpuOperator: 0.0025,
  rowsPerPage: 50,
} as const;

/** Default selectivity of a predicate we know nothing about. */
const DEFAULT_SELECTIVITY = 1 / 3;

/** Turn a logical plan into an executable physical plan (no optimization yet). */
export function toPhysical(plan: LogicalPlan, ctx: PlannerContext): PhysicalPlan {
  switch (plan.kind) {
    case 'scan': {
      const n = ctx.rowCount(plan.relation.table);
      const filter = andAll(plan.predicates);
      const rows = n * DEFAULT_SELECTIVITY ** plan.predicates.length;
      return {
        op: 'SeqScan',
        relation: plan.relation,
        filter,
        withRowId: plan.withRowId,
        schema: schemaOf(plan),
        rows,
        cost: Math.ceil(n / COST.rowsPerPage) + n * COST.cpuTuple,
      };
    }
    case 'values':
      return { op: 'Values', schema: [], rows: 1, cost: 0 };
    case 'filter': {
      const input = toPhysical(plan.input, ctx);
      return filterNode(input, plan.predicates);
    }
    case 'join': {
      const left = toPhysical(plan.left, ctx);
      const right = toPhysical(plan.right, ctx);
      const condition = andAll(plan.conditions);
      const rows = left.rows * right.rows * (condition ? DEFAULT_SELECTIVITY : 1);
      return {
        op: 'NestedLoopJoin',
        joinType: plan.joinType,
        left,
        right,
        condition,
        schema: [...left.schema, ...right.schema],
        rows: plan.joinType === 'left' ? Math.max(rows, left.rows) : rows,
        cost: left.cost + right.cost + left.rows * right.rows * COST.cpuOperator,
      };
    }
    case 'aggregate': {
      const input = toPhysical(plan.input, ctx);
      const rows = plan.groupKeys.length === 0 ? 1 : Math.max(1, input.rows / 10);
      return {
        op: 'HashAggregate',
        input,
        groupKeys: plan.groupKeys,
        aggregates: plan.aggregates,
        schema: schemaOf(plan),
        rows,
        cost:
          input.cost +
          input.rows * COST.cpuOperator * (plan.groupKeys.length + plan.aggregates.length),
      };
    }
    case 'project': {
      const input = toPhysical(plan.input, ctx);
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
      const input = toPhysical(plan.input, ctx);
      return {
        op: 'Distinct',
        input,
        schema: input.schema,
        rows: input.rows,
        cost: input.cost + input.rows * COST.cpuOperator,
      };
    }
    case 'sort': {
      const input = toPhysical(plan.input, ctx);
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
      const input = toPhysical(plan.input, ctx);
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

function filterNode(input: PhysicalPlan, predicates: BoundExpr[]): PhysicalPlan {
  const predicate = andAll(predicates);
  if (!predicate) return input;
  return {
    op: 'Filter',
    input,
    predicate,
    schema: input.schema,
    rows: input.rows * DEFAULT_SELECTIVITY ** predicates.length,
    cost: input.cost + input.rows * COST.cpuOperator,
  };
}
