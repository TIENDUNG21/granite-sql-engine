/**
 * A small sqllogictest-style runner.
 *
 * Records are separated by blank lines:
 *
 *   statement ok
 *   CREATE TABLE t (a INTEGER)
 *
 *   statement error <substring of the message or hint, or the error code>
 *   INSERT INTO t VALUES ('x')
 *
 *   query IT rowsort
 *   SELECT a, b FROM t
 *   ----
 *   1<TAB>x
 *
 * Column types: I INTEGER, R REAL, T TEXT, B BOOLEAN. Sort modes: nosort
 * (default), rowsort, valuesort. NULL is written NULL and '' as (empty).
 * Directives: `connection <name>` switches sessions, `restart` reopens the
 * database from its files, `crash` simulates power loss before reopening.
 */
import {
  GraniteError,
  formatError,
  formatValue,
  type QueryResult,
  type Value,
} from '@granite/core';

export type SltRecord =
  | { kind: 'statement'; line: number; sql: string; expectError: string | undefined; ok: boolean }
  | {
      kind: 'query';
      line: number;
      sql: string;
      types: string;
      sort: 'nosort' | 'rowsort' | 'valuesort';
      expected: string[];
    }
  | { kind: 'connection'; line: number; name: string }
  | { kind: 'restart' | 'crash'; line: number };

export function parseSlt(text: string): SltRecord[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const records: SltRecord[] = [];
  let i = 0;
  const blank = (l: string | undefined) => l === undefined || l.trim() === '';
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line) || line.startsWith('#')) {
      i++;
      continue;
    }
    const start = i + 1;
    const words = line.trim().split(/\s+/);
    const head = words[0];
    i++;
    if (head === 'connection') {
      records.push({ kind: 'connection', line: start, name: words[1] ?? 'default' });
      continue;
    }
    if (head === 'restart' || head === 'crash') {
      records.push({ kind: head, line: start });
      continue;
    }
    const sqlLines: string[] = [];
    while (i < lines.length && !blank(lines[i]) && lines[i] !== '----') sqlLines.push(lines[i++]!);
    const sql = sqlLines.join('\n');
    if (head === 'statement') {
      const ok = words[1] === 'ok';
      if (!ok && words[1] !== 'error')
        throw new Error(`line ${start}: expected "statement ok" or "statement error"`);
      const expectError = ok ? undefined : line.trim().split(/\s+/).slice(2).join(' ') || undefined;
      records.push({ kind: 'statement', line: start, sql, ok, expectError });
      continue;
    }
    if (head === 'query') {
      const types = words[1] ?? '';
      const sort = (words[2] ?? 'nosort') as 'nosort' | 'rowsort' | 'valuesort';
      if (!['nosort', 'rowsort', 'valuesort'].includes(sort))
        throw new Error(`line ${start}: bad sort mode ${sort}`);
      const expected: string[] = [];
      if (lines[i] === '----') {
        i++;
        while (i < lines.length && !blank(lines[i])) expected.push(lines[i++]!);
      }
      records.push({ kind: 'query', line: start, sql, types, sort, expected });
      continue;
    }
    throw new Error(`line ${start}: unknown record "${line}"`);
  }
  return records;
}

const TYPE_LETTERS: Record<string, string> = { INTEGER: 'I', REAL: 'R', TEXT: 'T', BOOLEAN: 'B' };

function render(v: Value, type: string): string {
  if (v === '') return '(empty)';
  return formatValue(v, type as 'REAL');
}

/** A database under test: a way to get a session by name and to reopen it. */
export interface SltTarget {
  session(name: string): { execute(sql: string): QueryResult[] };
  restart(): void;
  crash(): void;
}

export class SltFailure extends Error {}

export function runSlt(text: string, file: string, target: SltTarget): number {
  const records = parseSlt(text);
  let connection = 'default';
  for (const record of records) {
    const where = `${file}:${record.line}`;
    switch (record.kind) {
      case 'connection':
        connection = record.name;
        continue;
      case 'restart':
        target.restart();
        continue;
      case 'crash':
        target.crash();
        continue;
      case 'statement': {
        let error: unknown;
        try {
          target.session(connection).execute(record.sql);
        } catch (err) {
          error = err;
        }
        if (record.ok && error !== undefined) {
          throw new SltFailure(`${where}: statement failed\n${record.sql}\n${formatError(error)}`);
        }
        if (!record.ok) {
          if (error === undefined)
            throw new SltFailure(`${where}: statement should have failed\n${record.sql}`);
          if (!(error instanceof GraniteError)) {
            throw new SltFailure(`${where}: expected a GraniteError\n${formatError(error)}`);
          }
          const want = record.expectError;
          if (
            want &&
            !error.message.includes(want) &&
            error.code !== want &&
            !error.hint?.includes(want)
          ) {
            throw new SltFailure(
              `${where}: wrong error\nexpected: ${want}\nactual:   ${formatError(error)}`,
            );
          }
        }
        continue;
      }
      case 'query': {
        let result: QueryResult | undefined;
        try {
          result = target.session(connection).execute(record.sql).at(-1);
        } catch (err) {
          throw new SltFailure(`${where}: query failed\n${record.sql}\n${formatError(err)}`);
        }
        if (!result) throw new SltFailure(`${where}: no result`);
        const types = result.columns.map((c) => TYPE_LETTERS[c.type] ?? '?').join('');
        const typesMatch =
          types.length === record.types.length &&
          [...types].every((t, i) => t === '?' || t === record.types[i]);
        if (!typesMatch) {
          throw new SltFailure(
            `${where}: column types ${types} do not match ${record.types}\n${record.sql}`,
          );
        }
        let rows = result.rows.map((row) => row.map((v, i) => render(v, result.columns[i]!.type)));
        let actual: string[];
        if (record.sort === 'valuesort') actual = rows.flat().sort();
        else {
          if (record.sort === 'rowsort')
            rows = rows.sort((a, b) => (a.join('\t') < b.join('\t') ? -1 : 1));
          actual = rows.map((r) => r.join('\t'));
        }
        let expected = record.expected;
        if (record.sort === 'valuesort') expected = expected.flatMap((l) => l.split('\t')).sort();
        if (actual.join('\n') !== expected.join('\n')) {
          throw new SltFailure(
            `${where}: wrong result\n${record.sql}\n--- expected\n${expected.join('\n')}\n--- actual\n${actual.join('\n')}`,
          );
        }
        continue;
      }
    }
  }
  return records.length;
}
