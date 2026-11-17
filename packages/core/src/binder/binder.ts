import type { Catalog } from '../catalog/catalog.ts';
import type { ColumnSchema, IndexSchema, TableSchema } from '../catalog/schema.ts';
import { GraniteError, type Span } from '../errors.ts';
import { evaluateConstant } from '../exec/eval.ts';
import type {
  CreateIndexStmt,
  CreateTableStmt,
  Expr,
  FromItem,
  Ident,
  SelectStmt,
  Statement,
} from '../sql/ast.ts';
import { isNumericType, type DataType, type ExprType, type Value } from '../types/datatype.ts';
import { typeOfValue } from '../types/value.ts';
import {
  exprKey,
  exprToString,
  mapChildren,
  type AggregateCall,
  type AggregateFn,
  type BoundExpr,
  type BoundFrom,
  type BoundSelect,
  type BoundStatement,
  type ColumnId,
  type ColumnInfo,
  type OutputColumn,
  type SortKey,
} from './bound.ts';
import { AGGREGATES, functionNames, lookupFunction, type ArgKind } from './functions.ts';

export interface BindOptions {
  readonly catalog: Catalog;
  readonly params: readonly Value[];
  readonly source: string;
}

type Relation = Extract<BoundFrom, { kind: 'relation' }>;

interface Scope {
  readonly relations: Relation[];
  /** Enclosing query scope, consulted only to explain correlated references. */
  readonly outer: Scope | undefined;
}

interface AggState {
  readonly list: AggregateCall[];
  readonly byKey: Map<string, AggregateCall>;
}

interface ExprContext {
  readonly scope: Scope;
  readonly clause: string;
  /** Present where aggregate calls are allowed (SELECT list, HAVING, ORDER BY). */
  readonly aggregates?: AggState | undefined;
  readonly insideAggregate?: boolean;
}

/** Resolve names against the catalog and type-check a parsed statement. */
export function bindStatement(stmt: Statement, options: BindOptions): BoundStatement {
  return new Binder(options).bind(stmt);
}

class Binder {
  private nextId = 1;
  private readonly subqueries: BoundSelect[] = [];
  private readonly catalog: Catalog;
  private readonly params: readonly Value[];
  private readonly source: string;

  constructor(options: BindOptions) {
    this.catalog = options.catalog;
    this.params = options.params;
    this.source = options.source;
  }

  bind(stmt: Statement): BoundStatement {
    switch (stmt.kind) {
      case 'select':
        return {
          kind: 'select',
          query: this.bindSelect(stmt, undefined),
          subqueries: this.subqueries,
        };
      case 'insert':
        return this.bindInsert(stmt);
      case 'update':
        return this.bindUpdate(stmt);
      case 'delete':
        return this.bindDelete(stmt);
      case 'create_table':
        return this.bindCreateTable(stmt);
      case 'create_index':
        return this.bindCreateIndex(stmt);
      case 'drop_table': {
        const table = this.catalog.getTable(stmt.name.name);
        if (!table && !stmt.ifExists) this.catalog.requireTable(stmt.name);
        return { kind: 'drop_table', table };
      }
      case 'drop_index': {
        const found = this.catalog.findIndex(stmt.name.name);
        if (!found && !stmt.ifExists) {
          throw new GraniteError('undefined_index', `index "${stmt.name.name}" does not exist`, {
            span: stmt.name.span,
          });
        }
        if (found?.index.primary) {
          throw new GraniteError(
            'feature_not_supported',
            `cannot drop index "${stmt.name.name}" because it enforces the primary key of "${found.table.name}"`,
            { span: stmt.name.span },
          );
        }
        return { kind: 'drop_index', table: found?.table, index: found?.index };
      }
      case 'begin':
      case 'commit':
      case 'rollback':
      case 'checkpoint':
        return { kind: stmt.kind };
      case 'analyze':
      case 'vacuum':
        return {
          kind: stmt.kind,
          tables: stmt.table ? [this.catalog.requireTable(stmt.table)] : this.catalog.tables(),
        };
      case 'explain':
        throw new GraniteError('internal_error', 'EXPLAIN is handled by the session');
    }
  }

  private newId(): ColumnId {
    return this.nextId++;
  }

  private text(span: Span): string {
    return this.source.slice(span.start, span.end);
  }

  // ------------------------------------------------------------------ FROM

  private relationFor(
    table: TableSchema,
    alias: Ident | undefined,
    nameSpan: Span,
    scope: Scope,
  ): Relation {
    const name = alias?.name ?? table.name;
    if (scope.relations.some((r) => r.alias === name)) {
      throw new GraniteError('duplicate_table', `table name "${name}" specified more than once`, {
        span: alias?.span ?? nameSpan,
        hint: 'give one of them an alias',
      });
    }
    const relation: Relation = {
      kind: 'relation',
      table,
      alias: name,
      columns: table.columns.map((c) => ({
        id: this.newId(),
        name: c.name,
        table: name,
        type: c.type,
      })),
    };
    scope.relations.push(relation);
    return relation;
  }

