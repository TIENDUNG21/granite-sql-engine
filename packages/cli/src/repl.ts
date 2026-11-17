import {
  describeTable,
  formatError,
  sampleDatasetSql,
  sampleSizes,
  tokenize,
  type Database,
  type QueryResult,
  type Session,
} from '@granite/core';
import { OUTPUT_MODES, renderResult, type OutputMode } from './format.ts';

export const PROMPT = 'granite> ';
export const CONTINUATION = '    ...> ';

export interface ReplIO {
  /** Lines of input, without line terminators. */
  lines: AsyncIterable<string> | Iterable<string>;
  write(text: string): void;
  /** Show a prompt; only called for interactive input. */
  prompt?(text: string): void;
  /** Read a file for `.read`. */
  readFile?(path: string): string;
  /** Monotonic clock in milliseconds, for `.timer`. */
  now?(): number;
}

const HELP = `.explain SQL      Show the plan of a statement (same as EXPLAIN SQL)
.help             Show this help
.indexes [TABLE]  List indexes
.mode [MODE]      Set the output mode: ${OUTPUT_MODES.join(', ')}
.quit             Exit (also .exit or end of input)
.read FILE        Run the SQL in a file
.sample [SCALE]   Create and fill the sample shop database (scale 1 = 1,000 customers)
.schema [TABLE]   Show CREATE statements
.tables           List tables
.timer on|off     Print the time each statement takes

Statements end with a semicolon and may span several lines.
`;

/**
 * True when `sql` ends with a semicolon outside strings, quoted names and
 * comments, so the shell can run it.
 */
export function isComplete(sql: string): boolean {
  const tokens = tokenize(sql, { lenient: true }).filter(
    (t) => t.kind !== 'comment' && t.kind !== 'eof',
  );
  const last = tokens.at(-1);
  return last !== undefined && last.kind === 'symbol' && last.value === ';';
}

/** One shell: the session, its settings and the statement being typed. */
export class Shell {
  readonly db: Database;
  private readonly session: Session;
  private readonly io: ReplIO;
  mode: OutputMode = 'table';
  timer = false;
  errors = 0;
  done = false;
  private buffer = '';

  constructor(db: Database, io: ReplIO) {
    this.db = db;
    this.session = db.session();
    this.io = io;
  }

  get pending(): boolean {
    return this.buffer.trim() !== '';
  }

  /** Feed one input line. */
  line(text: string): void {
    if (!this.pending && text.trimStart().startsWith('.')) {
      this.command(text.trim());
      return;
    }
    this.buffer += (this.buffer ? '\n' : '') + text;
    if (isComplete(this.buffer)) this.flush();
  }

  /** Run whatever is buffered (end of input, even without a semicolon). */
  flush(): void {
    const sql = this.buffer;
    this.buffer = '';
    if (sql.trim() !== '') this.run(sql);
  }

  /** Run SQL, printing each statement's result; returns false on error. */
  run(sql: string): boolean {
    const now = this.io.now ?? (() => performance.now());
    const started = now();
    let results: QueryResult[];
    try {
      results = this.session.execute(sql);
    } catch (err) {
      this.errors++;
      this.io.write(formatError(err, sql) + '\n');
      return false;
    }
    for (const result of results) this.io.write(renderResult(result, this.mode));
    if (this.timer) this.io.write(`Time: ${(now() - started).toFixed(3)} ms\n`);
    return true;
  }

