import { prng } from '../../src/sample/dataset.ts';
import {
  MemoryFileSystem,
  type BlockFile,
  type CrashPolicy,
  type FileSystem,
} from '../../src/storage/file.ts';

export class SimulatedCrash extends Error {}

/**
 * A MemoryFileSystem that throws SimulatedCrash at the n-th write, truncate or
 * sync, so a test can stop the engine at every I/O step of a workload.
 */
export class FaultyFileSystem implements FileSystem {
  readonly memory = new MemoryFileSystem();
  /** 1-based index of the operation that fails; Infinity disables faults. */
  crashAt = Infinity;
  operations = 0;

  open(path: string): BlockFile {
    const inner = this.memory.open(path);
    const step = () => {
      if (++this.operations === this.crashAt)
        throw new SimulatedCrash(`crash at operation ${this.operations}`);
    };
    return {
      size: () => inner.size(),
      read: (offset, length) => inner.read(offset, length),
      write: (offset, data) => {
        step();
        inner.write(offset, data);
      },
      truncate: (size) => {
        step();
        inner.truncate(size);
      },
      sync: () => {
        step();
        inner.sync();
      },
      close: () => inner.close(),
    };
  }

  exists(path: string): boolean {
    return this.memory.exists(path);
  }

  remove(path: string): void {
    this.memory.remove(path);
  }

  /** Lose or tear unsynced data, then disarm the fault. */
  crash(policy: CrashPolicy): void {
    this.memory.crash(policy);
    this.crashAt = Infinity;
  }
}

const SECTOR = 512;

/**
 * What a power cut can leave on disk: for an append-only log, the synced part
 * plus some prefix of the unsynced tail, possibly followed by garbage; for an
 * in-place file, every 512-byte sector independently old or new.
 */
export function tornWrites(seed: number): CrashPolicy {
  const rand = prng(seed);
  return (path, durable, current) => {
    const appended = current.length >= durable.length && durable.every((b, i) => current[i] === b);
    if (path.endsWith('-wal') && appended) {
      const keep = Math.floor(rand() * (current.length - durable.length + 1));
      const garbage =
        rand() < 0.3
          ? Array.from({ length: Math.floor(rand() * 64) }, () => Math.floor(rand() * 256))
          : [];
      const out = new Uint8Array(durable.length + keep + garbage.length);
      out.set(current.subarray(0, durable.length + keep));
      out.set(garbage, durable.length + keep);
      return out;
    }
    const length = rand() < 0.5 ? durable.length : current.length;
    const out = new Uint8Array(length);
    for (let s = 0; s < length; s += SECTOR) {
      const source = rand() < 0.5 ? durable : current;
      out.set(source.subarray(s, Math.min(s + SECTOR, length)), s);
    }
    return out;
  };
}