  private bindFrom(item: FromItem, scope: Scope): BoundFrom {
    if (item.kind === 'table') {
      const table = this.catalog.requireTable(item.name);
      return this.relationFor(table, item.alias, item.name.span, scope);
    }
    const left = this.bindFrom(item.left, scope);
    const right = this.bindFrom(item.right, scope);
    const on = item.on ? this.bindCondition(item.on, { scope, clause: 'JOIN/ON' }) : undefined;
    return { kind: 'join', joinType: item.joinType, left, right, on };
  }

  // ---------------------------------------------------------------- SELECT

  private bindSelect(s: SelectStmt, outer: Scope | undefined): BoundSelect {
    const scope: Scope = { relations: [], outer };
    const from = s.from ? this.bindFrom(s.from, scope) : undefined;
    const where = s.where ? this.bindCondition(s.where, { scope, clause: 'WHERE' }) : undefined;

    const aggregates: AggState = { list: [], byKey: new Map() };
    const items: { expr: BoundExpr; name: string; explicit: boolean }[] = [];
    for (const item of s.columns) {
      if (item.kind === 'star') {
        const relations = item.table ? [this.relationByAlias(scope, item.table)] : scope.relations;
        if (relations.length === 0) {
          throw new GraniteError('syntax_error', 'SELECT * with no tables specified is not valid', {
            span: item.span,
          });
        }
        for (const rel of relations) {
          for (const col of rel.columns) {
            items.push({ expr: columnRef(col, item.span), name: col.name, explicit: false });
          }
        }
        continue;
      }
      const expr = this.bindExpr(item.expr, { scope, clause: 'SELECT', aggregates });
      const name = item.alias?.name ?? this.defaultName(item.expr);
      items.push({ expr, name, explicit: item.alias !== undefined });
    }

    // GROUP BY accepts input expressions, output positions and output aliases.
    const groupKeys: OutputColumn[] = [];
    const keyByExpr = new Map<string, OutputColumn>();
    for (const g of s.groupBy) {
      let expr: BoundExpr;
      const position = positionOf(g);
      if (position !== undefined) {
        const item = items[position - 1];
        if (!item) {
          throw new GraniteError(
            'undefined_column',
            `GROUP BY position ${position} is not in select list`,
            {
              span: g.span,
            },
          );
        }
        expr = item.expr;
        if (this.containsAggregate(expr, aggregates)) {
          throw new GraniteError(
            'grouping_error',
            'aggregate functions are not allowed in GROUP BY',
            {
              span: g.span,
            },
          );
        }
      } else {
        const alias = this.outputAlias(g, items, scope);
        expr = alias ?? this.bindExpr(g, { scope, clause: 'GROUP BY' });
        if (alias && this.containsAggregate(alias, aggregates)) {
          throw new GraniteError(
            'grouping_error',
            'aggregate functions are not allowed in GROUP BY',
            {
              span: g.span,
            },
          );
        }
      }
      const key = exprKey(expr);
      if (keyByExpr.has(key)) continue;
      const out: OutputColumn = {
        expr,
        id: this.newId(),
        name: expr.kind === 'column' ? expr.name : exprToString(expr),
        type: expr.type,
      };
      groupKeys.push(out);
      keyByExpr.set(key, out);
    }

    const having = s.having
      ? this.bindCondition(s.having, { scope, clause: 'HAVING', aggregates })
      : undefined;

    // ORDER BY: output position, output name, or any expression over the input.
    const order: { target: number | BoundExpr; desc: boolean; nullsFirst: boolean }[] = [];
    for (const o of s.orderBy) {
      const nullsFirst = o.nulls === undefined ? o.desc : o.nulls === 'first';
      const position = positionOf(o.expr);
      if (position !== undefined) {
        if (position < 1 || position > items.length) {
          throw new GraniteError(
            'undefined_column',
            `ORDER BY position ${position} is not in select list`,
            {
              span: o.expr.span,
            },
          );
        }
        order.push({ target: position - 1, desc: o.desc, nullsFirst });
        continue;
      }
      const byName = this.orderByOutputName(o.expr, items);
      if (byName !== undefined) {
        order.push({ target: byName, desc: o.desc, nullsFirst });
        continue;
      }
      const expr = this.bindExpr(o.expr, { scope, clause: 'ORDER BY', aggregates });
      const key = exprKey(expr);
      const match = items.findIndex((it) => exprKey(it.expr) === key);
      if (match >= 0) order.push({ target: match, desc: o.desc, nullsFirst });
      else if (s.distinct) {
        throw new GraniteError(
          'grouping_error',
          'for SELECT DISTINCT, ORDER BY expressions must appear in select list',
          { span: o.expr.span },
        );
      } else order.push({ target: expr, desc: o.desc, nullsFirst });
    }

    const aggregated = s.groupBy.length > 0 || aggregates.list.length > 0;
    const finish = (e: BoundExpr): BoundExpr =>
      aggregated ? this.rewriteGrouped(e, keyByExpr, new Set(aggregates.list.map((a) => a.id))) : e;

    const outputs: OutputColumn[] = items.map((it) => {
      const expr = finish(it.expr);
      return { expr, id: this.newId(), name: it.name, type: expr.type };
    });
    const hidden: OutputColumn[] = [];
    const orderBy: SortKey[] = order.map((o) => {
      let target: OutputColumn;
      if (typeof o.target === 'number') target = outputs[o.target]!;
      else {
        const expr = finish(o.target);
        target = { expr, id: this.newId(), name: exprToString(expr), type: expr.type };
        hidden.push(target);
      }
      return {
        expr: {
          kind: 'column',
          id: target.id,
          name: target.name,
          table: undefined,
          type: target.type,
        },
        desc: o.desc,
        nullsFirst: o.nullsFirst,
      };
    });

    return {
      from,
      where,
      groupKeys,
      aggregates: aggregates.list,
      aggregated,
      having: having && finish(having),
      outputs,
      hidden,
      orderBy,
      distinct: s.distinct,
      limit: s.limit ? this.bindCount(s.limit, 'LIMIT') : undefined,
      offset: s.offset ? this.bindCount(s.offset, 'OFFSET') : 0,
    };
  }

