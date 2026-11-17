import type { PlanNodeInfo } from '../plan/physical.ts';
import type { ExprType, Value } from '../types/datatype.ts';

export interface ResultColumn {
  readonly name: string;
  readonly type: ExprType;
}

/** The outcome of one SQL statement. */
export interface QueryResult {
  /** Statement tag, e.g. SELECT, INSERT, CREATE TABLE, EXPLAIN. */
  readonly command: string;
  readonly columns: ResultColumn[];
  readonly rows: Value[][];
  /** Rows inserted, updated or deleted (or returned, for SELECT). */
  readonly rowsAffected: number;
  /** The plan tree, for EXPLAIN. */
  readonly plan?: PlanNodeInfo | undefined;
  /** Notice for statements that did nothing, e.g. "table t already exists, skipping". */
  readonly notice?: string | undefined;
}

export function okResult(command: string, rowsAffected = 0, notice?: string): QueryResult {
  return { command, columns: [], rows: [], rowsAffected, notice };
}
