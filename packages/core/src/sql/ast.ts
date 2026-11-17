import type { Span } from '../errors.ts';
import type { DataType, ExprType, Value } from '../types/datatype.ts';

/** A name as written in SQL, with where it was written. */
export interface Ident {
  readonly name: string;
  readonly span: Span;
}

export type BinaryOp =
  'OR' | 'AND' | '=' | '<>' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%' | '||';

export type Expr =
  | { kind: 'literal'; value: Value; type: ExprType; span: Span }
  | { kind: 'column'; table: Ident | undefined; name: Ident; span: Span }
  | { kind: 'param'; index: number; span: Span }
  | { kind: 'unary'; op: '-' | '+' | 'NOT'; operand: Expr; span: Span }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr; span: Span }
  | { kind: 'is_null'; operand: Expr; negated: boolean; span: Span }
  | { kind: 'between'; operand: Expr; low: Expr; high: Expr; negated: boolean; span: Span }
  | { kind: 'in_list'; operand: Expr; list: Expr[]; negated: boolean; span: Span }
  | { kind: 'in_subquery'; operand: Expr; query: SelectStmt; negated: boolean; span: Span }
  | { kind: 'like'; operand: Expr; pattern: Expr; negated: boolean; span: Span }
  | {
      kind: 'case';
      operand: Expr | undefined;
      whens: { when: Expr; then: Expr }[];
      else: Expr | undefined;
      span: Span;
    }
  | { kind: 'cast'; operand: Expr; type: DataType; span: Span }
  | {
      kind: 'call';
      name: Ident;
      args: Expr[];
      star: boolean;
      distinct: boolean;
      span: Span;
    }
  | { kind: 'subquery'; query: SelectStmt; span: Span };

export type SelectItem =
  | { kind: 'star'; table: Ident | undefined; span: Span }
  | { kind: 'expr'; expr: Expr; alias: Ident | undefined; span: Span };

export type FromItem =
  | { kind: 'table'; name: Ident; alias: Ident | undefined; span: Span }
  | {
      kind: 'join';
      joinType: 'inner' | 'left' | 'cross';
      left: FromItem;
      right: FromItem;
      on: Expr | undefined;
      span: Span;
    };

export interface OrderItem {
  expr: Expr;
  desc: boolean;
  /** Explicit NULLS FIRST / NULLS LAST; default is NULLs last ascending, first descending. */
  nulls: 'first' | 'last' | undefined;
}

export interface SelectStmt {
  kind: 'select';
  distinct: boolean;
  columns: SelectItem[];
  from: FromItem | undefined;
  where: Expr | undefined;
  groupBy: Expr[];
  having: Expr | undefined;
  orderBy: OrderItem[];
  limit: Expr | undefined;
  offset: Expr | undefined;
  span: Span;
}

export interface ColumnDef {
  name: Ident;
  type: DataType;
  typeSpan: Span;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  default: Expr | undefined;
  span: Span;
}

export interface TableConstraint {
  kind: 'primary_key' | 'unique';
  columns: Ident[];
  span: Span;
}

export interface CreateTableStmt {
  kind: 'create_table';
  name: Ident;
  ifNotExists: boolean;
  columns: ColumnDef[];
  constraints: TableConstraint[];
  span: Span;
}

export interface DropTableStmt {
  kind: 'drop_table';
  name: Ident;
  ifExists: boolean;
  span: Span;
}

export interface CreateIndexStmt {
  kind: 'create_index';
  name: Ident;
  table: Ident;
  columns: Ident[];
  unique: boolean;
  ifNotExists: boolean;
  span: Span;
}

export interface DropIndexStmt {
  kind: 'drop_index';
  name: Ident;
  ifExists: boolean;
  span: Span;
}

export interface InsertStmt {
  kind: 'insert';
  table: Ident;
  columns: Ident[] | undefined;
  source: { kind: 'values'; rows: Expr[][] } | { kind: 'select'; query: SelectStmt };
  span: Span;
}

export interface UpdateStmt {
  kind: 'update';
  table: Ident;
  alias: Ident | undefined;
  assignments: { column: Ident; value: Expr }[];
  where: Expr | undefined;
  span: Span;
}

export interface DeleteStmt {
  kind: 'delete';
  table: Ident;
  alias: Ident | undefined;
  where: Expr | undefined;
  span: Span;
}

export interface TransactionStmt {
  kind: 'begin' | 'commit' | 'rollback';
  span: Span;
}

export interface CheckpointStmt {
  kind: 'checkpoint';
  span: Span;
}

export interface ExplainStmt {
  kind: 'explain';
  analyze: boolean;
  statement: Statement;
  span: Span;
}

export interface AnalyzeStmt {
  kind: 'analyze';
  table: Ident | undefined;
  span: Span;
}

export interface VacuumStmt {
  kind: 'vacuum';
  table: Ident | undefined;
  span: Span;
}

export type Statement =
  | SelectStmt
  | CreateTableStmt
  | DropTableStmt
  | CreateIndexStmt
  | DropIndexStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | TransactionStmt
  | CheckpointStmt
  | ExplainStmt
  | AnalyzeStmt
  | VacuumStmt;