  private defaultName(e: Expr): string {
    if (e.kind === 'column') return e.name.name;
    return this.text(e.span);
  }

  private relationByAlias(scope: Scope, alias: Ident): Relation {
    const rel = scope.relations.find((r) => r.alias === alias.name);
    if (!rel) {
      throw new GraniteError(
        'undefined_table',
        `missing FROM-clause entry for table "${alias.name}"`,
        {
          span: alias.span,
        },
      );
    }
    return rel;
  }

  /** A bare GROUP BY name that is not an input column but is an output alias. */
  private outputAlias(
    g: Expr,
    items: { expr: BoundExpr; name: string; explicit: boolean }[],
    scope: Scope,
  ): BoundExpr | undefined {
    if (g.kind !== 'column' || g.table) return undefined;
    const name = g.name.name;
    if (scope.relations.some((r) => r.columns.some((c) => c.name === name))) return undefined;
    return items.find((it) => it.explicit && it.name === name)?.expr;
  }

  private orderByOutputName(
    e: Expr,
    items: { expr: BoundExpr; name: string }[],
  ): number | undefined {
    if (e.kind !== 'column' || e.table) return undefined;
    const matches = items.map((it, i) => (it.name === e.name.name ? i : -1)).filter((i) => i >= 0);
    if (matches.length === 0) return undefined;
    const first = matches[0]!;
    const key = exprKey(items[first]!.expr);
    if (matches.some((i) => exprKey(items[i]!.expr) !== key)) {
      throw new GraniteError('ambiguous_column', `ORDER BY "${e.name.name}" is ambiguous`, {
        span: e.span,
      });
    }
    return first;
  }

  private containsAggregate(e: BoundExpr, aggregates: AggState): boolean {
    const ids = new Set(aggregates.list.map((a) => a.id));
    const visit = (x: BoundExpr): boolean => {
      if (x.kind === 'column') return ids.has(x.id);
      let found = false;
      mapChildren(x, (c) => {
        found ||= visit(c);
        return c;
      });
      return found;
    };
    return visit(e);
  }

  /** Replace grouped sub-expressions by key references; any other column is an error. */
  private rewriteGrouped(
    e: BoundExpr,
    keys: ReadonlyMap<string, OutputColumn>,
    aggregateIds: ReadonlySet<ColumnId>,
  ): BoundExpr {
    const key = keys.get(exprKey(e));
    if (key)
      return { kind: 'column', id: key.id, name: key.name, table: undefined, type: key.type };
    if (e.kind === 'column') {
      if (aggregateIds.has(e.id)) return e;
      const shown = e.table ? `${e.table}.${e.name}` : e.name;
      throw new GraniteError(
        'grouping_error',
        `column "${shown}" must appear in the GROUP BY clause or be used in an aggregate function`,
        { span: e.span },
      );
    }
    return mapChildren(e, (c) => this.rewriteGrouped(c, keys, aggregateIds));
  }

  private bindCount(e: Expr, clause: 'LIMIT' | 'OFFSET'): number {
    const bound = this.bindExpr(e, { scope: { relations: [], outer: undefined }, clause });
    if (bound.type !== 'INTEGER' && bound.type !== 'NULL') {
      throw new GraniteError(
        'type_mismatch',
        `argument of ${clause} must be INTEGER, not ${bound.type}`,
        {
          span: e.span,
        },
      );
    }
    const value = this.constant(bound, e.span);
    if (value === null) return clause === 'LIMIT' ? Number.MAX_SAFE_INTEGER : 0;
    if ((value as number) < 0) {
      throw new GraniteError('invalid_parameter', `${clause} must not be negative`, {
        span: e.span,
      });
    }
    return value as number;
  }

  private constant(bound: BoundExpr, span: Span): Value {
    try {
      return evaluateConstant(bound);
    } catch (err) {
      if (err instanceof GraniteError && err.code === 'internal_error') {
        throw new GraniteError('syntax_error', 'expected a constant expression', { span });
      }
      if (err instanceof GraniteError && !err.span) {
        throw new GraniteError(err.code, err.message, { span, hint: err.hint });
      }
      throw err;
    }
  }

  // ----------------------------------------------------------- expressions

  private bindCondition(e: Expr, ctx: ExprContext): BoundExpr {
    const bound = this.bindExpr(e, ctx);
    this.requireBoolean(bound, `argument of ${ctx.clause}`, e.span);
    return bound;
  }

  private requireBoolean(bound: BoundExpr, what: string, span: Span): void {
    if (bound.type !== 'BOOLEAN' && bound.type !== 'NULL') {
      throw new GraniteError('type_mismatch', `${what} must be BOOLEAN, not ${describe(bound)}`, {
        span,
      });
    }
  }

