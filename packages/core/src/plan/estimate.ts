import { columnsOf, type BoundExpr, type ColumnId } from '../binder/bound.ts';
import type { ColumnStats, TableSchema } from '../catalog/schema.ts';
import type { Value } from '../types/datatype.ts';
import type { LogicalPlan } from './logical.ts';

/** What the planner needs to know about stored data. */
export interface PlannerContext {
  /** Current number of stored rows in a table (an estimate is fine). */
  rowCount(table: TableSchema): number;
}

/** Cost constants, in units of one sequential page read. */
export const COST = {
  /** Processing one row. */
  cpuTuple: 0.01,
  /** Evaluating one operator or hash probe. */
  cpuOperator: 0.0025,
  /** Rows per 4 KB page, used to turn row counts into page reads. */
  rowsPerPage: 50,
  /** Fetching one row through an index (cached B+tree descent + row lookup). */
  indexRow: 0.2,
} as const;

/** Selectivity of a predicate the estimator knows nothing about. */
export const DEFAULT_SELECTIVITY = 1 / 3;
/** Distinct values assumed for a column without statistics. */
const DEFAULT_DISTINCT = 200;

interface BaseColumn {
  readonly table: TableSchema;
  readonly column: number;
}

/**
 * Cardinality estimation: row counts come from the live tuple counters,
 * distinct counts and value ranges from ANALYZE when it has run, and textbook
 * defaults otherwise.
 */
export class Estimator {
  private readonly ctx: PlannerContext;
  private readonly base = new Map<ColumnId, BaseColumn>();

  constructor(ctx: PlannerContext, plans: readonly LogicalPlan[]) {
    this.ctx = ctx;
    for (const plan of plans) this.collect(plan);
  }

  private collect(plan: LogicalPlan): void {
    switch (plan.kind) {
      case 'scan':
        plan.relation.columns.forEach((c, i) =>
          this.base.set(c.id, { table: plan.relation.table, column: i }),
        );
        return;
      case 'values':
      case 'empty':
        return;
      case 'join':
        this.collect(plan.left);
        this.collect(plan.right);
        return;
      default:
        this.collect(plan.input);
    }
  }

  tableRows(table: TableSchema): number {
    return Math.max(0, this.ctx.rowCount(table));
  }

  private stats(
    id: ColumnId,
  ): { stats: ColumnStats | undefined; rows: number; base: BaseColumn } | undefined {
    const base = this.base.get(id);
    if (!base) return undefined;
    const rows = this.tableRows(base.table);
    const stats = base.table.stats;
    return { stats: stats?.columns[base.column], rows, base };
  }

  /** Estimated number of distinct values of a column. */
  distinct(id: ColumnId): number {
    const info = this.stats(id);
    if (!info) return DEFAULT_DISTINCT;
    const { stats, rows, base } = info;
    const unique = base.table.indexes.some(
      (ix) => ix.unique && ix.columns.length === 1 && ix.columns[0] === base.column,
    );
    if (unique) return Math.max(1, rows);
    if (stats) {
      const analyzedRows = base.table.stats!.rowCount;
      // A near-unique column grows with the table; a low-cardinality one does not.
      if (analyzedRows > 0 && stats.distinct >= 0.9 * analyzedRows * (1 - stats.nullFraction)) {
        return Math.max(1, Math.round((stats.distinct * rows) / analyzedRows));
      }
      return Math.max(1, stats.distinct);
    }
    return Math.max(1, Math.min(rows, DEFAULT_DISTINCT));
  }

  /** Fraction of rows for which `e` is TRUE. */
  selectivity(e: BoundExpr): number {
    return clamp(this.selectivityOf(e));
  }

  private selectivityOf(e: BoundExpr): number {
    switch (e.kind) {
      case 'const':
        return e.value === true ? 1 : 0;
      case 'and':
        return this.conjunction(conjunctsOf(e));
      case 'or': {
        const a = this.selectivity(e.left);
        const b = this.selectivity(e.right);
        return a + b - a * b;
      }
      case 'not':
        return 1 - this.selectivity(e.operand);
      case 'is_null': {
        const s = e.operand.kind === 'column' ? this.nullFraction(e.operand.id) : 0.05;
        return e.negated ? 1 - s : s;
      }
      case 'compare':
        return this.compareSelectivity(e);
      case 'in_list': {
        if (e.operand.kind !== 'column') return DEFAULT_SELECTIVITY;
        const s = Math.min(1, e.list.length / this.distinct(e.operand.id));
        return e.negated ? 1 - s : s;
      }
      case 'like':
        return e.negated ? 0.9 : 0.1;
      case 'in_subquery':
        return 0.5;
      default:
        return DEFAULT_SELECTIVITY;
    }
  }

