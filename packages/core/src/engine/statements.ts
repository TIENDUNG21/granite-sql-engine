import type { BoundSelect, BoundStatement } from '../binder/bound.ts';
import { bindStatement } from '../binder/binder.ts';
import type { Catalog } from '../catalog/catalog.ts';
import type { TableSchema, TableStats } from '../catalog/schema.ts';
import { GraniteError } from '../errors.ts';
import {
  EMPTY_LAYOUT,
  compileExpr,
  layoutOf,
  type Row,
  type SubqueryResults,
} from '../exec/eval.ts';
import { buildOperator, collect, tooManyRows, type ExecContext } from '../exec/operators.ts';
import type { RowStore } from '../exec/row-source.ts';
import { selectToPlan, targetRowsPlan, type LogicalPlan } from '../plan/logical.ts';
import { planToInfo, planToText, type PhysicalPlan, type PlanNodeInfo } from '../plan/physical.ts';
import { planQuery } from '../plan/planner.ts';
import type { Statement } from '../sql/ast.ts';
import type { Value } from '../types/datatype.ts';
import { compareValues, hashKey1 } from '../types/value.ts';
import { okResult, type QueryResult } from './result.ts';

/** The pieces of a database a statement runs against. */
export interface Engine {
  readonly catalog: Catalog;
  readonly store: RowStore;
}

/** Compiled form of one statement: how to run it and how to describe it. */
interface Prepared {
  run(ctx: ExecContext): QueryResult;
  /** Plan tree for EXPLAIN (undefined for statements without a plan). */
  plan: PhysicalPlan | undefined;
  /** Label of the top node EXPLAIN shows above the plan, e.g. "Update orders". */
  wrapper: string | undefined;
}

export function executeStatement(
  engine: Engine,
  stmt: Statement,
  params: readonly Value[],
  source: string,
): QueryResult {
  if (stmt.kind === 'explain') return explain(engine, stmt.statement, stmt.analyze, params, source);
  const bound = bindStatement(stmt, { catalog: engine.catalog, params, source });
  const prepared = prepare(engine, bound);
  return prepared.run(context(engine, bound));
}

function context(engine: Engine, bound: BoundStatement, stats?: ExecContext['stats']): ExecContext {
  const plans = 'subqueries' in bound ? bound.subqueries.map((q) => planSelect(engine, q)) : [];
  const ctx: ExecContext = {
    source: engine.store,
    subqueries: new LazySubqueries(plans, () => ctx),
    stats,
  };
  return ctx;
}

function planLogical(engine: Engine, plan: LogicalPlan): PhysicalPlan {
  return planQuery(plan, { rowCount: (t) => engine.store.rowCount(t) });
}

function planSelect(engine: Engine, q: BoundSelect): PhysicalPlan {
  return planLogical(engine, selectToPlan(q));
}

/** Runs each uncorrelated subquery at most once per statement, on first use. */
class LazySubqueries implements SubqueryResults {
  private readonly sets = new Map<number, { keys: Set<string>; hasNull: boolean }>();
  private readonly scalars = new Map<number, Value>();
  private readonly plans: PhysicalPlan[];
  private readonly ctx: () => ExecContext;

  constructor(plans: PhysicalPlan[], ctx: () => ExecContext) {
    this.plans = plans;
    this.ctx = ctx;
  }

  inSet(index: number): { keys: ReadonlySet<string>; hasNull: boolean } {
    let entry = this.sets.get(index);
    if (!entry) {
      entry = { keys: new Set(), hasNull: false };
      for (const row of collect(this.plans[index]!, this.ctx())) {
        const v = row[0]!;
        if (v === null) entry.hasNull = true;
        else entry.keys.add(hashKey1(v));
      }
      this.sets.set(index, entry);
    }
    return entry;
  }

  scalar(index: number): Value {
    if (!this.scalars.has(index)) {
      const op = buildOperator(this.plans[index]!, this.ctx());
      op.open();
      try {
        const first = op.next();
        if (first !== undefined && op.next() !== undefined) throw tooManyRows();
        this.scalars.set(index, first === undefined ? null : first[0]!);
      } finally {
        op.close();
      }
    }
    return this.scalars.get(index)!;
  }
}

