// @ts-check
import { copyPackageAssets, writePackageMetadata } from './package-build.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const selected = process.argv[2];
const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
if (selected && !packages.includes(selected)) throw Error(`Unknown workspace package: ${selected}`);
const byDirectory = new Map(packages.map((name) => [resolve(root, 'packages', name), name]));
const included = new Set();
function include(name) {
  if (included.has(name)) return;
  included.add(name);
  const directory = join(root, 'packages', name);
  const config = JSON.parse(readFileSync(join(directory, 'tsconfig.json'), 'utf8'));
  for (const reference of config.references ?? []) {
    const dependency = byDirectory.get(resolve(directory, reference.path));
    if (dependency) include(dependency);
  }
}
for (const name of selected ? [selected] : packages) include(name);
for (const name of included) {
  rmSync(join(root, 'packages', name, 'dist'), { recursive: true, force: true });
  rmSync(join(root, 'packages', name, 'tsconfig.tsbuildinfo'), { force: true });
}
const compiler = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules/typescript/bin/tsc'),
    '--build',
    selected ? join(root, 'packages', selected, 'tsconfig.json') : join(root, 'tsconfig.json'),
  ],
  { stdio: 'inherit', cwd: root },
);
if (compiler.error) throw compiler.error;
if (compiler.status !== 0) process.exit(compiler.status ?? 1);
for (const name of included) {
  const directory = join(root, 'packages', name);
  copyPackageAssets(directory);
  writePackageMetadata(directory);
}
