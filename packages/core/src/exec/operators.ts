import type { AggregateCall, BoundExpr, SortKey } from '../binder/bound.ts';
import { GraniteError } from '../errors.ts';
import type { IndexSchema, TableSchema } from '../catalog/schema.ts';
import type { IndexBounds, PhysicalPlan } from '../plan/physical.ts';
import type { Value } from '../types/datatype.ts';
import { compareValues, hashKey, hashKey1 } from '../types/value.ts';
import {
  EMPTY_LAYOUT,
  checkNumber,
  compileExpr,
  layoutOf,
  type Compiled,
  type Layout,
  type Row,
  type SubqueryResults,
} from './eval.ts';
import type { IndexRange, RowSource, StoredRow } from './row-source.ts';

/**
 * The volcano (iterator) model: each operator pulls rows from its children one
 * at a time through `next()`. `undefined` means the stream is exhausted.
 */
export interface Operator {
  open(): void;
  next(): Row | undefined;
  close(): void;
}

export interface ExecContext {
  readonly source: RowSource;
  readonly subqueries: SubqueryResults;
  /** When set (EXPLAIN ANALYZE), every operator records rows produced and time spent. */
  readonly stats?: Map<PhysicalPlan, { rows: number; timeMs: number }> | undefined;
}

export function buildOperator(plan: PhysicalPlan, ctx: ExecContext): Operator {
  const op = build(plan, ctx);
  return ctx.stats ? new Instrumented(op, plan, ctx.stats) : op;
}

function build(plan: PhysicalPlan, ctx: ExecContext): Operator {
  switch (plan.op) {
    case 'SeqScan':
      return new ScanOp(
        () => ctx.source.scan(plan.relation.table),
        plan.withRowId,
        filterOf(plan.filter, plan, ctx),
      );
    case 'IndexScan': {
      const { table } = plan.relation;
      const { index, bounds } = plan;
      return new ScanOp(
        () => indexRows(ctx.source, table, index, evaluateBounds(bounds, ctx.subqueries)),
        plan.withRowId,
        filterOf(plan.filter, plan, ctx),
      );
    }
    case 'Values':
      return new ValuesOp();
    case 'Empty':
      return new EmptyOp();
    case 'Filter': {
      const input = plan.input;
      return new FilterOp(
        buildOperator(input, ctx),
        compileExpr(plan.predicate, layoutOf(input.schema), ctx.subqueries),
      );
    }
    case 'Project': {
      const layout = layoutOf(plan.input.schema);
      const exprs = plan.outputs.map((o) => compileExpr(o.expr, layout, ctx.subqueries));
      return new ProjectOp(buildOperator(plan.input, ctx), exprs);
    }
    case 'NestedLoopJoin': {
      const condition = plan.condition
        ? compileExpr(plan.condition, layoutOf(plan.schema), ctx.subqueries)
        : undefined;
      return new NestedLoopJoinOp(
        buildOperator(plan.left, ctx),
        buildOperator(plan.right, ctx),
        condition,
        plan.joinType === 'left',
        plan.right.schema.length,
      );
    }
    case 'HashJoin': {
      const leftLayout = layoutOf(plan.left.schema);
      const rightLayout = layoutOf(plan.right.schema);
      return new HashJoinOp(
        buildOperator(plan.left, ctx),
        buildOperator(plan.right, ctx),
        plan.leftKeys.map((k) => compileExpr(k, leftLayout, ctx.subqueries)),
        plan.rightKeys.map((k) => compileExpr(k, rightLayout, ctx.subqueries)),
        plan.residual
          ? compileExpr(plan.residual, layoutOf(plan.schema), ctx.subqueries)
          : undefined,
        plan.joinType === 'left',
        plan.right.schema.length,
      );
    }
    case 'HashAggregate': {
      const layout = layoutOf(plan.input.schema);
      return new HashAggregateOp(
        buildOperator(plan.input, ctx),
        plan.groupKeys.map((k) => compileExpr(k.expr, layout, ctx.subqueries)),
        plan.aggregates.map((a) => compileAggregate(a, layout, ctx.subqueries)),
      );
    }
    case 'Sort':
      return new SortOp(
        buildOperator(plan.input, ctx),
        plan.keys,
        layoutOf(plan.input.schema),
        ctx.subqueries,
      );
    case 'Limit':
      return new LimitOp(buildOperator(plan.input, ctx), plan.limit, plan.offset);
    case 'Distinct':
      return new DistinctOp(buildOperator(plan.input, ctx));
  }
}

