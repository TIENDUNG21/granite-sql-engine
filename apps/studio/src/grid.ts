import { formatValue, type QueryResult } from '@granite/core';

/** Rows rendered into the DOM; the rest are counted but not drawn. */
export const MAX_GRID_ROWS = 1000;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A result table. Values go through textContent, never innerHTML. */
export function renderGrid(result: QueryResult): HTMLElement {
  const wrap = el('div', 'grid-wrap');
  const table = el('table', 'grid');
  const head = el('thead');
  const headRow = el('tr');
  headRow.append(el('th', 'rownum', '#'));
  for (const column of result.columns) {
    const th = el('th', undefined, column.name);
    th.append(el('span', 'type', column.type.toLowerCase()));
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);

  const body = el('tbody');
  const numeric = result.columns.map((c) => c.type === 'INTEGER' || c.type === 'REAL');
  result.rows.slice(0, MAX_GRID_ROWS).forEach((row, r) => {
    const tr = el('tr');
    tr.append(el('td', 'rownum', String(r + 1)));
    row.forEach((value, i) => {
      const cls = value === null ? 'null' : numeric[i] ? 'num' : undefined;
      tr.append(el('td', cls, formatValue(value, result.columns[i]!.type)));
    });
    body.append(tr);
  });
  table.append(body);
  wrap.append(table);
  if (result.rows.length > MAX_GRID_ROWS) {
    wrap.append(
      el(
        'p',
        'grid-note',
        `Showing the first ${MAX_GRID_ROWS.toLocaleString('en-US')} of ${result.rows.length.toLocaleString('en-US')} rows.`,
      ),
    );
  }
  return wrap;
}