  private bindExpr(e: Expr, ctx: ExprContext): BoundExpr {
    switch (e.kind) {
      case 'literal':
        return { kind: 'const', value: e.value, type: e.type };
      case 'param': {
        if (e.index >= this.params.length) {
          throw new GraniteError(
            'invalid_parameter',
            `no value supplied for parameter $${e.index + 1}`,
            {
              span: e.span,
            },
          );
        }
        const value = normalizeParam(this.params[e.index], e.index, e.span);
        return { kind: 'const', value, type: typeOfValue(value) };
      }
      case 'column':
        return this.resolveColumn(e, ctx.scope, ctx.clause);
      case 'unary': {
        const operand = this.bindExpr(e.operand, ctx);
        if (e.op === 'NOT') {
          this.requireBoolean(operand, 'argument of NOT', e.operand.span);
          return { kind: 'not', operand, type: 'BOOLEAN' };
        }
        if (!isNumericType(operand.type) && operand.type !== 'NULL') {
          throw new GraniteError(
            'type_mismatch',
            `operator "${e.op}" cannot be applied to ${describe(operand)}`,
            { span: e.span },
          );
        }
        const type = operand.type === 'NULL' ? 'INTEGER' : operand.type;
        return e.op === '-' ? { kind: 'neg', operand, type } : operand;
      }
      case 'binary':
        return this.bindBinary(e, ctx);
      case 'is_null':
        return {
          kind: 'is_null',
          operand: this.bindExpr(e.operand, ctx),
          negated: e.negated,
          type: 'BOOLEAN',
        };
      case 'between': {
        const operand = this.bindExpr(e.operand, ctx);
        const low = this.bindExpr(e.low, ctx);
        const high = this.bindExpr(e.high, ctx);
        this.checkComparable(operand, low, e.span);
        this.checkComparable(operand, high, e.span);
        const range: BoundExpr = {
          kind: 'and',
          left: { kind: 'compare', op: '>=', left: operand, right: low, type: 'BOOLEAN' },
          right: { kind: 'compare', op: '<=', left: operand, right: high, type: 'BOOLEAN' },
          type: 'BOOLEAN',
        };
        return e.negated ? { kind: 'not', operand: range, type: 'BOOLEAN' } : range;
      }
      case 'in_list': {
        const operand = this.bindExpr(e.operand, ctx);
        const list = e.list.map((x) => {
          const b = this.bindExpr(x, ctx);
          this.checkComparable(operand, b, x.span);
          return b;
        });
        return { kind: 'in_list', operand, list, negated: e.negated, type: 'BOOLEAN' };
      }
      case 'in_subquery': {
        const operand = this.bindExpr(e.operand, ctx);
        const index = this.bindSubquery(e.query, ctx.scope, e.span);
        const column = this.subqueries[index]!.outputs[0]!;
        this.checkComparable(
          operand,
          { kind: 'const', value: null, type: column.type },
          e.span,
          column.type,
        );
        return {
          kind: 'in_subquery',
          operand,
          subquery: index,
          negated: e.negated,
          type: 'BOOLEAN',
        };
      }
      case 'subquery': {
        const index = this.bindSubquery(e.query, ctx.scope, e.span);
        return {
          kind: 'scalar_subquery',
          subquery: index,
          type: this.subqueries[index]!.outputs[0]!.type,
        };
      }
      case 'like': {
        const operand = this.bindExpr(e.operand, ctx);
        const pattern = this.bindExpr(e.pattern, ctx);
        for (const [b, ast] of [
          [operand, e.operand],
          [pattern, e.pattern],
        ] as const) {
          if (b.type !== 'TEXT' && b.type !== 'NULL') {
            throw new GraniteError('type_mismatch', `LIKE needs TEXT, not ${describe(b)}`, {
              span: ast.span,
            });
          }
        }
        return { kind: 'like', operand, pattern, negated: e.negated, type: 'BOOLEAN' };
      }
      case 'case':
        return this.bindCase(e, ctx);
      case 'cast':
        return { kind: 'cast', operand: this.bindExpr(e.operand, ctx), type: e.type };
      case 'call':
        return this.bindCall(e, ctx);
    }
  }

