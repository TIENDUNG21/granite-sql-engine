import {
  Database,
  VERSION,
  formatError,
  parse,
  sampleDatasetSql,
  type QueryResult,
  type Session,
} from '@granite/core';
import { EXAMPLES } from './examples.ts';
import { renderGrid } from './grid.ts';
import { highlightSql } from './highlight.ts';
import { planToSvg } from './plan-svg.ts';
import './style.css';

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const editor = byId<HTMLTextAreaElement>('sql');
const highlight = byId<HTMLPreElement>('highlight');
const output = byId<HTMLDivElement>('output');
const status = byId<HTMLSpanElement>('status');
const txnBadge = byId<HTMLSpanElement>('txn');
const schema = byId<HTMLDivElement>('schema');

let db: Database;
let session: Session;

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

function ms(value: number): string {
  return value < 10 ? `${value.toFixed(2)} ms` : `${Math.round(value)} ms`;
}

// ------------------------------------------------------------- database

function openDatabase(): void {
  const started = performance.now();
  db = Database.open();
  session = db.session();
  for (const sql of sampleDatasetSql()) session.execute(sql);
  status.textContent = `Sample shop loaded in ${ms(performance.now() - started)}.`;
  renderSchema();
}

function renderSchema(): void {
  schema.replaceChildren();
  const tables = db.tables().sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const table of tables) {
    const box = el('div', 'table');
    const name = el('button', 'table-name', table.name);
    name.type = 'button';
    name.title = `SELECT * FROM ${table.name} LIMIT 100`;
    name.addEventListener('click', () => {
      setSql(`SELECT * FROM ${table.name} LIMIT 100;`);
      run(editor.value);
    });
    const list = el('ul');
    const primary = table.indexes.find((ix) => ix.primary);
    table.columns.forEach((column, i) => {
      const item = el('li', undefined, column.name + ' ');
      item.append(el('span', 'type', column.type.toLowerCase()));
      if (primary?.columns.includes(i)) item.append(' ', el('span', 'key', 'key'));
      list.append(item);
    });
    for (const index of table.indexes) {
      if (index.primary) continue;
      const cols = index.columns.map((c) => table.columns[c]!.name).join(', ');
      list.append(
        el('li', 'index', `${index.unique ? 'unique ' : ''}index ${index.name} (${cols})`),
      );
    }
    box.append(name, list);
    schema.append(box);
  }
  if (!tables.length) schema.append(el('p', 'index', 'No tables.'));
}

// ------------------------------------------------------------- results

function cardHead(tag: string, detail: string, sql: string): HTMLElement {
  const head = el('div', 'card-head');
  head.append(el('span', 'tag', tag), el('span', 'meta', detail));
  const firstLine = sql
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('--'));
  if (firstLine) head.append(el('span', 'sql', firstLine));
  return head;
}

function resultCard(result: QueryResult, sql: string, elapsed: number): HTMLElement {
  const card = el('section', 'card');
  if (result.command === 'EXPLAIN' && result.plan) {
    card.append(cardHead('EXPLAIN', ms(elapsed), sql));
    const wrap = el('div', 'plan-wrap');
    // planToSvg escapes every piece of text it places in the markup.
    wrap.innerHTML = planToSvg(result.plan);
    const text = el('details', 'plan-text');
    text.append(el('summary', undefined, 'Text form'));
    text.append(el('pre', undefined, result.rows.map((r) => String(r[0])).join('\n')));
    card.append(wrap, text);
    return card;
  }
  if (result.columns.length) {
    const n = result.rows.length;
    card.append(
      cardHead(
        result.command,
        `${n.toLocaleString('en-US')} ${n === 1 ? 'row' : 'rows'} · ${ms(elapsed)}`,
        sql,
      ),
    );
    card.append(renderGrid(result));
    return card;
  }
  const counted = ['INSERT', 'UPDATE', 'DELETE', 'VACUUM'].includes(result.command);
  const detail = counted
    ? `${result.rowsAffected.toLocaleString('en-US')} affected · ${ms(elapsed)}`
    : ms(elapsed);
  card.append(cardHead(result.command, detail, sql));
  if (result.notice) card.append(el('p', 'message', `NOTICE: ${result.notice}`));
  return card;
}

function errorCard(err: unknown, source: string): HTMLElement {
  const card = el('section', 'card error');
  card.append(el('pre', undefined, formatError(err, source)));
  return card;
}