function filterOf(
  filter: BoundExpr | undefined,
  plan: PhysicalPlan,
  ctx: ExecContext,
): Compiled | undefined {
  return filter ? compileExpr(filter, layoutOf(plan.schema), ctx.subqueries) : undefined;
}

/** Run a plan to completion and return its rows. */
export function collect(plan: PhysicalPlan, ctx: ExecContext): Row[] {
  const op = buildOperator(plan, ctx);
  const rows: Row[] = [];
  op.open();
  try {
    for (let row = op.next(); row !== undefined; row = op.next()) rows.push(row);
  } finally {
    op.close();
  }
  return rows;
}

// ------------------------------------------------------------------ scans

/**
 * Turn planned bounds into concrete key ranges: one range per combination of
 * IN-list alternatives. NULL bounds match nothing, as `col = NULL` is never true.
 */
export function evaluateBounds(bounds: IndexBounds, sub: SubqueryResults): IndexRange[] {
  const ev = (e: BoundExpr): Value => compileExpr(e, EMPTY_LAYOUT, sub)([]);
  let prefixes: Value[][] = [[]];
  for (const alternatives of bounds.prefix) {
    const values = dedupe(alternatives.map(ev).filter((v) => v !== null));
    prefixes = prefixes.flatMap((p) => values.map((v) => [...p, v]));
  }
  const lower = bounds.lower && {
    value: ev(bounds.lower.value),
    inclusive: bounds.lower.inclusive,
  };
  const upper = bounds.upper && {
    value: ev(bounds.upper.value),
    inclusive: bounds.upper.inclusive,
  };
  if (lower?.value === null || upper?.value === null) return [];
  return prefixes
    .sort((a, b) => {
      for (let i = 0; i < a.length; i++) {
        const c = compareValues(a[i]!, b[i]!);
        if (c !== 0) return c;
      }
      return 0;
    })
    .map((prefix) => ({ prefix, lower, upper }));
}