  /**
   * Conjuncts are treated as independent, except that bounds on the same
   * numeric column combine into one interval: `g >= 400 AND g <= 409` covers
   * 1% of [min, max], not P(g >= 400) * P(g <= 409), which would be 60 times
   * more for uniform data between 1 and 1000. PostgreSQL's
   * clauselist_selectivity makes the same correction.
   */
  private conjunction(conjuncts: BoundExpr[]): number {
    const intervals = new Map<ColumnId, { lower?: number; upper?: number }>();
    let s = 1;
    for (const c of conjuncts) {
      const bound = rangeBound(c);
      const stats = bound && this.stats(bound.id)?.stats;
      if (!bound || typeof stats?.min !== 'number' || typeof stats.max !== 'number') {
        s *= this.selectivity(c);
        continue;
      }
      const interval = intervals.get(bound.id) ?? {};
      if (bound.lower) interval.lower = Math.max(interval.lower ?? -Infinity, bound.value);
      else interval.upper = Math.min(interval.upper ?? Infinity, bound.value);
      intervals.set(bound.id, interval);
    }
    for (const [id, { lower, upper }] of intervals) {
      const stats = this.stats(id)!.stats!;
      const min = stats.min as number;
      const max = stats.max as number;
      const below = (v: number | undefined, fallback: number): number =>
        v === undefined
          ? fallback
          : max <= min
            ? v >= min
              ? 1
              : 0
            : clamp((v - min) / (max - min));
      let fraction = below(upper, 1) - below(lower, 0);
      // A closed interval holds at least one value's worth of rows (BETWEEN 5 AND 5).
      if (lower !== undefined && upper !== undefined)
        fraction = Math.max(fraction, 1 / this.distinct(id));
      s *= clamp(fraction) * (1 - stats.nullFraction);
    }
    return s;
  }

  private nullFraction(id: ColumnId): number {
    const info = this.stats(id);
    if (info?.stats) return info.stats.nullFraction;
    return 0.05;
  }

  private compareSelectivity(e: Extract<BoundExpr, { kind: 'compare' }>): number {
    const leftCol = e.left.kind === 'column' ? e.left : undefined;
    const rightCol = e.right.kind === 'column' ? e.right : undefined;
    if (leftCol && rightCol) {
      if (e.op === '=') return 1 / Math.max(this.distinct(leftCol.id), this.distinct(rightCol.id));
      return DEFAULT_SELECTIVITY;
    }
    const column = leftCol ?? rightCol;
    const other = leftCol ? e.right : e.left;
    if (!column || columnsOf(other).size > 0) return DEFAULT_SELECTIVITY;
    const ndv = this.distinct(column.id);
    switch (e.op) {
      case '=':
        return (1 - this.nullFraction(column.id)) / ndv;
      case '<>':
        return (1 - this.nullFraction(column.id)) * (1 - 1 / ndv);
      default: {
        const value = other.kind === 'const' ? other.value : undefined;
        const op = leftCol ? e.op : flip(e.op);
        return this.rangeSelectivity(column.id, op, value);
      }
    }
  }

  /** Fraction of a numeric column's [min, max] range selected by `column op value`. */
  private rangeSelectivity(id: ColumnId, op: string, value: Value | undefined): number {
    const stats = this.stats(id)?.stats;
    if (
      !stats ||
      typeof value !== 'number' ||
      typeof stats.min !== 'number' ||
      typeof stats.max !== 'number'
    ) {
      return DEFAULT_SELECTIVITY;
    }
    const { min, max } = stats;
    if (max <= min) return value >= min === (op === '>' || op === '>=') ? 1 : 0;
    const below = (value - min) / (max - min);
    const fraction = op === '<' || op === '<=' ? below : 1 - below;
    return clamp(fraction) * (1 - stats.nullFraction);
  }
}

function conjunctsOf(e: BoundExpr): BoundExpr[] {
  return e.kind === 'and' ? [...conjunctsOf(e.left), ...conjunctsOf(e.right)] : [e];
}

/** `column < | <= | > | >= number` (either way round) as a bound on the column. */
function rangeBound(e: BoundExpr): { id: ColumnId; lower: boolean; value: number } | undefined {
  if (e.kind !== 'compare' || !['<', '<=', '>', '>='].includes(e.op)) return undefined;
  const [column, other, op] =
    e.left.kind === 'column' ? [e.left, e.right, e.op] : [e.right, e.left, flip(e.op)];
  if (column.kind !== 'column' || other.kind !== 'const' || typeof other.value !== 'number') {
    return undefined;
  }
  return { id: column.id, lower: op === '>' || op === '>=', value: other.value };
}

function flip(op: string): string {
  return op === '<' ? '>' : op === '>' ? '<' : op === '<=' ? '>=' : op === '>=' ? '<=' : op;
}

function clamp(s: number): number {
  if (!Number.isFinite(s)) return DEFAULT_SELECTIVITY;
  return Math.min(1, Math.max(0, s));
}