function prepare(engine: Engine, bound: BoundStatement): Prepared {
  switch (bound.kind) {
    case 'select': {
      const plan = planSelect(engine, bound.query);
      return {
        plan,
        wrapper: undefined,
        run: (ctx) => {
          const rows = collect(plan, ctx);
          const columns = bound.query.outputs.map((o) => ({ name: o.name, type: o.type }));
          return { command: 'SELECT', columns, rows, rowsAffected: rows.length };
        },
      };
    }
    case 'insert': {
      const { table, targets } = bound;
      const source = bound.source;
      const plan = source.kind === 'select' ? planSelect(engine, source.query) : undefined;
      return {
        plan,
        wrapper: `Insert ${table.name}`,
        run: (ctx) => {
          let rows: Row[];
          if (source.kind === 'values') {
            rows = source.rows.map((row) =>
              row.map((e) => compileExpr(e, EMPTY_LAYOUT, ctx.subqueries)([])),
            );
          } else {
            rows = collect(plan!, ctx);
          }
          for (const provided of rows) {
            const values = table.columns.map((c) => c.default);
            targets.forEach((col, i) => (values[col] = provided[i]!));
            engine.store.insert(table, checkRow(table, values));
          }
          return okResult('INSERT', rows.length);
        },
      };
    }
    case 'update': {
      const { table } = bound;
      const plan = planLogical(engine, targetRowsPlan(bound.relation, bound.where));
      return {
        plan,
        wrapper: `Update ${table.name}`,
        run: (ctx) => {
          // Collect first, then write: the scan must not see its own updates.
          const targets = collect(plan, ctx);
          const layout = layoutOf(plan.schema);
          const assignments = bound.assignments.map((a) => ({
            column: a.column,
            eval: compileExpr(a.expr, layout, ctx.subqueries),
          }));
          const width = table.columns.length;
          for (const row of targets) {
            const old = row.slice(0, width);
            const next = old.slice();
            for (const a of assignments) next[a.column] = a.eval(row);
            engine.store.update(table, row[width] as number, old, checkRow(table, next));
          }
          return okResult('UPDATE', targets.length);
        },
      };
    }
    case 'delete': {
      const { table } = bound;
      const plan = planLogical(engine, targetRowsPlan(bound.relation, bound.where));
      return {
        plan,
        wrapper: `Delete ${table.name}`,
        run: (ctx) => {
          const targets = collect(plan, ctx);
          const width = table.columns.length;
          for (const row of targets)
            engine.store.delete(table, row[width] as number, row.slice(0, width));
          return okResult('DELETE', targets.length);
        },
      };
    }
    default:
      return { plan: undefined, wrapper: undefined, run: () => executeUtility(engine, bound) };
  }
}

function executeUtility(engine: Engine, bound: BoundStatement): QueryResult {
  const { catalog, store } = engine;
  switch (bound.kind) {
    case 'create_table': {
      if (bound.exists)
        return okResult('CREATE TABLE', 0, `table "${bound.table.name}" already exists, skipping`);
      catalog.putTable(store.createTable(bound.table));
      return okResult('CREATE TABLE');
    }
    case 'drop_table': {
      if (!bound.table) return okResult('DROP TABLE', 0, 'table does not exist, skipping');
      store.dropTable(bound.table);
      catalog.removeTable(bound.table.name);
      return okResult('DROP TABLE');
    }
    case 'create_index': {
      if (bound.exists)
        return okResult('CREATE INDEX', 0, `index "${bound.index.name}" already exists, skipping`);
      const index = store.createIndex(bound.table, bound.index);
      catalog.putTable({ ...bound.table, indexes: [...bound.table.indexes, index] });
      return okResult('CREATE INDEX');
    }
    case 'drop_index': {
      if (!bound.table || !bound.index)
        return okResult('DROP INDEX', 0, 'index does not exist, skipping');
      const { index } = bound;
      store.dropIndex(bound.table, index);
      catalog.putTable({
        ...bound.table,
        indexes: bound.table.indexes.filter((ix) => ix !== index),
      });
      return okResult('DROP INDEX');
    }
    case 'analyze': {
      for (const table of bound.tables) {
        catalog.putTable({ ...table, stats: computeStats(store, table) });
      }
      return okResult('ANALYZE', bound.tables.length);
    }
    case 'begin':
    case 'commit':
    case 'rollback':
    case 'vacuum':
      throw new GraniteError(
        'feature_not_supported',
        `${bound.kind.toUpperCase()} is not supported yet`,
      );
    default:
      throw new GraniteError('internal_error', `unexpected statement ${bound.kind}`);
  }
}

