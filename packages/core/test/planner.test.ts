import { beforeAll, describe, expect, it } from 'vitest';
import { Database, sampleDatasetSql, type PlanNodeInfo } from '../src/index.ts';

function shape(node: PlanNodeInfo, depth = 0): string[] {
  return [
    `${'  '.repeat(depth)}${node.op} ${node.detail}`.trimEnd(),
    ...node.children.flatMap((c) => shape(c, depth + 1)),
  ];
}

describe('optimizer', () => {
  let db: Database;
  beforeAll(() => {
    db = Database.open();
    for (const sql of sampleDatasetSql({ scale: 0.2 })) db.execute(sql);
  });

  const plan = (sql: string) => shape(db.query(`EXPLAIN ${sql}`).plan!);

  it('uses the primary key for point lookups, also in UPDATE and DELETE', () => {
    expect(plan('SELECT name FROM customers WHERE id = 7').at(-1)).toBe(
      '  IndexScan customers using customers_pkey (id = 7)',
    );
    expect(plan('DELETE FROM orders WHERE id = 3')).toEqual([
      'Delete orders',
      '  IndexScan orders using orders_pkey (id = 3)',
    ]);
  });

  it('uses composite index prefixes, IN lists and ranges', () => {
    expect(plan('SELECT * FROM order_items WHERE order_id = 5').at(-1)).toBe(
      '  IndexScan order_items using order_items_pkey (order_id = 5)',
    );
    expect(
      plan('SELECT * FROM order_items WHERE order_id IN (5, 6) AND product_id > 10').at(-1),
    ).toBe(
      '  IndexScan order_items using order_items_pkey (order_id IN (5, 6) AND product_id > 10)',
    );
    expect(plan('SELECT * FROM orders WHERE 100 >= id AND id > 90').at(-1)).toBe(
      '  IndexScan orders using orders_pkey (id > 90 AND id <= 100)',
    );
  });

  it('estimates a two-sided range as one interval, wherever it lies', () => {
    const uniform = Database.open();
    uniform.execute(
      'CREATE TABLE u (id INTEGER PRIMARY KEY, g INTEGER); CREATE INDEX u_g ON u (g)',
    );
    const rows = Array.from({ length: 5000 }, (_, i) => `(${i}, ${1 + (i % 1000)})`);
    uniform.execute(`INSERT INTO u VALUES ${rows.join(', ')}`);
    uniform.execute('ANALYZE');
    for (const low of [1, 400, 900]) {
      const sql = `SELECT * FROM u WHERE g BETWEEN ${low} AND ${low + 9}`;
      const scan = uniform.query(`EXPLAIN ${sql}`).plan!.children[0]!;
      expect(scan.op).toBe('IndexScan');
      // 50 rows qualify; independent bounds would estimate up to ~1,250.
      expect(scan.rows).toBeGreaterThanOrEqual(25);
      expect(scan.rows).toBeLessThanOrEqual(100);
    }
    // An empty interval still estimates at least one row.
    const empty = uniform.query('EXPLAIN SELECT * FROM u WHERE g > 500 AND g < 400').plan!;
    expect(empty.children[0]!.rows).toBeGreaterThanOrEqual(1);
  });

  it('prefers a sequential scan when most rows qualify', () => {
    expect(plan('SELECT * FROM orders WHERE id > 1').at(-1)).toBe(
      '  SeqScan orders filter: orders.id > 1',
    );
  });

  it('turns contradictions into an empty plan, keeping the aggregate row', () => {
    expect(plan('SELECT count(*) FROM orders WHERE 1 = 2 AND id > 0')).toEqual([
      'Project count(*)',
      '  HashAggregate count(*)',
      '    Empty contradiction',
    ]);
    expect(db.query('SELECT count(*) FROM orders WHERE 1 = 2').rows).toEqual([[0]]);
  });

  it('pushes single-table predicates below joins and builds the hash table on the smaller side', () => {
    const lines = plan(
      "SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.city = 'Huế' AND o.status = 'pending'",
    );
    // 200 customers: the city index and a full scan cost about the same, either is fine.
    expect(lines.slice(0, 3)).toEqual([
      'Project o.id',
      '  HashJoin INNER on o.customer_id = c.id',
      "    SeqScan orders o filter: o.status = 'pending'",
    ]);
    expect(lines[3]).toMatch(
      /^ {4}(SeqScan customers c filter: c\.city = 'Huế'|IndexScan customers c using customers_city \(city = 'Huế'\))$/,
    );
  });

  it('keeps WHERE predicates on the nullable side of a LEFT JOIN above the join', () => {
    expect(
      plan(
        "SELECT c.id FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'pending' WHERE o.id IS NULL",
      ),
    ).toEqual([
      'Project c.id',
      '  Filter o.id IS NULL',
      '    HashJoin LEFT on c.id = o.customer_id',
      '      SeqScan customers c',
      "      SeqScan orders o filter: o.status = 'pending'",
    ]);
  });

  it('orders a four-way join by estimated cost', () => {
    const lines = plan(`
      SELECT c.city, p.category, sum(oi.quantity)
      FROM order_items oi, orders o, products p, customers c
      WHERE o.id = oi.order_id AND p.id = oi.product_id AND c.id = o.customer_id AND c.vip
      GROUP BY c.city, p.category`);
    expect(lines.filter((l) => l.includes('Join'))).toHaveLength(3);
    expect(lines.some((l) => l.includes('NestedLoopJoin'))).toBe(false);
    expect(lines.join('\n')).toMatch(/SeqScan customers c filter: c\.vip/);
  });

  it('orders joins of more than ten tables greedily', () => {
    const tables = Array.from({ length: 12 }, (_, i) => `products p${i}`).join(', ');
    const where = Array.from({ length: 11 }, (_, i) => `p${i}.id = p${i + 1}.id`).join(' AND ');
    const sql = `SELECT count(*) FROM ${tables} WHERE ${where}`;
    expect(plan(sql).filter((l) => l.includes('HashJoin'))).toHaveLength(11);
    expect(db.query(sql).rows).toEqual([[120]]);
  });

  it('falls back to a nested loop without an equality', () => {
    expect(
      plan('SELECT * FROM products a JOIN products b ON a.price < b.price').some((l) =>
        l.includes('NestedLoopJoin INNER'),
      ),
    ).toBe(true);
    expect(
      plan('SELECT * FROM products a, products b').some((l) => l.includes('NestedLoopJoin CROSS')),
    ).toBe(true);
  });
});