function refreshState(): void {
  txnBadge.hidden = !session.inTransaction;
  renderSchema();
}

/**
 * Run each statement on its own so every one gets a result card and an error
 * stops the batch with the earlier results still shown. Text before a
 * statement is blanked to spaces, so error positions match the editor.
 */
function run(sql: string): void {
  output.replaceChildren();
  let statements;
  try {
    statements = parse(sql);
  } catch (err) {
    output.append(errorCard(err, sql));
    status.textContent = 'Syntax error.';
    return;
  }
  const started = performance.now();
  let done = 0;
  for (const stmt of statements) {
    const text = sql.slice(stmt.span.start, stmt.span.end);
    const padded = sql.slice(0, stmt.span.start).replace(/[^\n]/g, ' ') + text;
    const t0 = performance.now();
    try {
      const results = session.execute(padded);
      output.append(resultCard(results.at(-1)!, text, performance.now() - t0));
      done++;
    } catch (err) {
      output.append(errorCard(err, padded));
      break;
    }
  }
  const total = ms(performance.now() - started);
  status.textContent =
    done === statements.length
      ? `${done} ${done === 1 ? 'statement' : 'statements'} in ${total}.`
      : `Stopped at statement ${done + 1} of ${statements.length}.`;
  refreshState();
}

/** Plan of the last statement in the selection (or the editor). */
function explain(analyze: boolean): void {
  const sql = selectedSql();
  let statements;
  try {
    statements = parse(sql);
  } catch (err) {
    output.replaceChildren(errorCard(err, sql));
    return;
  }
  const last = statements.at(-1);
  if (!last) return;
  const text = sql.slice(last.span.start, last.span.end);
  if (last.kind === 'explain') return run(text);
  // ANALYZE executes the statement; only do that for queries that change nothing.
  const measured = analyze && last.kind === 'select';
  run(`EXPLAIN ${measured ? 'ANALYZE ' : ''}${text}`);
  if (analyze && !measured) {
    status.textContent =
      'EXPLAIN ANALYZE would execute this statement; showing the estimated plan.';
  }
}

// ------------------------------------------------------------- editor

function syncHighlight(): void {
  // The trailing newline keeps the overlay as tall as the textarea's last line.
  highlight.innerHTML = highlightSql(editor.value) + '\n';
  highlight.scrollTop = editor.scrollTop;
  highlight.scrollLeft = editor.scrollLeft;
}

function setSql(sql: string): void {
  editor.value = sql;
  syncHighlight();
}

function selectedSql(): string {
  const { selectionStart: start, selectionEnd: end, value } = editor;
  return start !== end ? value.slice(start, end) : value;
}

editor.addEventListener('input', syncHighlight);
editor.addEventListener('scroll', () => {
  highlight.scrollTop = editor.scrollTop;
  highlight.scrollLeft = editor.scrollLeft;
});
editor.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (event.shiftKey) explain(true);
    else run(selectedSql());
    return;
  }
  if (event.key === 'Tab' && !event.shiftKey) {
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end } = editor;
    editor.setRangeText('  ', start, end, 'end');
    syncHighlight();
  }
});

byId('run').addEventListener('click', () => run(selectedSql()));
byId('explain').addEventListener('click', () => explain(false));
byId('analyze').addEventListener('click', () => explain(true));
byId('reset').addEventListener('click', () => {
  db.close();
  openDatabase();
  output.replaceChildren();
  txnBadge.hidden = true;
});

const exampleList = byId<HTMLUListElement>('examples');
for (const example of EXAMPLES) {
  const button = el('button', undefined, example.title);
  button.type = 'button';
  button.addEventListener('click', () => {
    setSql(example.sql);
    run(example.sql);
    editor.focus();
  });
  const item = el('li');
  item.append(button);
  exampleList.append(item);
}

byId('version').textContent = `Granite ${VERSION}`;
openDatabase();

// Links can carry a query: #sql=<url-encoded SQL>, optionally &plan=estimate|analyze.
const linked = new URLSearchParams(location.hash.slice(1));
setSql(linked.get('sql') ?? EXAMPLES[0]!.sql);
const plan = linked.get('plan');
if (plan === 'analyze' || plan === 'estimate') explain(plan === 'analyze');
else run(editor.value);