  private resolveColumn(
    e: Extract<Expr, { kind: 'column' }>,
    scope: Scope,
    clause: string,
  ): BoundExpr {
    const name = e.name.name;
    if (e.table) {
      const rel = scope.relations.find((r) => r.alias === e.table!.name);
      if (!rel) {
        if (this.visibleOutside(scope.outer, e.table.name, undefined)) throw correlated(e.span);
        throw new GraniteError(
          'undefined_table',
          `missing FROM-clause entry for table "${e.table.name}"`,
          {
            span: e.table.span,
          },
        );
      }
      const col = rel.columns.find((c) => c.name === name);
      if (!col) {
        const hint = this.catalog.suggest(
          name,
          rel.columns.map((c) => c.name),
        );
        throw new GraniteError('undefined_column', `column ${rel.alias}.${name} does not exist`, {
          span: e.name.span,
          hint: hint ? `did you mean "${hint}"?` : undefined,
        });
      }
      return columnRef(col, e.span);
    }
    const matches: ColumnInfo[] = [];
    for (const rel of scope.relations) {
      for (const col of rel.columns) if (col.name === name) matches.push(col);
    }
    if (matches.length === 1) return columnRef(matches[0]!, e.span);
    if (matches.length > 1) {
      throw new GraniteError('ambiguous_column', `column reference "${name}" is ambiguous`, {
        span: e.span,
        hint: `qualify it: ${matches.map((m) => `${m.table}.${name}`).join(' or ')}`,
      });
    }
    if (this.visibleOutside(scope.outer, undefined, name)) throw correlated(e.span);
    const all = scope.relations.flatMap((r) => r.columns.map((c) => c.name));
    const suggestion = this.catalog.suggest(name, all);
    let hint = suggestion ? `did you mean "${suggestion}"?` : undefined;
    if (!hint && clause === 'VALUES') hint = `string literals use single quotes: '${name}'`;
    throw new GraniteError('undefined_column', `column "${name}" does not exist`, {
      span: e.span,
      hint,
    });
  }

  private visibleOutside(
    scope: Scope | undefined,
    table: string | undefined,
    column: string | undefined,
  ): boolean {
    for (let s = scope; s; s = s.outer) {
      for (const rel of s.relations) {
        if (table !== undefined && rel.alias === table) return true;
        if (column !== undefined && rel.columns.some((c) => c.name === column)) return true;
      }
    }
    return false;
  }

  private bindSubquery(query: SelectStmt, scope: Scope, span: Span): number {
    const bound = this.bindSelect(query, scope);
    if (bound.outputs.length !== 1) {
      throw new GraniteError(
        'syntax_error',
        `subquery must return one column, not ${bound.outputs.length}`,
        {
          span,
        },
      );
    }
    this.subqueries.push(bound);
    return this.subqueries.length - 1;
  }

  private bindBinary(e: Extract<Expr, { kind: 'binary' }>, ctx: ExprContext): BoundExpr {
    const left = this.bindExpr(e.left, ctx);
    const right = this.bindExpr(e.right, ctx);
    switch (e.op) {
      case 'AND':
      case 'OR':
        this.requireBoolean(left, `argument of ${e.op}`, e.left.span);
        this.requireBoolean(right, `argument of ${e.op}`, e.right.span);
        return { kind: e.op === 'AND' ? 'and' : 'or', left, right, type: 'BOOLEAN' };
      case '=':
      case '<>':
      case '<':
      case '<=':
      case '>':
      case '>=':
        this.checkComparable(left, right, e.span);
        return { kind: 'compare', op: e.op, left, right, type: 'BOOLEAN' };
      case '||': {
        const textual = left.type === 'TEXT' || right.type === 'TEXT';
        const nulls = left.type === 'NULL' || right.type === 'NULL';
        if (!textual && !nulls) {
          throw new GraniteError(
            'type_mismatch',
            `operator "||" needs TEXT on one side, got ${describe(left)} and ${describe(right)}`,
            { span: e.span },
          );
        }
        return { kind: 'concat', left, right, type: 'TEXT' };
      }
      default: {
        for (const side of [left, right]) {
          if (!isNumericType(side.type) && side.type !== 'NULL') {
            throw new GraniteError(
              'type_mismatch',
              `operator "${e.op}" cannot be applied to ${describe(left)} and ${describe(right)}`,
              { span: e.span },
            );
          }
        }
        const type: ExprType = left.type === 'REAL' || right.type === 'REAL' ? 'REAL' : 'INTEGER';
        return { kind: 'arith', op: e.op, left, right, type };
      }
    }
  }

  private checkComparable(a: BoundExpr, b: BoundExpr, span: Span, bType: ExprType = b.type): void {
    if (comparable(a.type, bType)) return;
    const right = b.kind === 'const' && b.value === null && bType !== 'NULL' ? bType : describe(b);
    throw new GraniteError('type_mismatch', `cannot compare ${describe(a)} with ${right}`, {
      span,
    });
  }

  private bindCase(e: Extract<Expr, { kind: 'case' }>, ctx: ExprContext): BoundExpr {
    const operand = e.operand ? this.bindExpr(e.operand, ctx) : undefined;
    const whens = e.whens.map((w) => {
      const when = this.bindExpr(w.when, ctx);
      if (operand) this.checkComparable(operand, when, w.when.span);
      else this.requireBoolean(when, 'argument of CASE/WHEN', w.when.span);
      return { when, then: this.bindExpr(w.then, ctx) };
    });
    const otherwise = e.else ? this.bindExpr(e.else, ctx) : undefined;
    const results = [...whens.map((w) => w.then), ...(otherwise ? [otherwise] : [])];
    const type = unify(results.map((r) => r.type));
    if (type === undefined) {
      throw new GraniteError(
        'type_mismatch',
        `CASE branches have incompatible types: ${[...new Set(results.map((r) => r.type))].join(', ')}`,
        { span: e.span },
      );
    }
    return { kind: 'case', operand, whens, else: otherwise, type };
  }

