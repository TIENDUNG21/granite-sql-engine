import { GraniteError } from '../errors.ts';
import { crc32 } from './crc32.ts';
import type { BlockFile } from './file.ts';
import { PAGE_SIZE } from './pager.ts';

/**
 * Write-ahead log of full page images.
 *
 * File layout:
 *   header (16 bytes): magic "GRWAL001", epoch u32, reserved u32
 *   record:            type u8 | page u32 | length u32 | payload | crc32 u32
 *
 * A commit appends one PAGE record per changed page followed by a COMMIT
 * record, then fsyncs. Recovery replays complete groups (pages followed by a
 * valid COMMIT) and ignores everything after the first damaged or incomplete
 * record, which is what a crash in the middle of an append leaves behind.
 *
 * The CRC of every record is seeded with the epoch, which changes each time the
 * log is reset by a checkpoint, so bytes from an older log can never be mistaken
 * for records of the current one.
 */

const MAGIC = new TextEncoder().encode('GRWAL001');
export const WAL_HEADER_SIZE = 16;
const RECORD_HEADER = 9;
const RECORD_PAGE = 1;
const RECORD_COMMIT = 2;
const COMMIT_PAYLOAD = 8;

export interface RecoveryReport {
  /** Complete commit groups replayed. */
  readonly groups: number;
  /** Page images written back to the data file. */
  readonly pages: number;
  /** Bytes at the end of the log that were ignored (torn or incomplete). */
  readonly discardedBytes: number;
}

export class Wal {
  private readonly file: BlockFile;
  private epoch: number;
  private end: number;
  private sequence = 0;

  private constructor(file: BlockFile, epoch: number, end: number) {
    this.file = file;
    this.epoch = epoch;
    this.end = end;
  }

  /**
   * Open a log file, creating a header if it is empty. `newDatabase` says the
   * data file is empty: a log whose header never reached the disk can then be
   * recreated, because nothing can have been committed through it.
   */
  static open(file: BlockFile, options: { newDatabase?: boolean } = {}): Wal {
    const size = file.size();
    const header = file.read(0, WAL_HEADER_SIZE);
    const valid = size >= WAL_HEADER_SIZE && MAGIC.every((b, i) => header[i] === b);
    if (!valid) {
      if (size > 0 && !options.newDatabase) {
        throw new GraniteError('corrupt_database', 'the write-ahead log has a bad header');
      }
      const wal = new Wal(file, 1, WAL_HEADER_SIZE);
      wal.writeHeader();
      return wal;
    }
    const epoch = new DataView(header.buffer, header.byteOffset).getUint32(8);
    return new Wal(file, epoch, size);
  }

  /**
   * The header is rewritten in place before the file is cut back, so a torn
   * reset leaves either the old header (old records replay again, which is
   * harmless after a checkpoint) or the new epoch (old records fail their CRC).
   */
  private writeHeader(): void {
    const header = new Uint8Array(WAL_HEADER_SIZE);
    header.set(MAGIC);
    new DataView(header.buffer).setUint32(8, this.epoch);
    this.file.write(0, header);
    this.file.truncate(WAL_HEADER_SIZE);
    this.file.sync();
    this.end = WAL_HEADER_SIZE;
  }

  /** Bytes in the log, header included. */
  get size(): number {
    return this.end;
  }

  /** Append the images of `pages` as one commit group and make it durable. */
  appendGroup(pages: readonly { no: number; data: Uint8Array }[]): void {
    const pageRecord = RECORD_HEADER + PAGE_SIZE + 4;
    const buf = new Uint8Array(pages.length * pageRecord + RECORD_HEADER + COMMIT_PAYLOAD + 4);
    let pos = 0;
    for (const page of pages) pos = this.encode(buf, pos, RECORD_PAGE, page.no, page.data);
    const commit = new Uint8Array(COMMIT_PAYLOAD);
    const view = new DataView(commit.buffer);
    view.setUint32(0, ++this.sequence);
    view.setUint32(4, pages.length);
    pos = this.encode(buf, pos, RECORD_COMMIT, 0, commit);
    this.file.write(this.end, buf);
    this.file.sync();
    this.end += pos;
  }

  private encode(
    buf: Uint8Array,
    pos: number,
    type: number,
    page: number,
    payload: Uint8Array,
  ): number {
    const view = new DataView(buf.buffer, buf.byteOffset);
    const start = pos;
    buf[pos] = type;
    view.setUint32(pos + 1, page);
    view.setUint32(pos + 5, payload.length);
    buf.set(payload, pos + RECORD_HEADER);
    pos += RECORD_HEADER + payload.length;
    view.setUint32(pos, this.checksum(buf, start, pos));
    return pos + 4;
  }

  private checksum(buf: Uint8Array, start: number, end: number): number {
    const seed = new Uint8Array(4);
    new DataView(seed.buffer).setUint32(0, this.epoch);
    return crc32(buf, crc32(seed), start, end);
  }

  /**
   * Replay every complete commit group through `apply`, in log order, and
   * report what was found. The log itself is not modified.
   */
  recover(apply: (page: number, data: Uint8Array) => void): RecoveryReport {
    const size = this.file.size();
    const log = this.file.read(0, size);
    const view = new DataView(log.buffer, log.byteOffset, log.byteLength);
    let pos = WAL_HEADER_SIZE;
    let committedEnd = pos;
    let pending: { page: number; data: Uint8Array }[] = [];
    let groups = 0;
    let pages = 0;
    while (pos + RECORD_HEADER + 4 <= log.length) {
      const type = log[pos]!;
      const page = view.getUint32(pos + 1);
      const length = view.getUint32(pos + 5);
      const expected =
        type === RECORD_PAGE ? PAGE_SIZE : type === RECORD_COMMIT ? COMMIT_PAYLOAD : -1;
      if (length !== expected) break;
      const end = pos + RECORD_HEADER + length;
      if (end + 4 > log.length) break;
      if (view.getUint32(end) !== this.checksum(log, pos, end)) break;
      if (type === RECORD_PAGE) {
        pending.push({ page, data: log.slice(pos + RECORD_HEADER, end) });
      } else {
        if (view.getUint32(pos + RECORD_HEADER + 4) !== pending.length) break;
        for (const p of pending) apply(p.page, p.data);
        pages += pending.length;
        groups++;
        pending = [];
        this.sequence = view.getUint32(pos + RECORD_HEADER);
        committedEnd = end + 4;
      }
      pos = end + 4;
    }
    return { groups, pages, discardedBytes: size - committedEnd };
  }

  /** Empty the log after a checkpoint; the new epoch invalidates any stale bytes. */
  reset(): void {
    this.epoch = (this.epoch + 1) >>> 0 || 1;
    this.sequence = 0;
    this.writeHeader();
  }

  close(): void {
    this.file.close();
  }
}
