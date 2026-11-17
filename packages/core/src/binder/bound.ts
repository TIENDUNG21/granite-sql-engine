import type { IndexSchema, TableSchema } from '../catalog/schema.ts';
import type { Span } from '../errors.ts';
import type { DataType, ExprType, Value } from '../types/datatype.ts';
import { formatValue } from '../types/value.ts';

/** Identifies a column flowing through a plan; unique within one statement. */
export type ColumnId = number;

export interface ColumnInfo {
  readonly id: ColumnId;
  /** Column name as shown to users. */
  readonly name: string;
  /** Table alias the column comes from, if any. */
  readonly table: string | undefined;
  readonly type: ExprType;
}

export type CompareOp = '=' | '<>' | '<' | '<=' | '>' | '>=';
export type ArithOp = '+' | '-' | '*' | '/' | '%';

/** A name-resolved, type-checked expression. */
export type BoundExpr =
  | { kind: 'const'; value: Value; type: ExprType }
  | {
      kind: 'column';
      id: ColumnId;
      name: string;
      table: string | undefined;
      type: ExprType;
      /** Where the reference was written, for error messages. */
      span?: Span | undefined;
    }
  | { kind: 'neg'; operand: BoundExpr; type: ExprType }
  | { kind: 'not'; operand: BoundExpr; type: 'BOOLEAN' }
  | { kind: 'arith'; op: ArithOp; left: BoundExpr; right: BoundExpr; type: ExprType }
  | { kind: 'concat'; left: BoundExpr; right: BoundExpr; type: 'TEXT' }
  | { kind: 'compare'; op: CompareOp; left: BoundExpr; right: BoundExpr; type: 'BOOLEAN' }
  | { kind: 'and' | 'or'; left: BoundExpr; right: BoundExpr; type: 'BOOLEAN' }
  | { kind: 'is_null'; operand: BoundExpr; negated: boolean; type: 'BOOLEAN' }
  | { kind: 'in_list'; operand: BoundExpr; list: BoundExpr[]; negated: boolean; type: 'BOOLEAN' }
  | { kind: 'in_subquery'; operand: BoundExpr; subquery: number; negated: boolean; type: 'BOOLEAN' }
  | { kind: 'scalar_subquery'; subquery: number; type: ExprType }
  | { kind: 'like'; operand: BoundExpr; pattern: BoundExpr; negated: boolean; type: 'BOOLEAN' }
  | {
      kind: 'case';
      operand: BoundExpr | undefined;
      whens: { when: BoundExpr; then: BoundExpr }[];
      else: BoundExpr | undefined;
      type: ExprType;
    }
  | { kind: 'cast'; operand: BoundExpr; type: DataType }
  | { kind: 'call'; fn: string; args: BoundExpr[]; type: ExprType };

export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface AggregateCall {
  readonly fn: AggregateFn;
  /** Undefined for COUNT(*). */
  readonly arg: BoundExpr | undefined;
  readonly distinct: boolean;
  readonly id: ColumnId;
  readonly name: string;
  readonly type: ExprType;
}

export type BoundFrom =
  | {
      kind: 'relation';
      table: TableSchema;
      alias: string;
      columns: ColumnInfo[];
    }
  | {
      kind: 'join';
      joinType: 'inner' | 'left' | 'cross';
      left: BoundFrom;
      right: BoundFrom;
      on: BoundExpr | undefined;
    };

export interface OutputColumn {
  readonly expr: BoundExpr;
  readonly id: ColumnId;
  readonly name: string;
  readonly type: ExprType;
}

export interface SortKey {
  readonly expr: BoundExpr;
  readonly desc: boolean;
  readonly nullsFirst: boolean;
}

