import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../../src/storage/file.ts';
import { NodeFileSystem } from '../../src/storage/node-fs.ts';

const bytes = (...xs: number[]) => new Uint8Array(xs);

describe('MemoryFileSystem', () => {
  it('reads back what was written, zero-filling gaps', () => {
    const fs = new MemoryFileSystem();
    const f = fs.open('a');
    f.write(4, bytes(9, 8));
    expect(f.size()).toBe(6);
    expect([...f.read(0, 10)]).toEqual([0, 0, 0, 0, 9, 8]);
    expect(f.read(10, 4)).toHaveLength(0);
  });

  it('keeps data across opens of the same path', () => {
    const fs = new MemoryFileSystem();
    fs.open('a').write(0, bytes(1, 2, 3));
    expect([...fs.open('a').read(0, 3)]).toEqual([1, 2, 3]);
    expect(fs.exists('a')).toBe(true);
    fs.remove('a');
    expect(fs.exists('a')).toBe(false);
  });

  it('truncates and extends', () => {
    const f = new MemoryFileSystem().open('a');
    f.write(0, bytes(1, 2, 3, 4));
    f.truncate(2);
    expect([...f.read(0, 4)]).toEqual([1, 2]);
    f.truncate(4);
    expect([...f.read(0, 4)]).toEqual([1, 2, 0, 0]);
  });

  it('loses unsynced writes in a crash', () => {
    const fs = new MemoryFileSystem();
    const f = fs.open('a');
    f.write(0, bytes(1, 2));
    f.sync();
    f.write(2, bytes(3, 4));
    f.write(0, bytes(7));
    fs.crash();
    expect([...fs.contents('a')]).toEqual([1, 2]);
  });

  it('lets a crash policy keep a torn tail', () => {
    const fs = new MemoryFileSystem();
    const f = fs.open('wal');
    f.write(0, bytes(1, 2));
    f.sync();
    f.write(2, bytes(3, 4, 5));
    fs.crash((_path, durable, current) => current.slice(0, durable.length + 1));
    expect([...fs.contents('wal')]).toEqual([1, 2, 3]);
    expect([...fs.durableContents('wal')]).toEqual([1, 2, 3]);
  });
});

describe('NodeFileSystem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'granite-fs-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('creates, writes, syncs, truncates and reopens a real file', () => {
    const fs = new NodeFileSystem();
    const path = join(dir, 'x.bin');
    expect(fs.exists(path)).toBe(false);
    const f = fs.open(path);
    f.write(0, bytes(1, 2, 3, 4, 5));
    f.sync();
    f.truncate(3);
    f.close();
    const again = fs.open(path);
    expect(again.size()).toBe(3);
    expect([...again.read(0, 10)]).toEqual([1, 2, 3]);
    again.close();
    fs.remove(path);
    expect(fs.exists(path)).toBe(false);
  });

  it('reports unopenable paths as io errors', () => {
    expect(() => new NodeFileSystem().open(join(dir, 'missing-dir', 'x'))).toThrow(/cannot open/);
  });
});