  private command(text: string): void {
    const name = text.split(/\s+/)[0]!;
    const arg = text.slice(name.length).trim();
    switch (name) {
      case '.help':
        this.io.write(HELP);
        return;
      case '.quit':
      case '.exit':
        this.done = true;
        return;
      case '.tables': {
        const names = this.db
          .tables()
          .map((t) => t.name)
          .sort();
        this.io.write(names.length ? names.join('\n') + '\n' : 'No tables.\n');
        return;
      }
      case '.schema': {
        const tables = this.tablesNamed(arg);
        if (tables)
          this.io.write(tables.map(describeTable).join('\n\n') + (tables.length ? '\n' : ''));
        return;
      }
      case '.indexes': {
        const tables = this.tablesNamed(arg);
        if (!tables) return;
        const lines = tables.flatMap((t) =>
          t.indexes.map((ix) => {
            const cols = ix.columns.map((c) => t.columns[c]!.name).join(', ');
            const kind = ix.primary ? 'primary key' : ix.unique ? 'unique' : 'index';
            return `${ix.name} on ${t.name} (${cols}) ${kind}`;
          }),
        );
        this.io.write(lines.length ? lines.join('\n') + '\n' : 'No indexes.\n');
        return;
      }
      case '.explain':
        if (!arg) return this.usage('.explain SQL');
        this.run(`EXPLAIN ${arg}`);
        return;
      case '.mode':
        if (!arg) {
          this.io.write(`${this.mode}\n`);
        } else if ((OUTPUT_MODES as readonly string[]).includes(arg)) {
          this.mode = arg as OutputMode;
        } else {
          this.fail(`unknown mode "${arg}"; expected one of ${OUTPUT_MODES.join(', ')}`);
        }
        return;
      case '.timer':
        if (arg !== 'on' && arg !== 'off') return this.usage('.timer on|off');
        this.timer = arg === 'on';
        return;
      case '.read': {
        if (!arg || !this.io.readFile) return this.usage('.read FILE');
        let sql: string;
        try {
          sql = this.io.readFile(arg);
        } catch (err) {
          this.fail(`cannot read ${arg}: ${(err as Error).message}`);
          return;
        }
        this.run(sql);
        return;
      }
      case '.sample': {
        const scale = arg ? Number(arg) : 1;
        if (!(scale > 0 && scale <= 100))
          return this.usage('.sample [SCALE], with 0 < SCALE <= 100');
        if (this.db.tables().some((t) => t.name === 'customers')) {
          this.fail('the sample tables already exist');
          return;
        }
        const sizes = sampleSizes({ scale });
        const saved = this.mode;
        try {
          for (const sql of sampleDatasetSql({ scale })) if (!this.quiet(sql)) return;
          this.quiet('ANALYZE');
        } finally {
          this.mode = saved;
        }
        this.io.write(
          `Created customers (${sizes.customers}), products (${sizes.products}), orders (${sizes.orders}) and order_items.\n`,
        );
        return;
      }
      default:
        this.fail(`unknown command ${name}; try .help`);
    }
  }

  private quiet(sql: string): boolean {
    try {
      this.session.execute(sql);
      return true;
    } catch (err) {
      this.errors++;
      this.io.write(formatError(err, sql) + '\n');
      return false;
    }
  }

  private tablesNamed(name: string): ReturnType<Database['tables']> | undefined {
    const all = this.db.tables().sort((a, b) => (a.name < b.name ? -1 : 1));
    if (!name) return all;
    const found = all.filter((t) => t.name === name.toLowerCase());
    if (!found.length) this.fail(`table "${name}" does not exist`);
    return found.length ? found : undefined;
  }

  private usage(text: string): void {
    this.fail(`usage: ${text}`);
  }

  private fail(message: string): void {
    this.errors++;
    this.io.write(`error: ${message}\n`);
  }
}

/** Read-eval-print loop over `io.lines`. Resolves with the number of errors. */
export async function runRepl(
  db: Database,
  io: ReplIO,
  settings: { mode?: OutputMode } = {},
): Promise<number> {
  const shell = new Shell(db, io);
  shell.mode = settings.mode ?? shell.mode;
  io.prompt?.(PROMPT);
  for await (const text of io.lines) {
    shell.line(text);
    if (shell.done) break;
    io.prompt?.(shell.pending ? CONTINUATION : PROMPT);
  }
  shell.flush();
  return shell.errors;
}
