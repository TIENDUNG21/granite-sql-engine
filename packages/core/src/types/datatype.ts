/** Column types supported by the engine. */
export type DataType = 'INTEGER' | 'REAL' | 'TEXT' | 'BOOLEAN';

/** The static type of an expression: a column type, or NULL for an untyped null literal. */
export type ExprType = DataType | 'NULL';

/**
 * A runtime value. INTEGER and REAL are both JS numbers; the static type of the
 * expression (known after binding) says which one a number is.
 */
export type Value = null | boolean | number | string;

export const DATA_TYPES: readonly DataType[] = ['INTEGER', 'REAL', 'TEXT', 'BOOLEAN'];

/** Map a type name written in SQL (including common synonyms) to a DataType. */
export function dataTypeFromName(name: string): DataType | undefined {
  switch (name.toUpperCase()) {
    case 'INTEGER':
    case 'INT':
    case 'BIGINT':
    case 'SMALLINT':
      return 'INTEGER';
    case 'REAL':
    case 'FLOAT':
    case 'DOUBLE':
    case 'NUMERIC':
      return 'REAL';
    case 'TEXT':
    case 'VARCHAR':
    case 'CHAR':
      return 'TEXT';
    case 'BOOLEAN':
    case 'BOOL':
      return 'BOOLEAN';
    default:
      return undefined;
  }
}

export function isNumericType(t: ExprType): boolean {
  return t === 'INTEGER' || t === 'REAL';
}
