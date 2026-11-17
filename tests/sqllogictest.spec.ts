import { readFileSync, readdirSync } from 'node:fs';
import { Database, type Session } from '@granite/core';
import { describe, expect, it } from 'vitest';
import { runSlt, type SltTarget } from './slt/runner.ts';

const dir = new URL('./sql/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test'))
  .sort();

/** A fresh in-memory database per file; sessions are opened on first use. */
function target(): SltTarget {
  const db = Database.open();
  const sessions = new Map<string, Session>();
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
      throw new Error('restart needs persistent storage');
    },
    crash() {
      throw new Error('crash needs persistent storage');
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
