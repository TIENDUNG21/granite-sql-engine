# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-17

First release.

### Added

- SQL front end: lexer with source spans and NFC-normalized string literals, recursive-descent parser with Pratt expression parsing, binder with name resolution, type checking and aggregate rules. Errors carry a code, a caret excerpt and, where possible, a hint.
- Statements: `CREATE`/`DROP TABLE`, `CREATE [UNIQUE]`/`DROP INDEX`, `INSERT` (values or query), `UPDATE`, `DELETE`, `SELECT` with `DISTINCT`, inner, left and cross joins, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY ... NULLS FIRST|LAST`, `LIMIT`/`OFFSET`, uncorrelated `IN` and scalar subqueries; `BEGIN`/`COMMIT`/`ROLLBACK`, `EXPLAIN [ANALYZE]`, `ANALYZE`, `VACUUM`, `CHECKPOINT`.
- Optimizer: constant folding, predicate pushdown that respects outer joins, index selection for equality, `IN` lists and ranges on index prefixes, statistics from `ANALYZE`, and join ordering by dynamic programming (greedy above ten relations) with hash and nested-loop joins.
- Volcano executor with sequential and index scans, filter, project, hash and nested-loop joins, hash aggregation, sort, distinct and limit.
- Storage: 4 KiB pages, a pager with a buffer cache and statement-level undo, slotted-page B+trees with overflow chains, order-preserving key encoding, and a free list.
- Write-ahead log of full page images with CRC-32 records, checkpoints and redo recovery.
- MVCC snapshot isolation with a commit log, first-updater-wins conflict detection, recovery of interrupted transactions, and `VACUUM`.
- `granite` shell with multi-line input, dot commands, four output modes, `-c` and piped input.
- Granite Studio: browser editor with highlighting from the engine's lexer, result grid, schema browser, example queries and `EXPLAIN` plans drawn as SVG, deployed to GitHub Pages.
- Deterministic sample shop dataset.
- `npm run bench`, with results in `docs/BENCHMARKS.md`.
- Tests: unit, property-based, sqllogictest-style suites, crash injection at every file operation, isolation between sessions, and plan snapshots.

[1.0.0]: https://github.com/TIENDUNG21/granite-sql-engine/releases/tag/v1.0.0
