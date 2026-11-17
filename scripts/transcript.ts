/**
 * Replays a shell session from a file and prints it as a terminal shows it:
 * prompts, the echoed input lines and the shell's output. Used to produce the
 * transcripts in the README from real runs:
 *
 *   node scripts/transcript.ts scripts/readme-session.txt
 */
import { readFileSync } from 'node:fs';
import { Database } from '@granite/core';
import { runRepl } from '../packages/cli/src/repl.ts';

const input = readFileSync(process.argv[2]!, 'utf8').trimEnd().split(/\r?\n/);
let out = '';
await runRepl(Database.open(), {
  lines: (function* () {
    for (const line of input) {
      out += line + '\n';
      yield line;
    }
  })(),
  write: (text) => (out += text),
  prompt: (text) => (out += text),
});
process.stdout.write(out.replace(/granite> $/, ''));
