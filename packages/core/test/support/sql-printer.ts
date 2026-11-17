import type { Expr, SelectStmt } from '../../src/sql/ast.ts';

/**
 * Prints an expression back to SQL with explicit parentheses everywhere, so that
 * parse(print(e)) must give a tree of the same shape. Used by round-trip tests.
 */
export function printExpr(e: Expr): string {
  switch (e.kind) {
    case 'literal':
      if (e.value === null) return 'NULL';
      if (typeof e.value === 'boolean') return e.value ? 'TRUE' : 'FALSE';
      if (typeof e.value === 'string') return `'${e.value.replaceAll("'", "''")}'`;
      if (e.type === 'REAL' && Number.isInteger(e.value)) return `${e.value}.0`;
      return String(e.value);
    case 'column':
      return e.table ? `${quote(e.table.name)}.${quote(e.name.name)}` : quote(e.name.name);
    case 'param':
      return `$${e.index + 1}`;
    case 'unary':
      return e.op === 'NOT' ? `(NOT ${printExpr(e.operand)})` : `(${e.op}${printExpr(e.operand)})`;
    case 'binary':
      return `(${printExpr(e.left)} ${e.op} ${printExpr(e.right)})`;
    case 'is_null':
      return `(${printExpr(e.operand)} IS ${e.negated ? 'NOT ' : ''}NULL)`;
    case 'between':
      return `(${printExpr(e.operand)} ${e.negated ? 'NOT ' : ''}BETWEEN ${printExpr(e.low)} AND ${printExpr(e.high)})`;
    case 'in_list':
      return `(${printExpr(e.operand)} ${e.negated ? 'NOT ' : ''}IN (${e.list.map(printExpr).join(', ')}))`;
    case 'in_subquery':
      return `(${printExpr(e.operand)} ${e.negated ? 'NOT ' : ''}IN (${printSelect(e.query)}))`;
    case 'like':
      return `(${printExpr(e.operand)} ${e.negated ? 'NOT ' : ''}LIKE ${printExpr(e.pattern)})`;
    case 'case': {
      const parts = ['CASE'];
      if (e.operand) parts.push(printExpr(e.operand));
      for (const w of e.whens) parts.push(`WHEN ${printExpr(w.when)} THEN ${printExpr(w.then)}`);
      if (e.else) parts.push(`ELSE ${printExpr(e.else)}`);
      parts.push('END');
      return parts.join(' ');
    }
    case 'cast':
      return `CAST(${printExpr(e.operand)} AS ${e.type})`;
    case 'call':
      if (e.star) return `${e.name.name}(*)`;
      return `${e.name.name}(${e.distinct ? 'DISTINCT ' : ''}${e.args.map(printExpr).join(', ')})`;
    case 'subquery':
      return `(${printSelect(e.query)})`;
  }
}

function printSelect(s: SelectStmt): string {
  const cols = s.columns.map((c) => (c.kind === 'star' ? '*' : printExpr(c.expr))).join(', ');
  const from = s.from && s.from.kind === 'table' ? ` FROM ${quote(s.from.name.name)}` : '';
  const where = s.where ? ` WHERE ${printExpr(s.where)}` : '';
  return `SELECT ${cols}${from}${where}`;
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Remove spans so trees from different source texts can be compared. */
export function stripSpans<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, v: unknown) =>
      key === 'span' || key === 'typeSpan' ? undefined : v,
    ),
  ) as T;
}