  private bindCall(e: Extract<Expr, { kind: 'call' }>, ctx: ExprContext): BoundExpr {
    const name = e.name.name;
    if (AGGREGATES.has(name)) return this.bindAggregate(e, ctx);
    const fn = lookupFunction(name);
    if (!fn) {
      const hint = this.catalog.suggest(name, functionNames());
      throw new GraniteError('undefined_function', `function ${name}() does not exist`, {
        span: e.name.span,
        hint: hint ? `did you mean ${hint}()?` : undefined,
      });
    }
    if (e.star || e.distinct) {
      throw new GraniteError(
        'syntax_error',
        `${e.star ? '*' : 'DISTINCT'} is only valid in aggregate functions`,
        {
          span: e.span,
        },
      );
    }
    if (e.args.length < fn.minArgs || e.args.length > fn.maxArgs) {
      const expected =
        fn.minArgs === fn.maxArgs
          ? String(fn.minArgs)
          : fn.maxArgs === Infinity
            ? `at least ${fn.minArgs}`
            : `${fn.minArgs} to ${fn.maxArgs}`;
      throw new GraniteError(
        'type_mismatch',
        `function ${name}() takes ${expected} argument${expected === '1' ? '' : 's'}, got ${e.args.length}`,
        { span: e.span },
      );
    }
    const args = e.args.map((a, i) => {
      const bound = this.bindExpr(a, ctx);
      const kind = fn.params[Math.min(i, fn.params.length - 1)]!;
      if (!accepts(kind, bound.type)) {
        throw new GraniteError(
          'type_mismatch',
          `function ${name}() expects ${KIND_NAMES[kind]} for argument ${i + 1}, not ${describe(bound)}`,
          { span: a.span },
        );
      }
      return bound;
    });
    let type = fn.result(args.map((a) => a.type));
    if (name === 'coalesce' || name === 'nullif') {
      const unified = unify(args.map((a) => a.type));
      if (unified === undefined) {
        throw new GraniteError(
          'type_mismatch',
          `arguments of ${name}() have incompatible types: ${args.map((a) => a.type).join(', ')}`,
          { span: e.span },
        );
      }
      type = name === 'nullif' ? (args[0]!.type === 'NULL' ? unified : args[0]!.type) : unified;
    }
    return { kind: 'call', fn: lookupFunction(name)!.name, args, type };
  }

  private bindAggregate(e: Extract<Expr, { kind: 'call' }>, ctx: ExprContext): BoundExpr {
    const fn = e.name.name as AggregateFn;
    if (!ctx.aggregates) {
      throw new GraniteError(
        'grouping_error',
        `aggregate functions are not allowed in ${ctx.clause}`,
        {
          span: e.span,
        },
      );
    }
    if (ctx.insideAggregate) {
      throw new GraniteError('grouping_error', 'aggregate function calls cannot be nested', {
        span: e.span,
      });
    }
    if (e.star && fn !== 'count') {
      throw new GraniteError('syntax_error', `only count() accepts *`, { span: e.span });
    }
    if (!e.star && e.args.length !== 1) {
      throw new GraniteError(
        'type_mismatch',
        `function ${fn}() takes 1 argument, got ${e.args.length}`,
        {
          span: e.span,
        },
      );
    }
    const arg = e.star ? undefined : this.bindExpr(e.args[0]!, { ...ctx, insideAggregate: true });
    let type: ExprType;
    switch (fn) {
      case 'count':
        type = 'INTEGER';
        break;
      case 'sum':
      case 'avg':
        if (!isNumericType(arg!.type) && arg!.type !== 'NULL') {
          throw new GraniteError(
            'type_mismatch',
            `function ${fn}() needs a number, not ${describe(arg!)}`,
            {
              span: e.args[0]!.span,
            },
          );
        }
        type = fn === 'avg' || arg!.type === 'REAL' ? 'REAL' : 'INTEGER';
        break;
      case 'min':
      case 'max':
        type = arg!.type;
        break;
    }
    const key = `${fn}|${e.distinct}|${arg ? exprKey(arg) : '*'}`;
    let call = ctx.aggregates.byKey.get(key);
    if (!call) {
      call = { fn, arg, distinct: e.distinct, id: this.newId(), name: this.text(e.span), type };
      ctx.aggregates.byKey.set(key, call);
      ctx.aggregates.list.push(call);
    }
    return {
      kind: 'column',
      id: call.id,
      name: call.name,
      table: undefined,
      type: call.type,
      span: e.span,
    };
  }

  // ------------------------------------------------------------------- DML

