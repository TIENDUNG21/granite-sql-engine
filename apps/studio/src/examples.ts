/** Queries over the sample shop database, shown in the sidebar. */
export interface Example {
  readonly title: string;
  readonly sql: string;
}

export const EXAMPLES: readonly Example[] = [
  {
    title: 'Top customers by revenue',
    sql: `-- Three-way join, grouped and sorted. Try "Explain" to see the hash joins.
SELECT c.name, c.city, round(sum(i.quantity * i.unit_price), 2) AS revenue
FROM customers c
JOIN orders o ON o.customer_id = c.id
JOIN order_items i ON i.order_id = o.id
WHERE o.status = 'delivered'
GROUP BY c.id, c.name, c.city
ORDER BY revenue DESC
LIMIT 10;`,
  },
  {
    title: 'Revenue by category and year',
    sql: `SELECT p.category,
       substr(o.ordered_on, 1, 4) AS year,
       count(DISTINCT o.id) AS orders,
       round(sum(i.quantity * i.unit_price), 2) AS revenue
FROM order_items i
JOIN orders o ON o.id = i.order_id
JOIN products p ON p.id = i.product_id
WHERE o.status <> 'cancelled'
GROUP BY p.category, year
ORDER BY p.category, year;`,
  },
  {
    title: 'Index lookup',
    sql: `-- orders_customer is a secondary B+tree index: the plan uses an IndexScan.
SELECT id, ordered_on, status
FROM orders
WHERE customer_id = 42
ORDER BY ordered_on;`,
  },
  {
    title: 'LEFT JOIN: customers without orders',
    sql: `SELECT c.city, count(*) AS customers_without_orders
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.id IS NULL
GROUP BY c.city
ORDER BY customers_without_orders DESC;`,
  },
  {
    title: 'NOT IN subquery',
    sql: `-- Products nobody ordered in December 2025.
SELECT name, category, price
FROM products
WHERE id NOT IN (
  SELECT product_id
  FROM order_items i JOIN orders o ON o.id = i.order_id
  WHERE o.ordered_on >= '2025-12-01'
)
ORDER BY price DESC;`,
  },
  {
    title: 'HAVING with a scalar subquery',
    sql: `-- Orders worth more than ten average order lines.
SELECT o.id, o.ordered_on, round(sum(i.quantity * i.unit_price), 2) AS total
FROM orders o
JOIN order_items i ON i.order_id = o.id
GROUP BY o.id, o.ordered_on
HAVING sum(i.quantity * i.unit_price) > 10 * (SELECT avg(quantity * unit_price) FROM order_items)
ORDER BY total DESC;`,
  },
  {
    title: 'Transaction with rollback',
    sql: `BEGIN;
UPDATE products SET price = round(price * 1.1, 2) WHERE category = 'Coffee';
SELECT round(avg(price), 2) AS coffee_avg_inside FROM products WHERE category = 'Coffee';
ROLLBACK;
SELECT round(avg(price), 2) AS coffee_avg_after FROM products WHERE category = 'Coffee';`,
  },
  {
    title: 'CASE buckets',
    sql: `SELECT CASE
         WHEN price < 10 THEN 'under 10'
         WHEN price < 50 THEN '10 to 50'
         ELSE '50 and over'
       END AS band,
       count(*) AS products
FROM products
GROUP BY band
ORDER BY min(price);`,
  },
  {
    title: 'Error messages',
    sql: `-- Errors point at the failing token.
SELECT name, cty
FROM customers
WHERE vip;`,
  },
];
