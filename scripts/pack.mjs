import { createHash } from 'node:crypto';
import { npmSync } from './npm.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const destination = resolve('artifacts');
mkdirSync(destination, { recursive: true });
const result = spawnSync(
  'npm',
  [
    'pack',
    '--workspaces',
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
for (const item of JSON.parse(result.stdout)) {
  if (item.files.some((file) => file.path.endsWith('.tsbuildinfo') || file.path.startsWith('src/')))
    throw Error(`${item.name} includes source files or compiler cache metadata`);
  const path = join(destination, item.filename);
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(`${path}.sha256`, `${digest}  ${item.filename}\n`);
  console.log(`${item.name}@${item.version}: ${path}`);
}
