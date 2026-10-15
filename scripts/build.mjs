// @ts-check
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const selected = process.argv[2];
const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
if (selected && !packages.includes(selected)) throw Error(`Unknown workspace package: ${selected}`);
for (const name of selected ? [selected] : packages) {
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
if (!selected || selected === 'browser')
  cpSync(
    join(root, 'packages/browser/src/styles.css'),
    join(root, 'packages/browser/dist/styles.css'),
  );

if (!selected || selected === 'node')
  cpSync(
    join(root, 'packages/node/src/scripts/windows-runner.cs'),
    join(root, 'packages/node/dist/scripts/windows-runner.cs'),
  );
