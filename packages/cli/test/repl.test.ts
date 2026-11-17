import { Readable } from 'node:stream';
import { Database, MemoryFileSystem, type QueryResult } from '@granite/core';
import { describe, expect, it } from 'vitest';
import { displayWidth, renderResult } from '../src/format.ts';
import { main, parseArgs } from '../src/main.ts';
import { CONTINUATION, PROMPT, isComplete, runRepl } from '../src/repl.ts';

async function session(
  lines: string[],
  files: Record<string, string> = {},
): Promise<{ out: string; prompts: string[]; errors: number }> {
  let out = '';
  const prompts: string[] = [];
  const errors = await runRepl(Database.open(), {
    lines,
    write: (t) => (out += t),
    prompt: (p) => prompts.push(p),
    readFile: (path) => {
      if (!(path in files)) throw new Error('no such file');
      return files[path]!;
    },
    now: (() => {
      let t = 0;
      return () => (t += 1.5);
    })(),
  });
  return { out, prompts, errors };
}

describe('statement completion', () => {
  it('waits for a semicolon outside strings and comments', () => {
    expect(isComplete('SELECT 1;')).toBe(true);
    expect(isComplete('SELECT 1')).toBe(false);
    expect(isComplete("SELECT 'a;")).toBe(false);
    expect(isComplete("SELECT 'a;';")).toBe(true);
    expect(isComplete('SELECT 1; -- done')).toBe(true);
    expect(isComplete('SELECT 1 /* ; */')).toBe(false);
    expect(isComplete('SELECT "x;"')).toBe(false);
  });
});

describe('repl', () => {
  it('runs multi-line statements and shows continuation prompts', async () => {
    const { out, prompts, errors } = await session([
      'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);',
      "INSERT INTO t VALUES (1, 'An'),",
      "  (2, 'Bình');",
      'SELECT * FROM t',
      'ORDER BY id DESC;',
    ]);
    expect(errors).toBe(0);
    expect(prompts).toEqual([PROMPT, PROMPT, CONTINUATION, PROMPT, CONTINUATION, PROMPT]);
    expect(out).toBe(
      [
        'CREATE TABLE',
        'INSERT 2',
        ' id | name',
        '----+------',
        '  2 | Bình',
        '  1 | An',
        '(2 rows)',
        '',
      ].join('\n'),
    );
  });

  it('runs a final statement without a semicolon at end of input', async () => {
    const { out } = await session(['SELECT 40 + 2 AS answer']);
    expect(out).toContain(' answer\n--------\n     42\n(1 row)');
  });

  it('prints errors with a caret and keeps going', async () => {
    const { out, errors } = await session(['SELECT nope FROM missing;', 'SELECT 1 AS one;']);
    expect(errors).toBe(1);
    expect(out).toContain('error[undefined_table]: table "missing" does not exist');
    expect(out).toContain('                 ^');
    expect(out).toContain(' one\n-----\n   1');
  });

  it('supports the dot commands', async () => {
    const { out, errors } = await session(
      [
        '.tables',
        'CREATE TABLE b (x INTEGER); CREATE TABLE a (id INTEGER PRIMARY KEY, label TEXT NOT NULL);',
        'CREATE UNIQUE INDEX a_label ON a (label);',
        '.tables',
        '.schema a',
        '.indexes',
        ".explain SELECT * FROM a WHERE label = 'x'",
        '.mode csv',
        'INSERT INTO a VALUES (1, \'say "hi", ok\');',
        'SELECT * FROM a;',
        '.mode json',
        'SELECT * FROM a;',
        '.mode',
        '.timer on',
        'SELECT 1;',
        '.read init.sql',
        'SELECT count(*) FROM b;',
        '.quit',
        'SELECT 1;',
      ],
      { 'init.sql': 'INSERT INTO b VALUES (1), (2);' },
    );
    expect(errors).toBe(0);
    expect(out).toContain('No tables.\n');
    expect(out).toContain('a\nb\n');
    expect(out).toContain(
      'CREATE TABLE a (\n  id INTEGER PRIMARY KEY,\n  label TEXT NOT NULL\n);\nCREATE UNIQUE INDEX a_label ON a (label);',
    );
    expect(out).toContain('a_pkey on a (id) primary key\na_label on a (label) unique\n');
    expect(out).toContain(
      "Project a.id, a.label  (rows=0 cost=0)\n└─ SeqScan a filter: a.label = 'x'",
    );
    expect(out).toContain('id,label\n1,"say ""hi"", ok"\n');
    expect(out).toContain('[\n  {\n    "id": 1,\n    "label": "say \\"hi\\", ok"\n  }\n]');
    expect(out).toContain('json\n');
    expect(out).toContain('Time: 1.500 ms');
    expect(out).toContain('INSERT 2');
    // .quit stops before the last statement.
    expect(out.match(/Time: 1\.500 ms/g)).toHaveLength(3);
  });

  it('reports bad dot commands', async () => {
    const { out, errors } = await session([
      '.nope',
      '.mode xml',
      '.timer maybe',
      '.schema ghost',
      '.read missing.sql',
      '.sample 0',
    ]);
    expect(errors).toBe(6);
    expect(out).toBe(
      [
        'error: unknown command .nope; try .help',
        'error: unknown mode "xml"; expected one of table, csv, json, line',
        'error: usage: .timer on|off',
        'error: table "ghost" does not exist',
        'error: cannot read missing.sql: no such file',
        'error: usage: .sample [SCALE], with 0 < SCALE <= 100',
        '',
      ].join('\n'),
    );
  });

  it('loads the sample database', async () => {
    const { out, errors } = await session([
      '.sample 0.1',
      'SELECT count(*) FROM orders;',
      '.sample',
    ]);
    expect(out).toContain('Created customers (100), products (120), orders (500) and order_items.');
    expect(out).toContain('   500\n(1 row)');
    expect(out).toContain('error: the sample tables already exist');
    expect(errors).toBe(1);
  });
});

