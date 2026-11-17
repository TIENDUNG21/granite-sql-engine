.sample
SELECT c.city, count(DISTINCT o.customer_id) AS buyers,
       round(sum(i.quantity * i.unit_price), 2) AS revenue
FROM orders o
JOIN customers c ON c.id = o.customer_id
JOIN order_items i ON i.order_id = o.id
WHERE o.status = 'delivered'
GROUP BY c.city
ORDER BY revenue DESC
LIMIT 4;
EXPLAIN ANALYZE SELECT o.id, o.ordered_on
FROM orders o JOIN customers c ON c.id = o.customer_id
WHERE c.city = 'Huế' AND o.status = 'pending';
SELECT name, citty FROM customers WHERE vip;
