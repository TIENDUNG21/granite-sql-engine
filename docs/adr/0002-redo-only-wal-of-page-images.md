# 2. A redo-only write-ahead log of full page images

Status: accepted

## Context

Committed changes must survive a crash at any point, including in the middle of writing a page of the data file. The common designs are ARIES-style logging of changes with redo and undo (Mohan et al., 1992), a rollback journal of old pages (SQLite's default), or a log of new page images (SQLite's WAL mode, and PostgreSQL's full-page writes after a checkpoint).

## Decision

A commit appends the full image of every page changed since the last commit, then a commit record, and fsyncs the log. Records carry a CRC-32 seeded with an epoch that changes at every checkpoint. Only a checkpoint writes the data file: it copies the logged pages, fsyncs, and then resets the log with the next epoch. Recovery replays every complete group and stops at the first record that is incomplete or fails its CRC.

There is no undo log. Uncommitted data never needs undoing on disk. A failed statement is undone in memory (ADR 3), and the versions of an uncommitted transaction are invisible because the commit log says so (ADR 4).

## Consequences

- Replay is idempotent, so a crash during recovery or during a checkpoint is handled by running recovery again.
- A torn page write in the data file is repaired by the image in the log, because the log is reset only after the data file is synced.
- Write amplification is high. Changing one row costs at least one 4 KiB image per touched page, including index pages. Deferring an explicit transaction's log write to its commit removes repeated images of the same page across statements, such as index leaves that every statement of a bulk load touches.
- Because the CRC is seeded with the epoch, a new log written over an older one cannot pick up the old log's stale tail as valid records.
- The crash tests can state one invariant: after any crash, the database equals the state after some prefix of the acknowledged commits.