export interface BoundSelect {
  readonly from: BoundFrom | undefined;
  readonly where: BoundExpr | undefined;
  readonly groupKeys: OutputColumn[];
  readonly aggregates: AggregateCall[];
  /** True when the query aggregates (GROUP BY or any aggregate call). */
  readonly aggregated: boolean;
  readonly having: BoundExpr | undefined;
  /** Visible result columns. */
  readonly outputs: OutputColumn[];
  /** Extra ORDER BY expressions computed next to the outputs and dropped at the end. */
  readonly hidden: OutputColumn[];
  readonly orderBy: SortKey[];
  readonly distinct: boolean;
  readonly limit: number | undefined;
  readonly offset: number;
}

export type BoundStatement =
  | { kind: 'select'; query: BoundSelect; subqueries: BoundSelect[] }
  | {
      kind: 'insert';
      table: TableSchema;
      /** Table column position for each provided value. */
      targets: number[];
      source: { kind: 'values'; rows: BoundExpr[][] } | { kind: 'select'; query: BoundSelect };
      subqueries: BoundSelect[];
    }
  | {
      kind: 'update';
      table: TableSchema;
      relation: Extract<BoundFrom, { kind: 'relation' }>;
      assignments: { column: number; expr: BoundExpr }[];
      where: BoundExpr | undefined;
      subqueries: BoundSelect[];
    }
  | {
      kind: 'delete';
      table: TableSchema;
      relation: Extract<BoundFrom, { kind: 'relation' }>;
      where: BoundExpr | undefined;
      subqueries: BoundSelect[];
    }
  | { kind: 'create_table'; table: TableSchema; ifNotExists: boolean; exists: boolean }
  | { kind: 'drop_table'; table: TableSchema | undefined }
  | {
      kind: 'create_index';
      table: TableSchema;
      index: IndexSchema;
      exists: boolean;
    }
  | { kind: 'drop_index'; table: TableSchema | undefined; index: IndexSchema | undefined }
  | { kind: 'begin' | 'commit' | 'rollback' }
  | { kind: 'analyze'; tables: TableSchema[] }
  | { kind: 'vacuum'; tables: TableSchema[] };

/** Visit every direct child expression. */
export function childrenOf(e: BoundExpr): BoundExpr[] {
  switch (e.kind) {
    case 'const':
    case 'column':
    case 'scalar_subquery':
      return [];
    case 'neg':
    case 'not':
    case 'is_null':
    case 'cast':
      return [e.operand];
    case 'in_subquery':
      return [e.operand];
    case 'arith':
    case 'concat':
    case 'compare':
    case 'and':
    case 'or':
      return [e.left, e.right];
    case 'in_list':
      return [e.operand, ...e.list];
    case 'like':
      return [e.operand, e.pattern];
    case 'case': {
      const out: BoundExpr[] = [];
      if (e.operand) out.push(e.operand);
      for (const w of e.whens) out.push(w.when, w.then);
      if (e.else) out.push(e.else);
      return out;
    }
    case 'call':
      return e.args;
  }
}

/** All column ids an expression reads. */
export function columnsOf(e: BoundExpr, into: Set<ColumnId> = new Set()): Set<ColumnId> {
  if (e.kind === 'column') into.add(e.id);
  for (const c of childrenOf(e)) columnsOf(c, into);
  return into;
}

/** Structural identity of an expression (names ignored, ids compared). */
export function exprKey(e: BoundExpr): string {
  return JSON.stringify(e, (key, v: unknown) =>
    key === 'name' || key === 'table' || key === 'span' ? undefined : v,
  );
}

