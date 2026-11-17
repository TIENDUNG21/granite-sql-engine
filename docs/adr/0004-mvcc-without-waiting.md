# 4. PostgreSQL-style MVCC that fails instead of waiting

Status: accepted

## Context

Several sessions can have transactions open at once. Readers should not block writers or see uncommitted data, and a transaction should see a stable snapshot. The engine is single-threaded and synchronous (ADR 1). A statement cannot wait for another session's lock without a scheduler that could suspend it in the middle of execution.

## Decision

Multi-version concurrency control as in PostgreSQL. Every row version has `xmin` (creator) and `xmax` (deleter). A commit log stores two bits per transaction id in dedicated pages. An `UPDATE` stamps `xmax` on the old version and inserts a new version with a new row id and new index entries. The only in-place change to a version is setting its `xmax`.

Isolation is snapshot isolation (Berenson et al., 1995), and an explicit transaction takes its snapshot at its first statement. A write may meet a version whose `xmax` belongs to a transaction that is still running, or one that committed after the snapshot. The statement then fails at once with `serialization_failure` rather than waiting (first updater wins). A unique-key insert that meets a key held by a running transaction fails the same way.

Transactions found in progress when a database is opened were cut off by a crash and are marked aborted. `VACUUM` removes versions that no open snapshot can see.

## Consequences

- Readers never block and never fail. Only conflicting writers fail, and the client retries the whole transaction, as it would after a PostgreSQL serialization error.
- Commit and rollback are one commit-log write each. A rollback leaves dead versions for `VACUUM`.
- Write skew is possible, because snapshot isolation is not serializable. Serializable snapshot isolation would need read tracking and is out of scope.
- Every update of an indexed table adds index entries, and dead versions take space until `VACUUM`.
- The commit log covers 16.5 million transaction ids and does not handle wraparound.
- Schema changes are not versioned, so DDL is refused while other transactions are open.