/** Exact statistics from a full scan: row count, distinct values, NULL fraction, min and max. */
export function computeStats(store: RowStore, table: TableSchema): TableStats {
  const distinct = table.columns.map(() => new Set<string>());
  const nulls = table.columns.map(() => 0);
  const min: Value[] = table.columns.map(() => null);
  const max: Value[] = table.columns.map(() => null);
  let rows = 0;
  for (const { values } of store.scan(table)) {
    rows++;
    values.forEach((v, i) => {
      if (v === null) {
        nulls[i]!++;
        return;
      }
      distinct[i]!.add(hashKey1(v));
      if (min[i] === null || compareValues(v, min[i]!) < 0) min[i] = v;
      if (max[i] === null || compareValues(v, max[i]!) > 0) max[i] = v;
    });
  }
  return {
    rowCount: rows,
    columns: table.columns.map((_, i) => ({
      distinct: distinct[i]!.size,
      nullFraction: rows === 0 ? 0 : nulls[i]! / rows,
      min: min[i]!,
      max: max[i]!,
    })),
  };
}

/** Enforce column constraints on a row about to be written; TEXT is stored as NFC. */
export function checkRow(table: TableSchema, values: Value[]): Value[] {
  table.columns.forEach((c, i) => {
    const v = values[i]!;
    if (v === null) {
      if (c.notNull) {
        throw new GraniteError(
          'not_null_violation',
          `null value in column "${c.name}" of table "${table.name}" violates not-null constraint`,
        );
      }
    } else if (typeof v === 'string') {
      values[i] = v.normalize('NFC');
    }
  });
  return values;
}

function explain(
  engine: Engine,
  stmt: Statement,
  analyze: boolean,
  params: readonly Value[],
  source: string,
): QueryResult {
  if (stmt.kind === 'explain') throw new GraniteError('syntax_error', 'EXPLAIN cannot be nested');
  const bound = bindStatement(stmt, { catalog: engine.catalog, params, source });
  const prepared = prepare(engine, bound);
  if (!prepared.plan && !prepared.wrapper) {
    throw new GraniteError(
      'feature_not_supported',
      `EXPLAIN is not available for ${stmt.kind.replace('_', ' ').toUpperCase()}`,
    );
  }
  let info: PlanNodeInfo | undefined;
  if (analyze) {
    const stats = new Map<PhysicalPlan, { rows: number; timeMs: number }>();
    const ctx = context(engine, bound, stats);
    const started = performance.now();
    const result = prepared.run(ctx);
    const elapsed = performance.now() - started;
    info = prepared.plan ? planToInfo(prepared.plan, (n) => stats.get(n)) : undefined;
    if (prepared.wrapper) info = wrap(prepared.wrapper, info, result.rowsAffected, elapsed);
  } else {
    info = prepared.plan ? planToInfo(prepared.plan) : undefined;
    if (prepared.wrapper) info = wrap(prepared.wrapper, info);
  }
  const lines = planToText(info!);
  return {
    command: 'EXPLAIN',
    columns: [{ name: 'QUERY PLAN', type: 'TEXT' }],
    rows: lines.map((l) => [l]),
    rowsAffected: 0,
    plan: info,
  };
}

function wrap(
  label: string,
  child: PlanNodeInfo | undefined,
  actualRows?: number,
  timeMs?: number,
): PlanNodeInfo {
  const [op, ...rest] = label.split(' ');
  return {
    op: op!,
    detail: rest.join(' '),
    rows: child?.rows ?? 1,
    cost: child?.cost ?? 0,
    actualRows,
    timeMs: timeMs === undefined ? undefined : Math.round(timeMs * 1000) / 1000,
    children: child ? [child] : [],
  };
}
