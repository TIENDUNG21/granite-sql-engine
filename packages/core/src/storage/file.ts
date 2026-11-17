/**
 * A synchronous random-access file. The storage engine needs nothing more:
 * read and write at offsets, change the length, and make writes durable.
 */
export interface BlockFile {
  size(): number;
  /** Read up to `length` bytes at `offset`; shorter at end of file. */
  read(offset: number, length: number): Uint8Array;
  write(offset: number, data: Uint8Array): void;
  truncate(size: number): void;
  /** Make every write so far durable (fsync). */
  sync(): void;
  close(): void;
}

export interface FileSystem {
  /** Open a file for reading and writing, creating it if missing. */
  open(path: string): BlockFile;
  exists(path: string): boolean;
  remove(path: string): void;
}

/** How much of the not-yet-synced bytes of a file survive a simulated crash. */
export type CrashPolicy = (path: string, durable: Uint8Array, current: Uint8Array) => Uint8Array;

/**
 * Files kept in memory. Every file tracks its contents as of the last `sync()`,
 * so `crash()` can throw away what a power cut would lose. Used by tests, by the
 * crash-recovery suite and by Granite Studio in the browser.
 */
export class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, MemoryFile>();

  open(path: string): BlockFile {
    let file = this.files.get(path);
    if (!file) {
      file = new MemoryFile();
      this.files.set(path, file);
    }
    return file;
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  /** Current contents of a file (for tests and tooling). */
  contents(path: string): Uint8Array {
    return this.files.get(path)?.bytes() ?? new Uint8Array(0);
  }

  /** Bytes of a file as of its last sync. */
  durableContents(path: string): Uint8Array {
    return this.files.get(path)?.durableBytes() ?? new Uint8Array(0);
  }

  /**
   * Simulate a power cut: every file falls back to what was synced, unless the
   * policy keeps part of the unsynced data (a torn write). The database must be
   * reopened afterwards, as after a real crash.
   */
  crash(policy: CrashPolicy = (_path, durable) => durable): void {
    for (const [path, file] of this.files) {
      file.reset(policy(path, file.durableBytes(), file.bytes()));
    }
  }
}

class MemoryFile implements BlockFile {
  private data = new Uint8Array(0);
  private length = 0;
  private durable = new Uint8Array(0);

  bytes(): Uint8Array {
    return this.data.slice(0, this.length);
  }

  durableBytes(): Uint8Array {
    return this.durable.slice();
  }

  /** Replace the contents after a simulated crash; what remains counts as durable. */
  reset(contents: Uint8Array): void {
    this.data = contents.slice();
    this.length = contents.length;
    this.durable = contents.slice();
  }

  size(): number {
    return this.length;
  }

  read(offset: number, length: number): Uint8Array {
    const end = Math.min(this.length, offset + length);
    return offset >= end ? new Uint8Array(0) : this.data.slice(offset, end);
  }

  write(offset: number, chunk: Uint8Array): void {
    const end = offset + chunk.length;
    if (end > this.data.length) {
      const grown = new Uint8Array(Math.max(end, this.data.length * 2, 4096));
      grown.set(this.data.subarray(0, this.length));
      this.data = grown;
    }
    if (offset > this.length) this.data.fill(0, this.length, offset);
    this.data.set(chunk, offset);
    this.length = Math.max(this.length, end);
  }

  truncate(size: number): void {
    if (size < this.length) this.data.fill(0, size, this.length);
    else if (size > this.data.length) {
      const grown = new Uint8Array(size);
      grown.set(this.data.subarray(0, this.length));
      this.data = grown;
    }
    this.length = size;
  }

  sync(): void {
    this.durable = this.data.slice(0, this.length);
  }

  close(): void {}
}
