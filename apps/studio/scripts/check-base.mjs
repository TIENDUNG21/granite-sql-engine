// Fails when the built page references a local file outside the Pages base path,
// or one that is missing from dist. GitHub Pages serves the site under
// /granite-sql-engine/, so an absolute "/assets/..." URL would 404 there.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = process.env.STUDIO_BASE ?? '/granite-sql-engine/';
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const html = readFileSync(`${dist}index.html`, 'utf8');
const urls = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
const problems = [];
for (const url of urls) {
  if (/^(?:[a-z]+:|#)/i.test(url)) continue;
  if (!url.startsWith(base)) {
    problems.push(`${url} is outside ${base}`);
  } else if (!existsSync(dist + url.slice(base.length))) {
    problems.push(`${url} is not in dist`);
  }
}
if (problems.length) {
  console.error(`index.html has bad references:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`index.html: ${urls.length} references, all local ones under ${base}`);
