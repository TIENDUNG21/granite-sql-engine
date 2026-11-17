# Benchmarks

Measured with `npm run bench` (`bench/bench.ts`) on 2026-11-17.

Machine: Intel(R) Core(TM) i7-14700K, 28 threads, 32 GB RAM, Windows 11 Pro (10.0.22000), Node v22.19.0. Other heavy processes shared the CPU during the run, so treat the numbers as indicative.

Data: a table of 100,000 rows `(id INTEGER PRIMARY KEY, grp INTEGER, val REAL, name TEXT)` with a secondary index on `grp`, and a 1,000-row table to join with. Reads run on the in-memory file system; the disk rows use the Node file system with fsync. Every query is parsed, bound and planned again; there are no prepared statements. Timings are medians of several runs after a warm-up, except for the one-shot writes.

| Benchmark | Result | Detail |
| --- | ---: | --- |
| Bulk insert, one transaction (memory) | 84,933 rows/s | 100,000 rows in 1,177 ms |
| Bulk insert, one transaction (disk) | 86,475 rows/s | 100,000 rows in 1,156 ms, file 20.3 MiB |
| Autocommit insert (disk, fsync per commit) | 3,800 commits/s | 0.26 ms per statement |
| Point lookup by primary key | 12.3 µs/query | 20,000 queries, parse to result |
| Range scan on secondary index (1% of rows) | 2.06 ms/query | ~1,000 rows per query |
| Full scan with filter | 88.1 ms | 100,000 rows, 1,134,798 rows/s |
| Hash aggregate, 1,000 groups | 101.7 ms | 100,000 input rows |
| Hash join + aggregate | 118.6 ms | 100,000 x 1,000 rows |
| Sort, top 10 of 100,000 | 142.6 ms | full sort, then limit |
| UPDATE 10% of rows (new versions) | 219.5 ms | 10,170 rows, index entries rewritten |
| VACUUM after that update | 187.0 ms | 10,170 dead versions removed |
| Crash recovery (redo replay) | 15.0 ms | 4.2 MiB log, 5 commit groups, 278 MiB/s |
