import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { Database, VERSION, formatError, type FileSystem } from '@granite/core';
import { NodeFileSystem } from '@granite/core/node';
import { OUTPUT_MODES, type OutputMode } from './format.ts';
import { Shell, runRepl } from './repl.ts';

export interface CliOptions {
  /** Database file; undefined means a temporary in-memory database. */
  path: string | undefined;
  /** SQL given with -c, run in order before exiting. */
  commands: string[];
  sample: boolean;
  mode: OutputMode;
  help: boolean;
  version: boolean;
}

export const USAGE = `Usage: granite [options] [FILE]

Opens FILE (created if missing) or an in-memory database, and reads SQL from
the terminal or from standard input.

Options:
  -c, --command SQL   Run SQL and exit (may be repeated); exit status 1 on error
  -m, --mode MODE     Output mode: ${OUTPUT_MODES.join(', ')} (default table)
      --sample        Load the sample shop database first
  -h, --help          Show this help
  -v, --version       Show the version
`;

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    path: undefined,
    commands: [],
    sample: false,
    mode: 'table',
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`option ${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case '-c':
      case '--command':
        options.commands.push(value());
        break;
      case '-m':
      case '--mode': {
        const mode = value();
        if (!(OUTPUT_MODES as readonly string[]).includes(mode)) {
          throw new UsageError(
            `unknown mode "${mode}"; expected one of ${OUTPUT_MODES.join(', ')}`,
          );
        }
        options.mode = mode as OutputMode;
        break;
      }
      case '--sample':
        options.sample = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      default:
        if (arg.startsWith('-') && arg !== '-') throw new UsageError(`unknown option ${arg}`);
        if (options.path !== undefined) throw new UsageError('only one database file may be given');
        options.path = arg;
    }
  }
  return options;
}

export interface CliIO {
  stdin: Readable & { isTTY?: boolean };
  write(text: string): void;
  writeError(text: string): void;
  /** File system for FILE; defaults to the real one. */
  fs?: FileSystem;
}

/** Run the shell; resolves with the process exit status. */
export async function main(argv: readonly string[], io: CliIO): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.writeError(`granite: ${err.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    io.write(USAGE);
    return 0;
  }
  if (options.version) {
    io.write(`granite ${VERSION}\n`);
    return 0;
  }

  let db: Database;
  try {
    db = options.path
      ? Database.open({ fs: io.fs ?? new NodeFileSystem(), path: options.path })
      : Database.open();
  } catch (err) {
    io.writeError(formatError(err) + '\n');
    return 1;
  }
  try {
    const interactive = options.commands.length === 0 && io.stdin.isTTY === true;
    const shellIO = {
      lines: [] as string[],
      write: io.write,
      readFile: (path: string) => readFileSync(path, 'utf8'),
    };
    if (options.sample) {
      const shell = new Shell(db, shellIO);
      shell.line('.sample');
      if (shell.errors) return 1;
    }
    if (options.commands.length) {
      const shell = new Shell(db, shellIO);
      shell.mode = options.mode;
      for (const sql of options.commands) {
        const ok = sql.trimStart().startsWith('.')
          ? (shell.line(sql), shell.errors === 0)
          : shell.run(sql);
        if (!ok) return 1;
      }
      return 0;
    }
    if (interactive) {
      const where = options.path ? `database ${options.path}` : 'in-memory database';
      io.write(`granite ${VERSION}, ${where}. Enter .help for commands.\n`);
    }
    const rl = createInterface({
      input: io.stdin,
      terminal: interactive,
      output: interactive ? process.stdout : undefined,
    });
    const errors = await runRepl(
      db,
      {
        ...shellIO,
        lines: rl,
        prompt: interactive
          ? (text) => {
              rl.setPrompt(text);
              rl.prompt();
            }
          : undefined,
      },
      { mode: options.mode },
    );
    rl.close();
    return interactive || errors === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}
