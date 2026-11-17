import * as fs from 'node:fs';
import { GraniteError } from '../errors.ts';
import type { BlockFile, FileSystem } from './file.ts';

/** Files on disk through Node's synchronous fs API, with fsync on sync(). */
export class NodeFileSystem implements FileSystem {
  open(path: string): BlockFile {
    return new NodeFile(path);
  }

  exists(path: string): boolean {
    return fs.existsSync(path);
  }

  remove(path: string): void {
    fs.rmSync(path, { force: true });
  }
}

class NodeFile implements BlockFile {
  private fd: number;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    try {
      this.fd = fs.openSync(path, fs.existsSync(path) ? 'r+' : 'w+');
    } catch (err) {
      throw ioError(`cannot open ${path}`, err);
    }
  }

  size(): number {
    return fs.fstatSync(this.fd).size;
  }

  read(offset: number, length: number): Uint8Array {
    const buf = new Uint8Array(length);
    const n = fs.readSync(this.fd, buf, 0, length, offset);
    return n === length ? buf : buf.subarray(0, n);
  }

  write(offset: number, data: Uint8Array): void {
    let done = 0;
    while (done < data.length) {
      done += fs.writeSync(this.fd, data, done, data.length - done, offset + done);
    }
  }

  truncate(size: number): void {
    fs.ftruncateSync(this.fd, size);
  }

  sync(): void {
    fs.fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd >= 0) {
      fs.closeSync(this.fd);
      this.fd = -1;
    }
  }

  toString(): string {
    return this.path;
  }
}

function ioError(message: string, cause: unknown): GraniteError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new GraniteError('io_error', `${message}: ${detail}`, { cause });
}
