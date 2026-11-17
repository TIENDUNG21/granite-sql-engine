import { GraniteError, type Span } from '../errors.ts';
import { dataTypeFromName, type DataType } from '../types/datatype.ts';
import type {
  BinaryOp,
  ColumnDef,
  CreateIndexStmt,
  CreateTableStmt,
  DeleteStmt,
  Expr,
  FromItem,
  Ident,
  InsertStmt,
  OrderItem,
  SelectItem,
  SelectStmt,
  Statement,
  TableConstraint,
  UpdateStmt,
} from './ast.ts';
import { RESERVED, identifierOf, tokenize, type Token } from './lexer.ts';

/** Parse a script of `;`-separated statements. */
export function parse(source: string): Statement[] {
  return new Parser(source).parseScript();
}

/** Parse exactly one statement (a trailing `;` is allowed). */
export function parseStatement(source: string): Statement {
  const statements = parse(source);
  if (statements.length !== 1) {
    throw new GraniteError(
      'syntax_error',
      statements.length === 0 ? 'empty statement' : 'expected a single statement',
      { span: { start: 0, end: source.length } },
    ).locate(source);
  }
  return statements[0]!;
}

/** Parse a standalone expression (used by tests and tools). */
export function parseExpression(source: string): Expr {
  const parser = new Parser(source);
  const expr = parser.parseExpr();
  parser.expectEnd();
  return expr;
}

const COMPARISON: ReadonlySet<string> = new Set(['=', '<>', '<', '<=', '>', '>=']);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_DEPTH = 200;