function dedupe(values: Value[]): Value[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = hashKey1(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function* indexRows(
  source: RowSource,
  table: TableSchema,
  index: IndexSchema,
  ranges: IndexRange[],
): Generator<StoredRow> {
  for (const range of ranges) yield* source.indexScan(table, index, range);
}

class ScanOp implements Operator {
  private iter: Iterator<{ rowid: number; values: Value[] }> | undefined;
  private readonly open_: () => Iterable<{ rowid: number; values: Value[] }>;
  private readonly withRowId: boolean;
  private readonly filter: Compiled | undefined;

  constructor(
    open: () => Iterable<{ rowid: number; values: Value[] }>,
    withRowId: boolean,
    filter: Compiled | undefined,
  ) {
    this.open_ = open;
    this.withRowId = withRowId;
    this.filter = filter;
  }

  open(): void {
    this.iter = this.open_()[Symbol.iterator]();
  }

  next(): Row | undefined {
    while (true) {
      const r = this.iter!.next();
      if (r.done) return undefined;
      const row = this.withRowId ? [...r.value.values, r.value.rowid] : r.value.values;
      if (!this.filter || this.filter(row) === true) return row;
    }
  }

  close(): void {
    this.iter?.return?.();
    this.iter = undefined;
  }
}

class EmptyOp implements Operator {
  open(): void {}
  next(): Row | undefined {
    return undefined;
  }
  close(): void {}
}

class ValuesOp implements Operator {
  private done = false;
  open(): void {
    this.done = false;
  }
  next(): Row | undefined {
    if (this.done) return undefined;
    this.done = true;
    return [];
  }
  close(): void {}
}

// ------------------------------------------------------- row-at-a-time ops

class FilterOp implements Operator {
  private readonly input: Operator;
  private readonly predicate: Compiled;

  constructor(input: Operator, predicate: Compiled) {
    this.input = input;
    this.predicate = predicate;
  }
  open(): void {
    this.input.open();
  }
  next(): Row | undefined {
    for (let row = this.input.next(); row !== undefined; row = this.input.next()) {
      if (this.predicate(row) === true) return row;
    }
    return undefined;
  }
  close(): void {
    this.input.close();
  }
}

class ProjectOp implements Operator {
  private readonly input: Operator;
  private readonly exprs: Compiled[];

  constructor(input: Operator, exprs: Compiled[]) {
    this.input = input;
    this.exprs = exprs;
  }
  open(): void {
    this.input.open();
  }
  next(): Row | undefined {
    const row = this.input.next();
    if (row === undefined) return undefined;
    const out = new Array<Value>(this.exprs.length);
    for (let i = 0; i < this.exprs.length; i++) out[i] = this.exprs[i]!(row);
    return out;
  }
  close(): void {
    this.input.close();
  }
}

class LimitOp implements Operator {
  private readonly input: Operator;
  private readonly limit: number | undefined;
  private readonly offset: number;
  private seen = 0;
  private emitted = 0;

  constructor(input: Operator, limit: number | undefined, offset: number) {
    this.input = input;
    this.limit = limit;
    this.offset = offset;
  }
  open(): void {
    this.seen = 0;
    this.emitted = 0;
    this.input.open();
  }
  next(): Row | undefined {
    if (this.limit !== undefined && this.emitted >= this.limit) return undefined;
    while (this.seen < this.offset) {
      if (this.input.next() === undefined) return undefined;
      this.seen++;
    }
    const row = this.input.next();
    if (row !== undefined) this.emitted++;
    return row;
  }
  close(): void {
    this.input.close();
  }
}

class DistinctOp implements Operator {
  private readonly input: Operator;
  private seen = new Set<string>();

  constructor(input: Operator) {
    this.input = input;
  }
  open(): void {
    this.seen = new Set();
    this.input.open();
  }
  next(): Row | undefined {
    for (let row = this.input.next(); row !== undefined; row = this.input.next()) {
      const key = hashKey(row);
      if (!this.seen.has(key)) {
        this.seen.add(key);
        return row;
      }
    }
    return undefined;
  }
  close(): void {
    this.input.close();
    this.seen = new Set();
  }
}

// ------------------------------------------------------------------ joins

class NestedLoopJoinOp implements Operator {
  private inner: Row[] = [];
  private outerRow: Row | undefined;
  private innerPos = 0;
  private matched = false;
  private readonly outer: Operator;
  private readonly innerOp: Operator;
  private readonly condition: Compiled | undefined;
  private readonly leftJoin: boolean;
  private readonly innerWidth: number;

  constructor(
    outer: Operator,
    inner: Operator,
    condition: Compiled | undefined,
    leftJoin: boolean,
    innerWidth: number,
  ) {
    this.outer = outer;
    this.innerOp = inner;
    this.condition = condition;
    this.leftJoin = leftJoin;
    this.innerWidth = innerWidth;
  }

  open(): void {
    // The inner side is read once and kept in memory (block nested loop).
    this.inner = [];
    this.innerOp.open();
    for (let r = this.innerOp.next(); r !== undefined; r = this.innerOp.next()) this.inner.push(r);
    this.innerOp.close();
    this.outer.open();
    this.outerRow = undefined;
  }

  next(): Row | undefined {
    while (true) {
      if (this.outerRow === undefined) {
        this.outerRow = this.outer.next();
        if (this.outerRow === undefined) return undefined;
        this.innerPos = 0;
        this.matched = false;
      }
      while (this.innerPos < this.inner.length) {
        const combined = this.outerRow.concat(this.inner[this.innerPos++]!);
        if (!this.condition || this.condition(combined) === true) {
          this.matched = true;
          return combined;
        }
      }
      const outerRow = this.outerRow;
      this.outerRow = undefined;
      if (this.leftJoin && !this.matched) return outerRow.concat(nulls(this.innerWidth));
    }
  }

  close(): void {
    this.outer.close();
    this.inner = [];
  }
}

class HashJoinOp implements Operator {
  private table = new Map<string, Row[]>();
  private probeRow: Row | undefined;
  private bucket: Row[] = [];
  private bucketPos = 0;
  private matched = false;
  private readonly probe: Operator;
  private readonly build: Operator;
  private readonly probeKeys: Compiled[];
  private readonly buildKeys: Compiled[];
  private readonly residual: Compiled | undefined;
  private readonly leftJoin: boolean;
  private readonly buildWidth: number;

  constructor(
    probe: Operator,
    build: Operator,
    probeKeys: Compiled[],
    buildKeys: Compiled[],
    residual: Compiled | undefined,
    leftJoin: boolean,
    buildWidth: number,
  ) {
    this.probe = probe;
    this.build = build;
    this.probeKeys = probeKeys;
    this.buildKeys = buildKeys;
    this.residual = residual;
    this.leftJoin = leftJoin;
    this.buildWidth = buildWidth;
  }

  private key(row: Row, keys: Compiled[]): string | undefined {
    let key = '';
    for (const k of keys) {
      const v = k(row);
      if (v === null) return undefined; // NULL never equals anything
      key += `${hashKey1(v)}|`;
    }
    return key;
  }

  open(): void {
    this.table = new Map();
    this.build.open();
    for (let r = this.build.next(); r !== undefined; r = this.build.next()) {
      const key = this.key(r, this.buildKeys);
      if (key === undefined) continue;
      const list = this.table.get(key);
      if (list) list.push(r);
      else this.table.set(key, [r]);
    }
    this.build.close();
    this.probe.open();
    this.probeRow = undefined;
  }

  next(): Row | undefined {
    while (true) {
      if (this.probeRow === undefined) {
        this.probeRow = this.probe.next();
        if (this.probeRow === undefined) return undefined;
        const key = this.key(this.probeRow, this.probeKeys);
        this.bucket = key === undefined ? [] : (this.table.get(key) ?? []);
        this.bucketPos = 0;
        this.matched = false;
      }
      while (this.bucketPos < this.bucket.length) {
        const combined = this.probeRow.concat(this.bucket[this.bucketPos++]!);
        if (!this.residual || this.residual(combined) === true) {
          this.matched = true;
          return combined;
        }
      }
      const row = this.probeRow;
      this.probeRow = undefined;
      if (this.leftJoin && !this.matched) return row.concat(nulls(this.buildWidth));
    }
  }

  close(): void {
    this.probe.close();
    this.table = new Map();
  }
}

function nulls(n: number): Value[] {
  return new Array<Value>(n).fill(null);
}

// ------------------------------------------------------------ aggregation

interface Accumulator {
  add(v: Value): void;
  result(): Value;
}

interface CompiledAggregate {
  arg: Compiled | undefined;
  distinct: boolean;
  create(): Accumulator;
}

function compileAggregate(
  a: AggregateCall,
  layout: Layout,
  sub: SubqueryResults,
): CompiledAggregate {
  const arg = a.arg ? compileExpr(a.arg, layout, sub) : undefined;
  const integer = a.type === 'INTEGER';
  let create: () => Accumulator;
  switch (a.fn) {
    case 'count':
      create = () => {
        let n = 0;
        return { add: () => void n++, result: () => n };
      };
      break;
    case 'sum':
      create = () => {
        let sum: number | null = null;
        return {
          add: (v) => {
            sum = (sum ?? 0) + (v as number);
            checkNumber(sum, integer);
          },
          result: () => sum,
        };
      };
      break;
    case 'avg':
      create = () => {
        let sum = 0;
        let n = 0;
        return {
          add: (v) => {
            sum += v as number;
            n++;
          },
          result: () => (n === 0 ? null : sum / n),
        };
      };
      break;
    case 'min':
    case 'max': {
      const sign = a.fn === 'min' ? -1 : 1;
      create = () => {
        let best: Value = null;
        return {
          add: (v) => {
            if (best === null || compareValues(v, best) * sign > 0) best = v;
          },
          result: () => best,
        };
      };
      break;
    }
  }
  return { arg, distinct: a.distinct, create };
}

class HashAggregateOp implements Operator {
  private output: Row[] = [];
  private pos = 0;
  private readonly input: Operator;
  private readonly keys: Compiled[];
  private readonly aggs: CompiledAggregate[];

  constructor(input: Operator, keys: Compiled[], aggs: CompiledAggregate[]) {
    this.input = input;
    this.keys = keys;
    this.aggs = aggs;
  }

  open(): void {
    interface Group {
      keyValues: Value[];
      accs: Accumulator[];
      seen: (Set<string> | undefined)[];
    }
    const groups = new Map<string, Group>();
    const newGroup = (keyValues: Value[]): Group => ({
      keyValues,
      accs: this.aggs.map((a) => a.create()),
      seen: this.aggs.map((a) => (a.distinct ? new Set<string>() : undefined)),
    });
    // Without GROUP BY there is exactly one group, even over zero rows.
    if (this.keys.length === 0) groups.set('', newGroup([]));

    this.input.open();
    for (let row = this.input.next(); row !== undefined; row = this.input.next()) {
      const keyValues = this.keys.map((k) => k(row));
      const key = hashKey(keyValues);
      let group = groups.get(key);
      if (!group) {
        group = newGroup(keyValues);
        groups.set(key, group);
      }
      for (let i = 0; i < this.aggs.length; i++) {
        const agg = this.aggs[i]!;
        if (!agg.arg) {
          group.accs[i]!.add(null); // COUNT(*)
          continue;
        }
        const v = agg.arg(row);
        if (v === null) continue;
        const seen = group.seen[i];
        if (seen) {
          const k = hashKey1(v);
          if (seen.has(k)) continue;
          seen.add(k);
        }
        group.accs[i]!.add(v);
      }
    }
    this.input.close();
    this.output = [...groups.values()].map((g) => [
      ...g.keyValues,
      ...g.accs.map((a) => a.result()),
    ]);
    this.pos = 0;
  }

  next(): Row | undefined {
    return this.output[this.pos++];
  }

  close(): void {
    this.output = [];
  }
}

// ------------------------------------------------------------------- sort

class SortOp implements Operator {
  private rows: Row[] = [];
  private pos = 0;
  private readonly input: Operator;
  private readonly keys: SortKey[];
  private readonly compiled: Compiled[];

  constructor(input: Operator, keys: SortKey[], layout: Layout, sub: SubqueryResults) {
    this.input = input;
    this.keys = keys;
    this.compiled = keys.map((k) => compileExpr(k.expr, layout, sub));
  }

  open(): void {
    const decorated: { key: Value[]; row: Row }[] = [];
    this.input.open();
    for (let row = this.input.next(); row !== undefined; row = this.input.next()) {
      decorated.push({ key: this.compiled.map((c) => c(row)), row });
    }
    this.input.close();
    const keys = this.keys;
    decorated.sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const x = a.key[i]!;
        const y = b.key[i]!;
        if (x === y) continue;
        const k = keys[i]!;
        if (x === null || y === null) {
          const c = x === null ? -1 : 1;
          return k.nullsFirst ? c : -c;
        }
        const c = compareValues(x, y);
        if (c !== 0) return k.desc ? -c : c;
      }
      return 0;
    });
    this.rows = decorated.map((d) => d.row);
    this.pos = 0;
  }

  next(): Row | undefined {
    return this.rows[this.pos++];
  }

  close(): void {
    this.rows = [];
  }
}

// ---------------------------------------------------------- instrumentation

class Instrumented implements Operator {
  private readonly inner: Operator;
  private readonly entry: { rows: number; timeMs: number };

  constructor(
    inner: Operator,
    plan: PhysicalPlan,
    stats: Map<PhysicalPlan, { rows: number; timeMs: number }>,
  ) {
    this.inner = inner;
    let entry = stats.get(plan);
    if (!entry) {
      entry = { rows: 0, timeMs: 0 };
      stats.set(plan, entry);
    }
    this.entry = entry;
  }

  open(): void {
    const t = performance.now();
    this.inner.open();
    this.entry.timeMs += performance.now() - t;
  }

  next(): Row | undefined {
    const t = performance.now();
    const row = this.inner.next();
    this.entry.timeMs += performance.now() - t;
    if (row !== undefined) this.entry.rows++;
    return row;
  }

  close(): void {
    this.inner.close();
  }
}

/** Raised when a scalar subquery yields more than one row. */
export function tooManyRows(): GraniteError {
  return new GraniteError(
    'cardinality_violation',
    'more than one row returned by a subquery used as an expression',
  );
}