describe('formatting', () => {
  const result = (rows: QueryResult['rows']): QueryResult => ({
    command: 'SELECT',
    columns: [
      { name: 'name', type: 'TEXT' },
      { name: 'n', type: 'REAL' },
    ],
    rows,
    rowsAffected: rows.length,
  });

  it('aligns by display width, not string length', () => {
    expect(displayWidth('Nguyễn')).toBe(6);
    expect(displayWidth('Nguye\u0302\u0303n')).toBe(6); // decomposed: base letters plus combining marks
    expect(displayWidth('東京')).toBe(4);
    const text = renderResult(
      result([
        ['東京', 2],
        [null, 10.5],
        ['a\tb', -1],
      ]),
      'table',
    );
    expect(text).toBe(
      [
        ' name | n',
        '------+------',
        ' 東京 |  2.0',
        ' NULL | 10.5',
        ' a\\tb | -1.0',
        '(3 rows)',
        '',
      ].join('\n'),
    );
  });

  it('prints one block per row in line mode and empty fields for NULL in csv', () => {
    expect(renderResult(result([['x', 1]]), 'line')).toBe('name = x\n   n = 1.0\n');
    expect(renderResult(result([[null, null]]), 'csv')).toBe('name,n\n,\n');
  });

  it('prints command tags and notices', () => {
    expect(
      renderResult({ command: 'UPDATE', columns: [], rows: [], rowsAffected: 3 }, 'table'),
    ).toBe('UPDATE 3\n');
    expect(
      renderResult(
        {
          command: 'CREATE TABLE',
          columns: [],
          rows: [],
          rowsAffected: 0,
          notice: 'table "t" already exists, skipping',
        },
        'table',
      ),
    ).toBe('NOTICE: table "t" already exists, skipping\nCREATE TABLE\n');
  });
});

describe('command line', () => {
  async function cli(argv: string[], input = '', fs = new MemoryFileSystem()) {
    let out = '';
    let err = '';
    const code = await main(argv, {
      stdin: Readable.from([input]),
      write: (t) => (out += t),
      writeError: (t) => (err += t),
      fs,
    });
    return { code, out, err };
  }

  it('parses options', () => {
    expect(
      parseArgs(['shop.db', '-c', 'SELECT 1', '--command', 'SELECT 2', '-m', 'csv', '--sample']),
    ).toEqual({
      path: 'shop.db',
      commands: ['SELECT 1', 'SELECT 2'],
      sample: true,
      mode: 'csv',
      help: false,
      version: false,
    });
  });

  it('rejects bad usage with status 2', async () => {
    for (const argv of [['--frobnicate'], ['-c'], ['a.db', 'b.db'], ['-m', 'xml']]) {
      const { code, err } = await cli(argv);
      expect(code).toBe(2);
      expect(err).toMatch(/^granite: .+\nUsage: granite/);
    }
  });

  it('runs -c commands and exits 1 on the first error', async () => {
    const ok = await cli([
      '-m',
      'csv',
      '-c',
      'CREATE TABLE t (a INTEGER)',
      '-c',
      'INSERT INTO t VALUES (7)',
      '-c',
      'SELECT * FROM t',
    ]);
    expect(ok).toEqual({ code: 0, out: 'CREATE TABLE\nINSERT 1\na\n7\n', err: '' });
    const bad = await cli(['-c', 'SELECT 1/0', '-c', 'SELECT 2']);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('error[division_by_zero]');
    expect(bad.out).not.toContain('2');
  });

  it('reads piped SQL and keeps the database file', async () => {
    const fs = new MemoryFileSystem();
    const first = await cli(
      ['shop.db'],
      "CREATE TABLE t (a TEXT);\nINSERT INTO t VALUES ('kept');\n",
      fs,
    );
    expect(first.code).toBe(0);
    const second = await cli(['shop.db', '-c', 'SELECT a FROM t'], '', fs);
    expect(second.out).toContain(' kept\n');
    const failing = await cli(['shop.db'], 'SELECT * FROM nope;\nSELECT 1;\n', fs);
    expect(failing.code).toBe(1);
    expect(failing.out).toContain('(1 row)');
  });

  it('prints help and version', async () => {
    expect((await cli(['--help'])).out).toMatch(/^Usage: granite/);
    expect((await cli(['-v'])).out).toMatch(/^granite \d+\.\d+\.\d+\n$/);
  });
});
