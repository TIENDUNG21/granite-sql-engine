import { GraniteError } from '../errors.ts';
import { HEADER, PAGE_SIZE, type Pager } from '../storage/pager.ts';

/** Status of a transaction id as recorded in the commit log. */
export type XidStatus = 'in-progress' | 'committed' | 'aborted';

const BITS: Record<XidStatus, number> = { 'in-progress': 0, committed: 1, aborted: 2 };
const XIDS_PER_PAGE = PAGE_SIZE * 4;
/** Directory slots between HEADER.clogDir and the end of page 0. */
const MAX_CLOG_PAGES = (PAGE_SIZE - HEADER.clogDir) / 4;

/** Highest transaction id the commit log can describe. */
export const MAX_XID = MAX_CLOG_PAGES * XIDS_PER_PAGE - 1;

/**
 * The commit log keeps two bits per transaction id in dedicated pages, whose
 * page numbers are listed in the database header. It is the only place that
 * says whether a transaction committed, so it is changed (and logged) in the
 * same WAL group as the commit itself.
 */
export class CommitLog {
  private readonly pager: Pager;

  constructor(pager: Pager) {
    this.pager = pager;
  }

  status(xid: number): XidStatus {
    if (xid === 0) return 'committed'; // rows written outside any transaction
    const page = this.page(xid, false);
    if (page === undefined) return 'in-progress';
    const offset = xid % XIDS_PER_PAGE;
    const bits = (this.pager.read(page).data[offset >> 2]! >> ((offset & 3) * 2)) & 3;
    return bits === 1 ? 'committed' : bits === 2 ? 'aborted' : 'in-progress';
  }

  set(xid: number, status: XidStatus): void {
    const page = this.page(xid, true)!;
    const offset = xid % XIDS_PER_PAGE;
    const data = this.pager.write(page).data;
    const shift = (offset & 3) * 2;
    data[offset >> 2] = (data[offset >> 2]! & ~(3 << shift)) | (BITS[status] << shift);
  }

  private page(xid: number, create: boolean): number | undefined {
    const index = Math.floor(xid / XIDS_PER_PAGE);
    const count = this.pager.read(0).view.getUint16(HEADER.clogCount);
    if (index < count) return this.pager.headerU32(HEADER.clogDir + index * 4);
    if (!create) return undefined;
    if (index >= MAX_CLOG_PAGES) {
      throw new GraniteError(
        'program_limit_exceeded',
        `transaction id ${xid} exceeds the commit log capacity`,
      );
    }
    let page = 0;
    for (let i = count; i <= index; i++) {
      page = this.pager.allocate().no;
      this.pager.setHeaderU32(HEADER.clogDir + i * 4, page);
    }
    this.pager.write(0).view.setUint16(HEADER.clogCount, index + 1);
    return page;
  }
}