  private bindInsert(stmt: Extract<Statement, { kind: 'insert' }>): BoundStatement {
    const table = this.catalog.requireTable(stmt.table);
    let targets: number[];
    if (stmt.columns) {
      targets = [];
      for (const ident of stmt.columns) {
        const index = this.columnOf(table, ident);
        if (targets.includes(index)) {
          throw new GraniteError(
            'duplicate_column',
            `column "${ident.name}" specified more than once`,
            {
              span: ident.span,
            },
          );
        }
        targets.push(index);
      }
    } else {
      targets = table.columns.map((_, i) => i);
    }

    const empty: Scope = { relations: [], outer: undefined };
    if (stmt.source.kind === 'values') {
      const rows = stmt.source.rows.map((row, r) => {
        if (row.length !== targets.length) {
          const more = row.length > targets.length;
          const at = more ? row[targets.length]!.span : (row.at(-1)?.span ?? stmt.span);
          throw new GraniteError(
            'syntax_error',
            `INSERT has ${more ? 'more' : 'fewer'} expressions than target columns (row ${r + 1}: ${row.length} vs ${targets.length})`,
            { span: at },
          );
        }
        return row.map((e, i) => {
          const bound = this.bindExpr(e, { scope: empty, clause: 'VALUES' });
          this.checkAssignable(table.columns[targets[i]!]!, bound.type, e.span);
          return bound;
        });
      });
      return {
        kind: 'insert',
        table,
        targets,
        source: { kind: 'values', rows },
        subqueries: this.subqueries,
      };
    }

    const query = this.bindSelect(stmt.source.query, undefined);
    if (query.outputs.length !== targets.length) {
      throw new GraniteError(
        'syntax_error',
        `INSERT has ${targets.length} target columns but the query returns ${query.outputs.length}`,
        { span: stmt.source.query.span },
      );
    }
    query.outputs.forEach((out, i) => {
      this.checkAssignable(
        table.columns[targets[i]!]!,
        out.type,
        stmt.source.kind === 'select' ? stmt.source.query.span : stmt.span,
      );
    });
    return {
      kind: 'insert',
      table,
      targets,
      source: { kind: 'select', query },
      subqueries: this.subqueries,
    };
  }

  private columnOf(table: TableSchema, ident: Ident): number {
    const index = table.columns.findIndex((c) => c.name === ident.name);
    if (index < 0) {
      const hint = this.catalog.suggest(
        ident.name,
        table.columns.map((c) => c.name),
      );
      throw new GraniteError(
        'undefined_column',
        `column "${ident.name}" of table "${table.name}" does not exist`,
        {
          span: ident.span,
          hint: hint ? `did you mean "${hint}"?` : undefined,
        },
      );
    }
    return index;
  }

  private checkAssignable(column: ColumnSchema, type: ExprType, span: Span): void {
    if (assignable(column.type, type)) return;
    throw new GraniteError(
      'type_mismatch',
      `column "${column.name}" is ${column.type}, but the value is ${type}`,
      {
        span,
        hint: `use CAST(... AS ${column.type}) to convert it`,
      },
    );
  }

  private bindUpdate(stmt: Extract<Statement, { kind: 'update' }>): BoundStatement {
    const table = this.catalog.requireTable(stmt.table);
    const scope: Scope = { relations: [], outer: undefined };
    const relation = this.relationFor(table, stmt.alias, stmt.table.span, scope);
    const seen = new Set<number>();
    const assignments = stmt.assignments.map((a) => {
      const column = this.columnOf(table, a.column);
      if (seen.has(column)) {
        throw new GraniteError(
          'duplicate_column',
          `column "${a.column.name}" assigned more than once`,
          {
            span: a.column.span,
          },
        );
      }
      seen.add(column);
      const expr = this.bindExpr(a.value, { scope, clause: 'UPDATE/SET' });
      this.checkAssignable(table.columns[column]!, expr.type, a.value.span);
      return { column, expr };
    });
    const where = stmt.where
      ? this.bindCondition(stmt.where, { scope, clause: 'WHERE' })
      : undefined;
    return { kind: 'update', table, relation, assignments, where, subqueries: this.subqueries };
  }

  private bindDelete(stmt: Extract<Statement, { kind: 'delete' }>): BoundStatement {
    const table = this.catalog.requireTable(stmt.table);
    const scope: Scope = { relations: [], outer: undefined };
    const relation = this.relationFor(table, stmt.alias, stmt.table.span, scope);
    const where = stmt.where
      ? this.bindCondition(stmt.where, { scope, clause: 'WHERE' })
      : undefined;
    return { kind: 'delete', table, relation, where, subqueries: this.subqueries };
  }

  // ------------------------------------------------------------------- DDL

