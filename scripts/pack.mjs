// @ts-check
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { npmSync } from './npm.mjs';
const destination = resolve('artifacts');
mkdirSync(destination, { recursive: true });
const result = npmSync(
  [
    'pack',
    ...readdirSync('packages', { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `./packages/${entry.name}/dist`),
    '--json',
    '--pack-destination',
    destination,
    '--cache',
    join(tmpdir(), 'part-npm-cache'),
  ],
  { encoding: 'utf8' },
);
if (result.error) throw result.error;
if (result.status !== 0) throw Error(result.stderr);
/** @type {{name: string, version: string, filename: string, files: {path: string}[]}[]} */
const packed = JSON.parse(result.stdout);
for (const item of packed) {
  if (
    item.files.some(
      (file) =>
        file.path.endsWith('.tsbuildinfo') ||
        file.path.startsWith('src/') ||
        file.path.startsWith('dist/'),
    )
  )
    throw Error(`${item.name} includes source files or compiler cache metadata`);
  const path = join(destination, item.filename);
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(`${path}.sha256`, `${digest}  ${item.filename}\n`);
  console.log(`${item.name}@${item.version}: ${path}`);
}
