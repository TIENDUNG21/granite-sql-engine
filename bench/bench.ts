/**
 * Granite benchmarks. Run with `npm run bench`; `-- --markdown docs/BENCHMARKS.md`
 * also writes the results as Markdown. Every number in the docs comes from here.
 *
 * Statements go through the full pipeline each time (parse, bind, plan,
 * execute): there are no prepared statements, so point lookups include parsing.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { Database, MemoryFileSystem, prng, type FileSystem } from '../packages/core/src/index.ts';
import { NodeFileSystem } from '../packages/core/src/node.ts';

const ROWS = 100_000;
const GROUPS = 1_000;
const BATCH = 500;

interface Row {
  name: string;
  result: string;
  detail: string;
}
const results: Row[] = [];

function report(name: string, result: string, detail: string): void {
  results.push({ name, result, detail });
  console.log(`${name.padEnd(44)} ${result.padStart(16)}   ${detail}`);
}

function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

/** Median of `runs` timings after one warm-up run. */
function median(runs: number, fn: () => void): number {
  fn();
  const times = Array.from({ length: runs }, () => time(fn)).sort((a, b) => a - b);
  return times[Math.floor(runs / 2)]!;
}

const fmt = (n: number, digits = 0): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function insertStatements(rows: number): string[] {
  const rand = prng(7);
  const out: string[] = [];
  for (let start = 1; start <= rows; start += BATCH) {
    const values: string[] = [];
    for (let id = start; id < Math.min(start + BATCH, rows + 1); id++) {
      const grp = 1 + Math.floor(rand() * GROUPS);
      values.push(`(${id}, ${grp}, ${(rand() * 1000).toFixed(3)}, 'item-${id}')`);
    }
    out.push(`INSERT INTO items VALUES ${values.join(', ')}`);
  }
  return out;
}

const SCHEMA =
  'CREATE TABLE items (id INTEGER PRIMARY KEY, grp INTEGER NOT NULL, val REAL, name TEXT);' +
  'CREATE INDEX items_grp ON items (grp);' +
  'CREATE TABLE groups (id INTEGER PRIMARY KEY, label TEXT)';

function load(db: Database, inserts: string[]): void {
  db.execute(SCHEMA);
  const s = db.session();
  s.execute('BEGIN');
  for (const sql of inserts) s.execute(sql);
  const labels = Array.from({ length: GROUPS }, (_, i) => `(${i + 1}, 'group ${i % 37}')`);
  s.execute(`INSERT INTO groups VALUES ${labels.join(', ')}`);
  s.execute('COMMIT');
  s.close();
  db.execute('ANALYZE');
}

function tempDir(): string {
  return mkdtempSync(join(os.tmpdir(), 'granite-bench-'));
}

// ------------------------------------------------------------------ writes

const inserts = insertStatements(ROWS);

{
  const db = Database.open({ fs: new MemoryFileSystem() });
  const ms = time(() => load(db, inserts));
  report(
    'Bulk insert, one transaction (memory)',
    `${fmt((ROWS / ms) * 1000)} rows/s`,
    `${fmt(ROWS)} rows in ${fmt(ms)} ms`,
  );
}

