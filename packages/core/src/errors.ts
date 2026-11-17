/**
 * Errors are part of the user interface of a database. Every error the engine
 * raises on purpose is a GraniteError with a stable code, a one-line message and,
 * when it points at SQL text, a span that `formatError` turns into a caret excerpt.
 */

export type ErrorCode =
  | 'syntax_error'
  | 'type_mismatch'
  | 'undefined_table'
  | 'undefined_column'
  | 'undefined_function'
  | 'undefined_index'
  | 'duplicate_table'
  | 'duplicate_column'
  | 'duplicate_index'
  | 'ambiguous_column'
  | 'grouping_error'
  | 'not_null_violation'
  | 'unique_violation'
  | 'division_by_zero'
  | 'numeric_out_of_range'
  | 'invalid_text_representation'
  | 'cardinality_violation'
  | 'feature_not_supported'
  | 'invalid_transaction_state'
  | 'serialization_failure'
  | 'program_limit_exceeded'
  | 'invalid_parameter'
  | 'io_error'
  | 'corrupt_database'
  | 'internal_error';

/** Half-open range of UTF-16 offsets into the SQL source. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface GraniteErrorOptions {
  span?: Span | undefined;
  hint?: string | undefined;
  cause?: unknown;
}

export class GraniteError extends Error {
  readonly code: ErrorCode;
  readonly span: Span | undefined;
  readonly hint: string | undefined;
  /** 1-based line of `span.start`, filled in by `locate`. */
  line: number | undefined;
  /** 1-based column of `span.start` in code points, filled in by `locate`. */
  column: number | undefined;
  /** The SQL text the span refers to, kept so the error can be rendered later. */
  source: string | undefined;

  constructor(code: ErrorCode, message: string, options: GraniteErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GraniteError';
    this.code = code;
    this.span = options.span;
    this.hint = options.hint;
  }

  /** Attach the source text and compute line/column for the span (idempotent). */
  locate(source: string): this {
    if (this.source !== undefined) return this;
    this.source = source;
    if (this.span) {
      const pos = positionOf(source, this.span.start);
      this.line = pos.line;
      this.column = pos.column;
    }
    return this;
  }
}

export function isGraniteError(err: unknown): err is GraniteError {
  return err instanceof GraniteError;
}

/** Line and code-point column (both 1-based) of a UTF-16 offset. */
export function positionOf(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: codePointLength(source.slice(lineStart, end)) + 1 };
}

function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/**
 * Render an error for humans. GraniteErrors with a span get a caret excerpt:
 *
 *   error[syntax_error]: expected FROM, found "FORM"
 *    --> line 1, column 10
 *     |
 *   1 | SELECT * FORM t
 *     |          ^^^^
 *
 * Anything else is reported as an internal error without a stack trace.
 */
export function formatError(err: unknown, source?: string): string {
  if (!(err instanceof GraniteError)) {
    const message = err instanceof Error ? err.message : String(err);
    return `internal error: ${message}`;
  }
  const text = source ?? err.source;
  const lines = [`error[${err.code}]: ${err.message}`];
  if (err.span && text !== undefined) {
    lines.push(...excerpt(text, err.span));
  }
  if (err.hint) lines.push(`  = hint: ${err.hint}`);
  return lines.join('\n');
}

function excerpt(source: string, span: Span): string[] {
  const start = Math.max(0, Math.min(span.start, source.length));
  const { line, column } = positionOf(source, start);
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = source.indexOf('\n', start);
  if (lineEnd === -1) lineEnd = source.length;
  const lineText = source.slice(lineStart, lineEnd).replace(/\r$/, '');
  // Carets stop at the end of the first line of a multi-line span.
  const caretEnd = Math.max(start, Math.min(span.end, lineStart + lineText.length));
  const width = Math.max(1, codePointLength(source.slice(start, caretEnd)));
  // Keep tabs in the padding so the caret lines up in a terminal.
  let pad = '';
  for (const ch of source.slice(lineStart, start)) pad += ch === '\t' ? '\t' : ' ';
  const gutter = ' '.repeat(String(line).length);
  return [
    `${gutter}--> line ${line}, column ${column}`,
    `${gutter} |`,
    `${line} | ${lineText}`,
    `${gutter} | ${pad}${'^'.repeat(width)}`,
  ];
}
