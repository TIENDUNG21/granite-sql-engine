# 1. A synchronous block-file interface

Status: accepted

## Context

The engine has to run on Node, where files are the natural backend, and in the browser for Studio, where there is no synchronous file system. Browser storage (IndexedDB, OPFS) is asynchronous, except OPFS sync access handles, which only work in workers.

An asynchronous file API would make every layer above it asynchronous: the pager, the B+tree, the table store and every Volcano operator would return promises. Each `next()` call per row would cost a microtask. The pager's undo of a failed statement also depends on the statement running without interleaving, which `await` points would break.

## Decision

Storage goes through a small synchronous interface: `FileSystem.open(path)` returns a `BlockFile` with `size`, `read`, `write`, `truncate`, `sync` and `close`. There are two implementations. `NodeFileSystem` uses `fs.*Sync` and `fsyncSync`. `MemoryFileSystem` keeps the current bytes and, separately, the bytes as of the last `sync()`. Its `crash()` discards unsynced data, optionally keeping a torn part of it.

## Consequences

- Everything above the file layer is synchronous and simple, and a statement is atomic with respect to other sessions without locks.
- The in-memory backend doubles as the fault injector for crash tests. The same code paths run in tests, the CLI and Studio.
- Studio cannot persist a database. Saving to IndexedDB would have to be an explicit export and import of the in-memory files, not live I/O.
- Node's synchronous calls block the event loop while they run, which is acceptable for an embedded engine used by one process.