{
  const dir = tempDir();
  try {
    const db = Database.open({ fs: new NodeFileSystem(), path: join(dir, 'bench.db') });
    const ms = time(() => load(db, inserts));
    db.close();
    const size = statSync(join(dir, 'bench.db')).size / 2 ** 20;
    report(
      'Bulk insert, one transaction (disk)',
      `${fmt((ROWS / ms) * 1000)} rows/s`,
      `${fmt(ROWS)} rows in ${fmt(ms)} ms, file ${fmt(size, 1)} MiB`,
    );

    const again = Database.open({ fs: new NodeFileSystem(), path: join(dir, 'bench.db') });
    const n = 500;
    const commitMs = time(() => {
      for (let i = 1; i <= n; i++)
        again.execute(`INSERT INTO groups VALUES (${GROUPS + i}, 'extra')`);
    });
    report(
      'Autocommit insert (disk, fsync per commit)',
      `${fmt((n / commitMs) * 1000)} commits/s`,
      `${fmt(commitMs / n, 2)} ms per statement`,
    );
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- reads

const db = Database.open({ fs: new MemoryFileSystem() });
load(db, inserts);

{
  const rand = prng(11);
  const n = 20_000;
  const keys = Array.from({ length: n }, () => 1 + Math.floor(rand() * ROWS));
  const ms = median(3, () => {
    for (const k of keys) db.execute('SELECT name, val FROM items WHERE id = $1', [k]);
  });
  report(
    'Point lookup by primary key',
    `${fmt((ms / n) * 1000, 1)} µs/query`,
    `${fmt(n)} queries, parse to result`,
  );
}

{
  const n = 200;
  const ms = median(3, () => {
    for (let i = 0; i < n; i++)
      db.execute(`SELECT count(*), sum(val) FROM items WHERE grp BETWEEN ${i} AND ${i + 9}`);
  });
  report(
    'Range scan on secondary index (1% of rows)',
    `${fmt(ms / n, 2)} ms/query`,
    `~${fmt(ROWS / 100)} rows per query`,
  );
}

{
  const ms = median(5, () =>
    db.execute('SELECT count(*), avg(val) FROM items WHERE name LIKE $1', ['%7%']),
  );
  report(
    'Full scan with filter',
    `${fmt(ms, 1)} ms`,
    `${fmt(ROWS)} rows, ${fmt((ROWS / ms) * 1000)} rows/s`,
  );
}

{
  const ms = median(5, () => db.execute('SELECT grp, count(*), avg(val) FROM items GROUP BY grp'));
  report('Hash aggregate, 1,000 groups', `${fmt(ms, 1)} ms`, `${fmt(ROWS)} input rows`);
}

{
  const ms = median(5, () =>
    db.execute(
      'SELECT g.label, count(*), max(i.val) FROM items i JOIN groups g ON g.id = i.grp GROUP BY g.label',
    ),
  );
  report('Hash join + aggregate', `${fmt(ms, 1)} ms`, `${fmt(ROWS)} x ${fmt(GROUPS)} rows`);
}

{
  const ms = median(5, () => db.execute('SELECT id, val FROM items ORDER BY val DESC LIMIT 10'));
  report('Sort, top 10 of 100,000', `${fmt(ms, 1)} ms`, 'full sort, then limit');
}

{
  const updateMs = time(() => db.execute('UPDATE items SET val = val + 1 WHERE grp <= 100'));
  const changed = db.query('SELECT count(*) FROM items WHERE grp <= 100').rows[0]![0] as number;
  report(
    'UPDATE 10% of rows (new versions)',
    `${fmt(updateMs, 1)} ms`,
    `${fmt(changed)} rows, index entries rewritten`,
  );
  const vacuumMs = time(() => db.execute('VACUUM items'));
  report(
    'VACUUM after that update',
    `${fmt(vacuumMs, 1)} ms`,
    `${fmt(changed)} dead versions removed`,
  );
}

// ---------------------------------------------------------------- recovery

{
  // A log full of committed work that was never checkpointed, then a crash.
  const fs: FileSystem & MemoryFileSystem = new MemoryFileSystem();
  const writer = Database.open({ fs, checkpointBytes: 1 << 30 });
  load(writer, inserts.slice(0, 40));
  const logBytes = fs.contents('granite.db-wal').length;
  fs.crash();
  let groups = 0;
  const ms = time(() => {
    groups = Database.open({ fs }).recovery.groups;
  });
  report(
    'Crash recovery (redo replay)',
    `${fmt(ms, 1)} ms`,
    `${fmt(logBytes / 2 ** 20, 1)} MiB log, ${groups} commit groups, ${fmt(logBytes / 2 ** 20 / (ms / 1000))} MiB/s`,
  );
}

// ------------------------------------------------------------------ output

const cpu = os.cpus()[0]!.model.replace(/\s+/g, ' ').trim();
const machine = `${cpu}, ${os.cpus().length} threads, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, ${os.version()} (${os.release()}), Node ${process.version}`;
console.log(`\n${machine}`);

const out = process.argv.indexOf('--markdown');
if (out >= 0) {
  const path = process.argv[out + 1] ?? 'docs/BENCHMARKS.md';
  const lines = [
    '# Benchmarks',
    '',
    `Measured with \`npm run bench\` (\`bench/bench.ts\`) on ${new Date().toISOString().slice(0, 10)}.`,
    '',
    `Machine: ${machine}. Other heavy processes shared the CPU during the run, so treat the numbers as indicative.`,
    '',
    `Data: a table of ${fmt(ROWS)} rows \`(id INTEGER PRIMARY KEY, grp INTEGER, val REAL, name TEXT)\` with a secondary index on \`grp\`, and a ${fmt(GROUPS)}-row table to join with. Reads run on the in-memory file system; the disk rows use the Node file system with fsync. Every query is parsed, bound and planned again; there are no prepared statements. Timings are medians of several runs after a warm-up, except for the one-shot writes.`,
    '',
    '| Benchmark | Result | Detail |',
    '| --- | ---: | --- |',
    ...results.map((r) => `| ${r.name} | ${r.result} | ${r.detail} |`),
    '',
  ];
  writeFileSync(path, lines.join('\n'));
  console.log(`wrote ${path}`);
}
