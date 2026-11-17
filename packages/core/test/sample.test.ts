import { describe, expect, it } from 'vitest';
import { Database, prng, sampleDatasetSql, sampleSizes } from '../src/index.ts';

describe('sample dataset', () => {
  it('is deterministic for a seed and changes with the seed', () => {
    expect(sampleDatasetSql({ scale: 0.05, seed: 7 })).toEqual(
      sampleDatasetSql({ scale: 0.05, seed: 7 }),
    );
    expect(sampleDatasetSql({ scale: 0.05, seed: 7 })).not.toEqual(
      sampleDatasetSql({ scale: 0.05, seed: 8 }),
    );
  });

  it('generates uniform values in [0, 1)', () => {
    const rand = prng(1);
    const xs = Array.from({ length: 10_000 }, rand);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.48);
    expect(mean).toBeLessThan(0.52);
  });

  it('loads into a database with the advertised sizes and consistent references', () => {
    const db = Database.open();
    for (const sql of sampleDatasetSql({ scale: 0.1 })) db.execute(sql);
    const sizes = sampleSizes({ scale: 0.1 });
    const count = (t: string) => db.query(`SELECT count(*) FROM ${t}`).rows[0]![0];
    expect(count('customers')).toBe(sizes.customers);
    expect(count('products')).toBe(sizes.products);
    expect(count('orders')).toBe(sizes.orders);
    expect(count('order_items')).toBeGreaterThan(sizes.orders);
    expect(
      db.query('SELECT count(*) FROM orders WHERE customer_id NOT IN (SELECT id FROM customers)')
        .rows,
    ).toEqual([[0]]);
    expect(
      db.query('SELECT count(*) FROM order_items WHERE product_id NOT IN (SELECT id FROM products)')
        .rows,
    ).toEqual([[0]]);
    // ANALYZE ran as the last statement.
    expect(db.tables().every((t) => t.stats !== undefined)).toBe(true);
  });

  it('stores every name in NFC', () => {
    const sql = sampleDatasetSql({ scale: 0.05 }).join('\n');
    expect(sql).toBe(sql.normalize('NFC'));
  });
});
