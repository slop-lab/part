import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';

// Remove stale entrypoints so local checks use the same layout as a fresh package.
rmSync('dist', { recursive: true, force: true });
const compiler = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc'], {
  stdio: 'inherit',
});
if (compiler.error) throw compiler.error;
if (compiler.status !== 0) process.exit(compiler.status ?? 1);
cpSync('src/ui/styles.css', 'dist/ui.css');