describe('plan snapshots', () => {
  it('matches the recorded plans on the sample dataset', () => {
    const db = Database.open();
    for (const sql of sampleDatasetSql({ scale: 0.2 })) db.execute(sql);
    const queries = [
      'SELECT * FROM customers WHERE id = 42',
      "SELECT name FROM customers WHERE city = 'Đà Lạt' ORDER BY name LIMIT 3",
      'SELECT status, count(*) FROM orders GROUP BY status ORDER BY 2 DESC',
      `SELECT c.name, sum(oi.quantity * oi.unit_price) AS spent
         FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items oi ON oi.order_id = o.id
        WHERE o.status = 'delivered' GROUP BY c.name HAVING sum(oi.quantity) > 3 ORDER BY spent DESC LIMIT 10`,
      `SELECT p.name FROM products p WHERE p.id NOT IN (SELECT product_id FROM order_items)`,
      `SELECT c.city, count(o.id) FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.city`,
      'SELECT DISTINCT category FROM products WHERE price BETWEEN 10 AND 20',
      "UPDATE orders SET status = 'shipped' WHERE id IN (1, 2, 3)",
    ];
    for (const q of queries) {
      const text = db
        .query(`EXPLAIN ${q}`)
        .rows.map((r) => r[0])
        .join('\n');
      expect(text).toMatchSnapshot(q.replace(/\s+/g, ' ').trim());
    }
  });
});

describe('optimizer correctness', () => {
  it('returns the same rows with and without indexes and statistics', () => {
    const tuned = Database.open();
    const plain = Database.open();
    for (const sql of sampleDatasetSql({ scale: 0.1 })) {
      tuned.execute(sql);
      if (!sql.startsWith('CREATE INDEX') && sql !== 'ANALYZE')
        plain.execute(
          sql.replace(/PRIMARY KEY \(order_id, product_id\)/, 'UNIQUE (order_id, product_id)'),
        );
    }
    // The plain copy has no secondary indexes, no stats, and no composite primary key index.
    plain.execute('DROP INDEX order_items_order_id_product_id_key');
    const queries = [
      'SELECT id, name FROM customers WHERE id = 17',
      "SELECT id FROM customers WHERE city = 'Huế' AND joined >= 2022",
      'SELECT order_id, product_id FROM order_items WHERE order_id IN (3, 5, 8) AND product_id <= 60',
      'SELECT id FROM orders WHERE id > 450 AND id <= 470',
      `SELECT c.city, count(*), sum(oi.quantity) FROM customers c JOIN orders o ON o.customer_id = c.id
         JOIN order_items oi ON oi.order_id = o.id GROUP BY c.city`,
      `SELECT c.id, o.id FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'cancelled'`,
      'SELECT p.category, max(oi.unit_price) FROM products p JOIN order_items oi ON p.id = oi.product_id GROUP BY p.category',
      `SELECT id FROM customers WHERE id IN (SELECT customer_id FROM orders WHERE status = 'pending')`,
      `SELECT o.id FROM orders o, customers c WHERE o.customer_id = c.id AND c.vip AND o.ordered_on < '2024-03-01'`,
    ];
    const sorted = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();
    for (const q of queries) {
      expect(sorted(tuned.query(q).rows), q).toEqual(sorted(plain.query(q).rows));
    }
  });
});
