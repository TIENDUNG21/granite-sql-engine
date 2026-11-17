#!/usr/bin/env node
import { main } from './main.ts';

process.exitCode = await main(process.argv.slice(2), {
  stdin: process.stdin,
  write: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
});
