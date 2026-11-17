import { readFileSync, readdirSync } from 'node:fs';
import { Database, MemoryFileSystem, type Session } from '@granite/core';
import { describe, expect, it } from 'vitest';
import { runSlt, type SltTarget } from './slt/runner.ts';

const dir = new URL('./sql/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test'))
  .sort();

/** A fresh database on an in-memory file system per file; sessions open on first use. */
function target(): SltTarget {
  const fs = new MemoryFileSystem();
  let db = Database.open({ fs });
  let sessions = new Map<string, Session>();
  return {
    session(name) {
      let s = sessions.get(name);
      if (!s) {
        s = db.session();
        sessions.set(name, s);
      }
      return s;
    },
    restart() {
      db.close();
      db = Database.open({ fs });
      sessions = new Map();
    },
    crash() {
      // Power loss: unsynced bytes are gone and the database is not closed.
      fs.crash();
      db = Database.open({ fs });
      sessions = new Map();
    },
  };
}

describe('sqllogictest', () => {
  it('found test files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(file, () => {
      const text = readFileSync(new URL(file, dir), 'utf8');
      const records = runSlt(text, `tests/sql/${file}`, target());
      expect(records).toBeGreaterThan(0);
    });
  }
});
