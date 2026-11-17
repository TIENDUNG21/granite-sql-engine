# 3. Statement atomicity by page pre-images

Status: accepted

## Context

A statement must be all or nothing. Suppose `INSERT INTO t VALUES (1), (2), (1)` fails on the third row's unique key. It must leave no trace of the first two rows: no index entries, no B+tree splits, no page allocations. Inside an explicit transaction, the failure must not end the transaction. SQLite behaves this way; PostgreSQL aborts the whole transaction instead.

## Decision

The pager has *atomic sections*. While one is open, the first write to any page saves that page's previous bytes, and allocating a page records that the page did not exist before. Ending the section discards the saved bytes. Aborting it puts them back and forgets the new pages. Every statement runs in one section. Page 0 holds the page count, the free list and the next transaction id, and it is just another page here. Allocation, freeing and transaction-id assignment are therefore undone the same way.

This is valid because a statement runs to completion synchronously (ADR 1). Nothing else can read or write pages between its first change and its end.

## Consequences

- Rolling back a statement is exact and needs no logical inverse of B+tree operations, which keeps undo logic out of the B+tree code.
- After a failed statement, the in-memory catalog is reloaded from the catalog B+tree, so a failed `CREATE TABLE` leaves no schema behind.
- Memory use grows with the pages one statement touches, at most one extra copy per page.
- The cache cannot evict pages during a statement, because callers hold page objects. It is trimmed when the statement ends. An earlier version evicted on read and could drop a page that was about to be written. The benchmark's 10,000-row `UPDATE` exposed it, and a regression test now covers it.