  private bindCreateTable(stmt: CreateTableStmt): BoundStatement {
    const name = stmt.name.name;
    const existing = this.catalog.getTable(name);
    if (existing) {
      if (stmt.ifNotExists)
        return { kind: 'create_table', table: existing, ifNotExists: true, exists: true };
      throw new GraniteError('duplicate_table', `table "${name}" already exists`, {
        span: stmt.name.span,
      });
    }
    const names = new Set<string>();
    const empty: Scope = { relations: [], outer: undefined };
    const columns: ColumnSchema[] = stmt.columns.map((c) => {
      if (names.has(c.name.name)) {
        throw new GraniteError(
          'duplicate_column',
          `column "${c.name.name}" specified more than once`,
          {
            span: c.name.span,
          },
        );
      }
      names.add(c.name.name);
      let def: Value = null;
      if (c.default) {
        const bound = this.bindExpr(c.default, { scope: empty, clause: 'DEFAULT' });
        const column = { name: c.name.name, type: c.type, notNull: c.notNull, default: null };
        this.checkAssignable(column, bound.type, c.default.span);
        def = this.constant(bound, c.default.span);
        if (typeof def === 'string') def = def.normalize('NFC');
      }
      return { name: c.name.name, type: c.type, notNull: c.notNull, default: def };
    });

    const indexes: IndexSchema[] = [];
    const indexFor = (cols: Ident[], primary: boolean, span: Span): void => {
      const positions = cols.map((ident) => {
        const i = columns.findIndex((c) => c.name === ident.name);
        if (i < 0) {
          throw new GraniteError(
            'undefined_column',
            `column "${ident.name}" named in key does not exist`,
            {
              span: ident.span,
            },
          );
        }
        return i;
      });
      if (primary) {
        if (indexes.some((ix) => ix.primary)) {
          throw new GraniteError(
            'syntax_error',
            `multiple primary keys for table "${name}" are not allowed`,
            {
              span,
            },
          );
        }
        for (const p of positions) {
          const c = columns[p]!;
          columns[p] = { ...c, notNull: true };
        }
      }
      if (indexes.some((ix) => sameColumns(ix.columns, positions))) return;
      const suffix = primary ? 'pkey' : `${positions.map((p) => columns[p]!.name).join('_')}_key`;
      indexes.push({
        name: `${name}_${suffix}`,
        table: name,
        columns: positions,
        unique: true,
        primary,
        rootPage: 0,
      });
    };

    // The primary key goes first so that it is the first index the planner sees.
    for (const c of stmt.columns) if (c.primaryKey) indexFor([c.name], true, c.span);
    for (const k of stmt.constraints)
      if (k.kind === 'primary_key') indexFor(k.columns, true, k.span);
    for (const c of stmt.columns) if (c.unique) indexFor([c.name], false, c.span);
    for (const k of stmt.constraints) if (k.kind === 'unique') indexFor(k.columns, false, k.span);

    const table: TableSchema = { name, columns, rootPage: 0, indexes, stats: undefined };
    return { kind: 'create_table', table, ifNotExists: stmt.ifNotExists, exists: false };
  }

  private bindCreateIndex(stmt: CreateIndexStmt): BoundStatement {
    const table = this.catalog.requireTable(stmt.table);
    const existing = this.catalog.findIndex(stmt.name.name);
    if (existing) {
      if (stmt.ifNotExists)
        return { kind: 'create_index', table, index: existing.index, exists: true };
      throw new GraniteError('duplicate_index', `index "${stmt.name.name}" already exists`, {
        span: stmt.name.span,
      });
    }
    if (this.catalog.getTable(stmt.name.name)) {
      throw new GraniteError(
        'duplicate_table',
        `a table named "${stmt.name.name}" already exists`,
        {
          span: stmt.name.span,
        },
      );
    }
    const columns: number[] = [];
    for (const ident of stmt.columns) {
      const i = this.columnOf(table, ident);
      if (columns.includes(i)) {
        throw new GraniteError(
          'duplicate_column',
          `column "${ident.name}" appears twice in the index`,
          {
            span: ident.span,
          },
        );
      }
      columns.push(i);
    }
    const index: IndexSchema = {
      name: stmt.name.name,
      table: table.name,
      columns,
      unique: stmt.unique,
      primary: false,
      rootPage: 0,
    };
    return { kind: 'create_index', table, index, exists: false };
  }
}

// ------------------------------------------------------------------ helpers

function columnRef(col: ColumnInfo, span: Span | undefined): BoundExpr {
  return { kind: 'column', id: col.id, name: col.name, table: col.table, type: col.type, span };
}

function positionOf(e: Expr): number | undefined {
  return e.kind === 'literal' && e.type === 'INTEGER' ? (e.value as number) : undefined;
}

function correlated(span: Span): GraniteError {
  return new GraniteError('feature_not_supported', 'correlated subqueries are not supported', {
    span,
    hint: 'rewrite the query with a JOIN',
  });
}

function describe(e: BoundExpr): string {
  if (e.kind === 'column' && e.table !== undefined) return `column "${e.name}" (${e.type})`;
  return e.type;
}

export function comparable(a: ExprType, b: ExprType): boolean {
  if (a === 'NULL' || b === 'NULL') return true;
  if (isNumericType(a) && isNumericType(b)) return true;
  return a === b;
}

/** Common type of CASE branches / COALESCE arguments, or undefined if none. */
export function unify(types: readonly ExprType[]): ExprType | undefined {
  let out: ExprType = 'NULL';
  for (const t of types) {
    if (t === 'NULL' || t === out) continue;
    if (out === 'NULL') out = t;
    else if (isNumericType(out) && isNumericType(t)) out = 'REAL';
    else return undefined;
  }
  return out;
}

export function assignable(column: DataType, value: ExprType): boolean {
  return value === 'NULL' || value === column || (column === 'REAL' && value === 'INTEGER');
}

const KIND_NAMES: Record<ArgKind, string> = {
  number: 'a number',
  integer: 'INTEGER',
  text: 'TEXT',
  any: 'any value',
};

function accepts(kind: ArgKind, type: ExprType): boolean {
  if (type === 'NULL' || kind === 'any') return true;
  if (kind === 'number') return isNumericType(type);
  if (kind === 'integer') return type === 'INTEGER';
  return type === 'TEXT';
}

function sameColumns(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function normalizeParam(value: unknown, index: number, span: Span): Value {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new GraniteError(
        'numeric_out_of_range',
        `parameter $${index + 1} is out of the INTEGER range`,
        {
          span,
        },
      );
    }
    return value === 0 ? 0 : value;
  }
  throw new GraniteError(
    'invalid_parameter',
    `parameter $${index + 1} must be a string, finite number, boolean or null`,
    { span },
  );
}