class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  private paramCounter = 0;
  private depth = 0;

  private readonly source: string;

  constructor(source: string) {
    this.source = source;
    this.tokens = tokenize(source);
  }

  // ---------------------------------------------------------------- helpers

  private peek(k = 0): Token {
    return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const tok = this.peek();
    if (tok.kind !== 'eof') this.pos++;
    return tok;
  }

  private prevEnd(): number {
    return this.pos === 0 ? 0 : this.tokens[this.pos - 1]!.end;
  }

  private spanFrom(start: number): Span {
    return { start, end: Math.max(start, this.prevEnd()) };
  }

  private isWord(word: string, k = 0): boolean {
    const tok = this.peek(k);
    return tok.kind === 'word' && tok.value === word;
  }

  private acceptWord(word: string): boolean {
    if (!this.isWord(word)) return false;
    this.pos++;
    return true;
  }

  private expectWord(word: string): Token {
    if (!this.isWord(word)) throw this.unexpected(word);
    return this.next();
  }

  private isSymbol(symbol: string, k = 0): boolean {
    const tok = this.peek(k);
    return tok.kind === 'symbol' && tok.value === symbol;
  }

  private acceptSymbol(symbol: string): boolean {
    if (!this.isSymbol(symbol)) return false;
    this.pos++;
    return true;
  }

  private expectSymbol(symbol: string): Token {
    if (!this.isSymbol(symbol)) throw this.unexpected(`"${symbol}"`);
    return this.next();
  }

  private error(message: string, span: Span, hint?: string): GraniteError {
    return new GraniteError('syntax_error', message, { span, hint }).locate(this.source);
  }

  private unexpected(expected: string, tok: Token = this.peek()): GraniteError {
    const found = tok.kind === 'eof' ? 'end of input' : `"${tok.text}"`;
    return this.error(`expected ${expected}, found ${found}`, { start: tok.start, end: tok.end });
  }

  private isIdentStart(k = 0): boolean {
    const tok = this.peek(k);
    return tok.kind === 'quoted' || (tok.kind === 'word' && !RESERVED.has(tok.value));
  }

  private ident(what = 'an identifier'): Ident {
    const tok = this.peek();
    if (tok.kind === 'word' && RESERVED.has(tok.value)) {
      throw this.error(
        `expected ${what}, found reserved word "${tok.text}"`,
        { start: tok.start, end: tok.end },
        `quote it to use it as a name: "${tok.text.toLowerCase()}"`,
      );
    }
    if (tok.kind !== 'word' && tok.kind !== 'quoted') throw this.unexpected(what);
    this.pos++;
    return { name: identifierOf(tok), span: { start: tok.start, end: tok.end } };
  }

  expectEnd(): void {
    if (this.peek().kind !== 'eof') throw this.unexpected('end of input');
  }

  // ------------------------------------------------------------- statements

  parseScript(): Statement[] {
    const statements: Statement[] = [];
    while (true) {
      while (this.acceptSymbol(';'));
      if (this.peek().kind === 'eof') return statements;
      statements.push(this.parseStatementInner());
      if (!this.acceptSymbol(';') && this.peek().kind !== 'eof') {
        throw this.unexpected('";" or end of input');
      }
    }
  }

  private parseStatementInner(): Statement {
    const tok = this.peek();
    if (tok.kind === 'word') {
      switch (tok.value) {
        case 'SELECT':
          return this.parseSelect();
        case 'INSERT':
          return this.parseInsert();
        case 'UPDATE':
          return this.parseUpdate();
        case 'DELETE':
          return this.parseDelete();
        case 'CREATE':
          return this.parseCreate();
        case 'DROP':
          return this.parseDrop();
        case 'BEGIN':
        case 'COMMIT':
        case 'ROLLBACK': {
          this.next();
          this.acceptWord('TRANSACTION');
          const kind =
            tok.value === 'BEGIN' ? 'begin' : tok.value === 'COMMIT' ? 'commit' : 'rollback';
          return { kind, span: this.spanFrom(tok.start) };
        }
        case 'EXPLAIN': {
          this.next();
          const analyze = this.acceptWord('ANALYZE');
          const statement = this.parseStatementInner();
          if (statement.kind === 'explain') {
            throw this.error('EXPLAIN cannot be nested', statement.span);
          }
          return { kind: 'explain', analyze, statement, span: this.spanFrom(tok.start) };
        }
        case 'ANALYZE':
        case 'VACUUM': {
          this.next();
          const table = this.isIdentStart() ? this.ident('a table name') : undefined;
          const kind = tok.value === 'ANALYZE' ? 'analyze' : 'vacuum';
          return { kind, table, span: this.spanFrom(tok.start) };
        }
      }
    }
    throw this.unexpected('a statement (SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ...)');
  }

  private parseSelect(): SelectStmt {
    const start = this.expectWord('SELECT').start;
    let distinct = false;
    if (this.acceptWord('DISTINCT')) distinct = true;
    else this.acceptWord('ALL');

    const columns: SelectItem[] = [];
    do columns.push(this.parseSelectItem());
    while (this.acceptSymbol(','));

    const from = this.acceptWord('FROM') ? this.parseFrom() : undefined;
    const where = this.acceptWord('WHERE') ? this.parseExpr() : undefined;

    const groupBy: Expr[] = [];
    if (this.acceptWord('GROUP')) {
      this.expectWord('BY');
      do groupBy.push(this.parseExpr());
      while (this.acceptSymbol(','));
    }
    const having = this.acceptWord('HAVING') ? this.parseExpr() : undefined;

    const orderBy: OrderItem[] = [];
    if (this.acceptWord('ORDER')) {
      this.expectWord('BY');
      do orderBy.push(this.parseOrderItem());
      while (this.acceptSymbol(','));
    }

    let limit: Expr | undefined;
    let offset: Expr | undefined;
    if (this.acceptWord('LIMIT')) {
      limit = this.parseExpr();
      if (this.acceptWord('OFFSET')) offset = this.parseExpr();
    } else if (this.acceptWord('OFFSET')) {
      offset = this.parseExpr();
    }

    return {
      kind: 'select',
      distinct,
      columns,
      from,
      where,
      groupBy,
      having,
      orderBy,
      limit,
      offset,
      span: this.spanFrom(start),
    };
  }

  private parseSelectItem(): SelectItem {
    const start = this.peek().start;
    if (this.acceptSymbol('*'))
      return { kind: 'star', table: undefined, span: this.spanFrom(start) };
    if (this.isIdentStart() && this.isSymbol('.', 1) && this.isSymbol('*', 2)) {
      const table = this.ident();
      this.next();
      this.next();
      return { kind: 'star', table, span: this.spanFrom(start) };
    }
    const expr = this.parseExpr();
    let alias: Ident | undefined;
    if (this.acceptWord('AS')) alias = this.ident('an alias');
    else if (this.isIdentStart()) alias = this.ident('an alias');
    return { kind: 'expr', expr, alias, span: this.spanFrom(start) };
  }

  private parseOrderItem(): OrderItem {
    const expr = this.parseExpr();
    let desc = false;
    if (this.acceptWord('DESC')) desc = true;
    else this.acceptWord('ASC');
    let nulls: 'first' | 'last' | undefined;
    if (this.acceptWord('NULLS')) {
      if (this.acceptWord('FIRST')) nulls = 'first';
      else if (this.acceptWord('LAST')) nulls = 'last';
      else throw this.unexpected('FIRST or LAST');
    }
    return { expr, desc, nulls };
  }

  private parseFrom(): FromItem {
    let left = this.parseTableRef();
    while (true) {
      const start = left.span.start;
      if (this.acceptSymbol(',')) {
        const right = this.parseTableRef();
        left = {
          kind: 'join',
          joinType: 'cross',
          left,
          right,
          on: undefined,
          span: this.spanFrom(start),
        };
        continue;
      }
      if (this.acceptWord('CROSS')) {
        this.expectWord('JOIN');
        const right = this.parseTableRef();
        left = {
          kind: 'join',
          joinType: 'cross',
          left,
          right,
          on: undefined,
          span: this.spanFrom(start),
        };
        continue;
      }
      let joinType: 'inner' | 'left' | undefined;
      if (this.isWord('JOIN')) joinType = 'inner';
      else if (this.acceptWord('INNER')) joinType = 'inner';
      else if (this.acceptWord('LEFT')) {
        this.acceptWord('OUTER');
        joinType = 'left';
      }
      if (joinType === undefined) return left;
      this.expectWord('JOIN');
      const right = this.parseTableRef();
      this.expectWord('ON');
      const on = this.parseExpr();
      left = { kind: 'join', joinType, left, right, on, span: this.spanFrom(start) };
    }
  }

  private parseTableRef(): FromItem {
    const start = this.peek().start;
    if (this.isSymbol('(')) {
      throw new GraniteError('feature_not_supported', 'subqueries in FROM are not supported', {
        span: { start, end: start + 1 },
        hint: 'use IN (SELECT ...) or a scalar subquery in WHERE',
      }).locate(this.source);
    }
    const name = this.ident('a table name');
    let alias: Ident | undefined;
    if (this.acceptWord('AS')) alias = this.ident('an alias');
    else if (this.isIdentStart()) alias = this.ident('an alias');
    return { kind: 'table', name, alias, span: this.spanFrom(start) };
  }

  private parseInsert(): InsertStmt {
    const start = this.expectWord('INSERT').start;
    this.expectWord('INTO');
    const table = this.ident('a table name');
    let columns: Ident[] | undefined;
    if (this.isSymbol('(')) columns = this.parseIdentList();
    if (this.isWord('SELECT')) {
      const query = this.parseSelect();
      return {
        kind: 'insert',
        table,
        columns,
        source: { kind: 'select', query },
        span: this.spanFrom(start),
      };
    }
    this.expectWord('VALUES');
    const rows: Expr[][] = [];
    do {
      this.expectSymbol('(');
      const row: Expr[] = [];
      do row.push(this.parseExpr());
      while (this.acceptSymbol(','));
      this.expectSymbol(')');
      rows.push(row);
    } while (this.acceptSymbol(','));
    return {
      kind: 'insert',
      table,
      columns,
      source: { kind: 'values', rows },
      span: this.spanFrom(start),
    };
  }

  private parseUpdate(): UpdateStmt {
    const start = this.expectWord('UPDATE').start;
    const table = this.ident('a table name');
    let alias: Ident | undefined;
    if (this.acceptWord('AS')) alias = this.ident('an alias');
    else if (this.isIdentStart()) alias = this.ident('an alias');
    this.expectWord('SET');
    const assignments: { column: Ident; value: Expr }[] = [];
    do {
      const column = this.ident('a column name');
      this.expectSymbol('=');
      assignments.push({ column, value: this.parseExpr() });
    } while (this.acceptSymbol(','));
    const where = this.acceptWord('WHERE') ? this.parseExpr() : undefined;
    return { kind: 'update', table, alias, assignments, where, span: this.spanFrom(start) };
  }

  private parseDelete(): DeleteStmt {
    const start = this.expectWord('DELETE').start;
    this.expectWord('FROM');
    const table = this.ident('a table name');
    let alias: Ident | undefined;
    if (this.acceptWord('AS')) alias = this.ident('an alias');
    else if (this.isIdentStart()) alias = this.ident('an alias');
    const where = this.acceptWord('WHERE') ? this.parseExpr() : undefined;
    return { kind: 'delete', table, alias, where, span: this.spanFrom(start) };
  }

  private parseCreate(): CreateTableStmt | CreateIndexStmt {
    const start = this.expectWord('CREATE').start;
    if (this.acceptWord('TABLE')) return this.parseCreateTable(start);
    const unique = this.acceptWord('UNIQUE');
    if (this.acceptWord('INDEX')) return this.parseCreateIndex(start, unique);
    throw this.unexpected(unique ? 'INDEX' : 'TABLE or INDEX');
  }

  private parseIfNotExists(): boolean {
    if (!this.acceptWord('IF')) return false;
    this.expectWord('NOT');
    this.expectWord('EXISTS');
    return true;
  }

  private parseCreateTable(start: number): CreateTableStmt {
    const ifNotExists = this.parseIfNotExists();
    const name = this.ident('a table name');
    this.expectSymbol('(');
    const columns: ColumnDef[] = [];
    const constraints: TableConstraint[] = [];
    do {
      const itemStart = this.peek().start;
      if (this.isWord('PRIMARY') || this.isWord('UNIQUE')) {
        let kind: 'primary_key' | 'unique' = 'unique';
        if (this.acceptWord('PRIMARY')) {
          this.expectWord('KEY');
          kind = 'primary_key';
        } else this.next();
        const cols = this.parseIdentList();
        constraints.push({ kind, columns: cols, span: this.spanFrom(itemStart) });
      } else {
        columns.push(this.parseColumnDef());
      }
    } while (this.acceptSymbol(','));
    this.expectSymbol(')');
    if (columns.length === 0) {
      throw this.error('a table needs at least one column', this.spanFrom(start));
    }
    return {
      kind: 'create_table',
      name,
      ifNotExists,
      columns,
      constraints,
      span: this.spanFrom(start),
    };
  }

  private parseColumnDef(): ColumnDef {
    const start = this.peek().start;
    const name = this.ident('a column name');
    const typeStart = this.peek().start;
    const type = this.parseTypeName();
    const typeSpan = this.spanFrom(typeStart);
    const def: ColumnDef = {
      name,
      type,
      typeSpan,
      notNull: false,
      primaryKey: false,
      unique: false,
      default: undefined,
      span: typeSpan,
    };
    while (true) {
      if (this.acceptWord('PRIMARY')) {
        this.expectWord('KEY');
        def.primaryKey = true;
        def.notNull = true;
      } else if (this.acceptWord('NOT')) {
        this.expectWord('NULL');
        def.notNull = true;
      } else if (this.acceptWord('NULL')) {
        // explicit NULL: nullable is already the default
      } else if (this.acceptWord('UNIQUE')) {
        def.unique = true;
      } else if (this.acceptWord('DEFAULT')) {
        def.default = this.parseConcat();
      } else break;
    }
    def.span = this.spanFrom(start);
    return def;
  }

  private parseTypeName(): DataType {
    const tok = this.peek();
    if (tok.kind !== 'word') throw this.unexpected('a type name');
    const type = dataTypeFromName(tok.value);
    if (type === undefined) {
      throw new GraniteError('type_mismatch', `unknown type "${tok.text}"`, {
        span: { start: tok.start, end: tok.end },
        hint: 'supported types: INTEGER, REAL, TEXT, BOOLEAN',
      }).locate(this.source);
    }
    this.next();
    if (tok.value === 'DOUBLE' && this.isWord('PRECISION')) this.next();
    // Length/precision modifiers such as VARCHAR(80) are accepted and not enforced.
    if (this.acceptSymbol('(')) {
      do {
        if (this.peek().kind !== 'number') throw this.unexpected('a number');
        this.next();
      } while (this.acceptSymbol(','));
      this.expectSymbol(')');
    }
    return type;
  }

  private parseCreateIndex(start: number, unique: boolean): CreateIndexStmt {
    const ifNotExists = this.parseIfNotExists();
    const name = this.ident('an index name');
    this.expectWord('ON');
    const table = this.ident('a table name');
    const columns = this.parseIdentList();
    return {
      kind: 'create_index',
      name,
      table,
      columns,
      unique,
      ifNotExists,
      span: this.spanFrom(start),
    };
  }

  private parseDrop(): Statement {
    const start = this.expectWord('DROP').start;
    const isTable = this.acceptWord('TABLE');
    if (!isTable && !this.acceptWord('INDEX')) throw this.unexpected('TABLE or INDEX');
    let ifExists = false;
    if (this.acceptWord('IF')) {
      this.expectWord('EXISTS');
      ifExists = true;
    }
    const name = this.ident(isTable ? 'a table name' : 'an index name');
    return {
      kind: isTable ? 'drop_table' : 'drop_index',
      name,
      ifExists,
      span: this.spanFrom(start),
    };
  }

  private parseIdentList(): Ident[] {
    this.expectSymbol('(');
    const list: Ident[] = [];
    do list.push(this.ident('a column name'));
    while (this.acceptSymbol(','));
    this.expectSymbol(')');
    return list;
  }

  // ------------------------------------------------------------ expressions

  parseExpr(): Expr {
    this.enter();
    try {
      return this.parseOr();
    } finally {
      this.depth--;
    }
  }

  /** Guard against stack exhaustion on hostile input such as 100k nested parentheses. */
  private enter(): void {
    if (++this.depth > MAX_DEPTH) {
      const tok = this.peek();
      throw new GraniteError('program_limit_exceeded', 'expression is nested too deeply', {
        span: { start: tok.start, end: tok.end },
        hint: `the limit is ${MAX_DEPTH} levels`,
      }).locate(this.source);
    }
  }

  private binary(op: BinaryOp, left: Expr, right: Expr): Expr {
    return {
      kind: 'binary',
      op,
      left,
      right,
      span: { start: left.span.start, end: right.span.end },
    };
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.acceptWord('OR')) left = this.binary('OR', left, this.parseAnd());
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.acceptWord('AND')) left = this.binary('AND', left, this.parseNot());
    return left;
  }

  private parseNot(): Expr {
    const start = this.peek().start;
    if (this.acceptWord('NOT')) {
      this.enter();
      const operand = this.parseNot();
      this.depth--;
      return { kind: 'unary', op: 'NOT', operand, span: this.spanFrom(start) };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    let left = this.parseConcat();
    while (true) {
      const tok = this.peek();
      const start = left.span.start;
      if (tok.kind === 'symbol' && COMPARISON.has(tok.value)) {
        this.next();
        left = this.binary(tok.value as BinaryOp, left, this.parseConcat());
        continue;
      }
      if (this.acceptWord('IS')) {
        const negated = this.acceptWord('NOT');
        this.expectWord('NULL');
        left = { kind: 'is_null', operand: left, negated, span: this.spanFrom(start) };
        continue;
      }
      const negated =
        this.isWord('NOT') &&
        (this.isWord('IN', 1) || this.isWord('BETWEEN', 1) || this.isWord('LIKE', 1));
      if (negated) this.next();
      if (this.acceptWord('IN')) {
        left = this.parseInTail(left, negated);
        continue;
      }
      if (this.acceptWord('BETWEEN')) {
        const low = this.parseConcat();
        this.expectWord('AND');
        const high = this.parseConcat();
        left = { kind: 'between', operand: left, low, high, negated, span: this.spanFrom(start) };
        continue;
      }
      if (this.acceptWord('LIKE')) {
        const pattern = this.parseConcat();
        left = { kind: 'like', operand: left, pattern, negated, span: this.spanFrom(start) };
        continue;
      }
      return left;
    }
  }

  private parseInTail(operand: Expr, negated: boolean): Expr {
    const start = operand.span.start;
    this.expectSymbol('(');
    if (this.isWord('SELECT')) {
      const query = this.parseSelect();
      this.expectSymbol(')');
      return { kind: 'in_subquery', operand, query, negated, span: this.spanFrom(start) };
    }
    const list: Expr[] = [];
    do list.push(this.parseExpr());
    while (this.acceptSymbol(','));
    this.expectSymbol(')');
    return { kind: 'in_list', operand, list, negated, span: this.spanFrom(start) };
  }

  private parseConcat(): Expr {
    let left = this.parseAdditive();
    while (this.acceptSymbol('||')) left = this.binary('||', left, this.parseAdditive());
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (true) {
      if (this.acceptSymbol('+')) left = this.binary('+', left, this.parseMultiplicative());
      else if (this.acceptSymbol('-')) left = this.binary('-', left, this.parseMultiplicative());
      else return left;
    }
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (true) {
      if (this.acceptSymbol('*')) left = this.binary('*', left, this.parseUnary());
      else if (this.acceptSymbol('/')) left = this.binary('/', left, this.parseUnary());
      else if (this.acceptSymbol('%')) left = this.binary('%', left, this.parseUnary());
      else return left;
    }
  }

  private parseUnary(): Expr {
    const start = this.peek().start;
    if (this.acceptSymbol('-')) {
      this.enter();
      const operand = this.parseUnary();
      this.depth--;
      return { kind: 'unary', op: '-', operand, span: this.spanFrom(start) };
    }
    if (this.acceptSymbol('+')) {
      this.enter();
      const operand = this.parseUnary();
      this.depth--;
      return { kind: 'unary', op: '+', operand, span: this.spanFrom(start) };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const tok = this.peek();
    const span = { start: tok.start, end: tok.end };
    switch (tok.kind) {
      case 'number':
        this.next();
        return this.numberLiteral(tok);
      case 'string':
        this.next();
        return { kind: 'literal', value: tok.value, type: 'TEXT', span };
      case 'param': {
        this.next();
        const index = tok.value === '?' ? this.paramCounter++ : Number(tok.value.slice(1)) - 1;
        if (index < 0) throw this.error('parameter numbers start at $1', span);
        return { kind: 'param', index, span };
      }
      case 'symbol':
        if (tok.value === '(') return this.parseParenthesized();
        break;
      case 'quoted':
        return this.parseNameOrCall();
      case 'word':
        switch (tok.value) {
          case 'NULL':
            this.next();
            return { kind: 'literal', value: null, type: 'NULL', span };
          case 'TRUE':
          case 'FALSE':
            this.next();
            return { kind: 'literal', value: tok.value === 'TRUE', type: 'BOOLEAN', span };
          case 'CASE':
            return this.parseCase();
          case 'CAST':
            return this.parseCast();
          case 'EXISTS':
            throw new GraniteError('feature_not_supported', 'EXISTS is not supported', {
              span,
              hint: 'rewrite it as IN (SELECT ...)',
            }).locate(this.source);
        }
        if (!RESERVED.has(tok.value)) return this.parseNameOrCall();
        break;
      default:
        break;
    }
    throw this.unexpected('an expression');
  }

  private numberLiteral(tok: Token): Expr {
    const span = { start: tok.start, end: tok.end };
    if (/^\d+$/.test(tok.text)) {
      if (BigInt(tok.text) > MAX_SAFE) {
        throw new GraniteError('numeric_out_of_range', `integer ${tok.text} is out of range`, {
          span,
          hint: `INTEGER values must be within +/-${Number.MAX_SAFE_INTEGER}`,
        }).locate(this.source);
      }
      return { kind: 'literal', value: Number(tok.text), type: 'INTEGER', span };
    }
    const value = Number(tok.text);
    if (!Number.isFinite(value)) {
      throw new GraniteError('numeric_out_of_range', `number ${tok.text} is out of range`, {
        span,
      }).locate(this.source);
    }
    return { kind: 'literal', value, type: 'REAL', span };
  }

  private parseParenthesized(): Expr {
    const start = this.expectSymbol('(').start;
    if (this.isWord('SELECT')) {
      const query = this.parseSelect();
      this.expectSymbol(')');
      return { kind: 'subquery', query, span: this.spanFrom(start) };
    }
    const inner = this.parseExpr();
    this.expectSymbol(')');
    // Keep the inner node but widen its span to include the parentheses.
    return { ...inner, span: this.spanFrom(start) };
  }

  private parseNameOrCall(): Expr {
    const start = this.peek().start;
    const first = this.ident();
    if (this.isSymbol('(')) {
      this.next();
      const name = { name: first.name.toLowerCase(), span: first.span };
      if (this.acceptSymbol('*')) {
        this.expectSymbol(')');
        return {
          kind: 'call',
          name,
          args: [],
          star: true,
          distinct: false,
          span: this.spanFrom(start),
        };
      }
      const distinct = this.acceptWord('DISTINCT');
      const args: Expr[] = [];
      if (!this.isSymbol(')')) {
        do args.push(this.parseExpr());
        while (this.acceptSymbol(','));
      }
      this.expectSymbol(')');
      return { kind: 'call', name, args, star: false, distinct, span: this.spanFrom(start) };
    }
    if (this.acceptSymbol('.')) {
      const column = this.ident('a column name');
      return { kind: 'column', table: first, name: column, span: this.spanFrom(start) };
    }
    return { kind: 'column', table: undefined, name: first, span: this.spanFrom(start) };
  }

  private parseCase(): Expr {
    const start = this.expectWord('CASE').start;
    const operand = this.isWord('WHEN') ? undefined : this.parseExpr();
    const whens: { when: Expr; then: Expr }[] = [];
    while (this.acceptWord('WHEN')) {
      const when = this.parseExpr();
      this.expectWord('THEN');
      whens.push({ when, then: this.parseExpr() });
    }
    if (whens.length === 0) throw this.unexpected('WHEN');
    const elseExpr = this.acceptWord('ELSE') ? this.parseExpr() : undefined;
    this.expectWord('END');
    return { kind: 'case', operand, whens, else: elseExpr, span: this.spanFrom(start) };
  }

  private parseCast(): Expr {
    const start = this.expectWord('CAST').start;
    this.expectSymbol('(');
    const operand = this.parseExpr();
    this.expectWord('AS');
    const type = this.parseTypeName();
    this.expectSymbol(')');
    return { kind: 'cast', operand, type, span: this.spanFrom(start) };
  }
}
