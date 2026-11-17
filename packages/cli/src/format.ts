import { formatValue, type QueryResult } from '@granite/core';

export type OutputMode = 'table' | 'csv' | 'json' | 'line';
export const OUTPUT_MODES: readonly OutputMode[] = ['table', 'csv', 'json', 'line'];

const COMBINING = /\p{M}/u;
// Wide East Asian ranges: Hangul Jamo, CJK, Hangul syllables, compatibility forms, full-width forms.
const WIDE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

/** Terminal columns a string occupies: combining marks take none, wide characters two. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (COMBINING.test(ch)) continue;
    width += WIDE.test(ch) || ch.codePointAt(0)! >= 0x1f300 ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number, right: boolean): string {
  const fill = ' '.repeat(Math.max(0, width - displayWidth(text)));
  return right ? fill + text : text + fill;
}

/** Control characters would break the grid; show them escaped. */
function cell(text: string): string {
  return text.replace(/[\n\r\t]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\t'));
}

/** Render a query result the way the shell prints it. */
export function renderResult(result: QueryResult, mode: OutputMode): string {
  if (result.command === 'EXPLAIN') return result.rows.map((r) => String(r[0])).join('\n') + '\n';
  if (result.columns.length === 0) {
    const tag = ['INSERT', 'UPDATE', 'DELETE', 'VACUUM', 'ANALYZE'].includes(result.command)
      ? `${result.command} ${result.rowsAffected}`
      : result.command;
    return (result.notice ? `NOTICE: ${result.notice}\n` : '') + tag + '\n';
  }
  switch (mode) {
    case 'csv':
      return renderCsv(result);
    case 'json':
      return renderJson(result);
    case 'line':
      return renderLines(result);
    default:
      return renderTable(result);
  }
}

function renderTable(result: QueryResult): string {
  const names = result.columns.map((c) => c.name);
  const numeric = result.columns.map((c) => c.type === 'INTEGER' || c.type === 'REAL');
  const cells = result.rows.map((row) =>
    row.map((v, i) => cell(formatValue(v, result.columns[i]!.type))),
  );
  const widths = names.map((name, i) =>
    Math.max(displayWidth(name), ...cells.map((row) => displayWidth(row[i]!))),
  );
  const line = (values: string[], header: boolean): string =>
    ' ' + values.map((v, i) => pad(v, widths[i]!, !header && numeric[i]!)).join(' | ') + ' ';
  const out = [
    line(names, true).trimEnd(),
    widths.map((w) => '-'.repeat(w + 2)).join('+'),
    ...cells.map((row) => line(row, false).trimEnd()),
  ];
  const n = result.rows.length;
  out.push(`(${n} ${n === 1 ? 'row' : 'rows'})`);
  return out.join('\n') + '\n';
}

function csvField(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function renderCsv(result: QueryResult): string {
  const lines = [result.columns.map((c) => csvField(c.name)).join(',')];
  for (const row of result.rows) {
    lines.push(
      row
        .map((v, i) => (v === null ? '' : csvField(formatValue(v, result.columns[i]!.type))))
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

function renderJson(result: QueryResult): string {
  const objects = result.rows.map((row) =>
    Object.fromEntries(result.columns.map((c, i) => [c.name, row[i]])),
  );
  return JSON.stringify(objects, null, 2) + '\n';
}

function renderLines(result: QueryResult): string {
  const width = Math.max(...result.columns.map((c) => displayWidth(c.name)));
  const blocks = result.rows.map((row) =>
    result.columns
      .map((c, i) => `${pad(c.name, width, true)} = ${cell(formatValue(row[i]!, c.type))}`)
      .join('\n'),
  );
  return blocks.join('\n\n') + '\n';
}