/** Rebuild an expression with each direct child replaced by `f(child)`. */
export function mapChildren(e: BoundExpr, f: (child: BoundExpr) => BoundExpr): BoundExpr {
  switch (e.kind) {
    case 'const':
    case 'column':
    case 'scalar_subquery':
      return e;
    case 'neg':
      return { ...e, operand: f(e.operand) };
    case 'not':
      return { ...e, operand: f(e.operand) };
    case 'is_null':
      return { ...e, operand: f(e.operand) };
    case 'cast':
      return { ...e, operand: f(e.operand) };
    case 'in_subquery':
      return { ...e, operand: f(e.operand) };
    case 'arith':
      return { ...e, left: f(e.left), right: f(e.right) };
    case 'concat':
      return { ...e, left: f(e.left), right: f(e.right) };
    case 'compare':
      return { ...e, left: f(e.left), right: f(e.right) };
    case 'and':
    case 'or':
      return { ...e, left: f(e.left), right: f(e.right) };
    case 'in_list':
      return { ...e, operand: f(e.operand), list: e.list.map(f) };
    case 'like':
      return { ...e, operand: f(e.operand), pattern: f(e.pattern) };
    case 'case':
      return {
        ...e,
        operand: e.operand && f(e.operand),
        whens: e.whens.map((w) => ({ when: f(w.when), then: f(w.then) })),
        else: e.else && f(e.else),
      };
    case 'call':
      return { ...e, args: e.args.map(f) };
  }
}

/** Split `a AND b AND c` into its conjuncts. */
export function conjuncts(e: BoundExpr | undefined): BoundExpr[] {
  if (!e) return [];
  if (e.kind === 'and') return [...conjuncts(e.left), ...conjuncts(e.right)];
  return [e];
}

export function andAll(list: BoundExpr[]): BoundExpr | undefined {
  if (list.length === 0) return undefined;
  return list.reduce((acc, e) => ({ kind: 'and', left: acc, right: e, type: 'BOOLEAN' }));
}

/** Readable SQL-ish rendering used by EXPLAIN. */
export function exprToString(e: BoundExpr): string {
  switch (e.kind) {
    case 'const':
      return typeof e.value === 'string'
        ? `'${e.value.replaceAll("'", "''")}'`
        : formatValue(e.value, e.type);
    case 'column':
      return e.table ? `${e.table}.${e.name}` : e.name;
    case 'neg':
      return `-${wrap(e.operand)}`;
    case 'not':
      return `NOT ${wrap(e.operand)}`;
    case 'arith':
    case 'compare':
      return `${wrap(e.left)} ${e.op} ${wrap(e.right)}`;
    case 'concat':
      return `${wrap(e.left)} || ${wrap(e.right)}`;
    case 'and':
    case 'or':
      return `${wrap(e.left)} ${e.kind.toUpperCase()} ${wrap(e.right)}`;
    case 'is_null':
      return `${wrap(e.operand)} IS ${e.negated ? 'NOT ' : ''}NULL`;
    case 'in_list':
      return `${wrap(e.operand)} ${e.negated ? 'NOT ' : ''}IN (${e.list.map(exprToString).join(', ')})`;
    case 'in_subquery':
      return `${wrap(e.operand)} ${e.negated ? 'NOT ' : ''}IN (subquery ${e.subquery + 1})`;
    case 'scalar_subquery':
      return `(subquery ${e.subquery + 1})`;
    case 'like':
      return `${wrap(e.operand)} ${e.negated ? 'NOT ' : ''}LIKE ${wrap(e.pattern)}`;
    case 'case': {
      const parts = ['CASE'];
      if (e.operand) parts.push(exprToString(e.operand));
      for (const w of e.whens)
        parts.push(`WHEN ${exprToString(w.when)} THEN ${exprToString(w.then)}`);
      if (e.else) parts.push(`ELSE ${exprToString(e.else)}`);
      parts.push('END');
      return parts.join(' ');
    }
    case 'cast':
      return `CAST(${exprToString(e.operand)} AS ${e.type})`;
    case 'call':
      return `${e.fn}(${e.args.map(exprToString).join(', ')})`;
  }
}

function wrap(e: BoundExpr): string {
  const simple =
    e.kind === 'const' || e.kind === 'column' || e.kind === 'call' || e.kind === 'cast';
  return simple ? exprToString(e) : `(${exprToString(e)})`;
}
