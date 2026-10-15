// @ts-check
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { readPackageMetadata } from './package-metadata.mjs';

/** @param {string} directory @returns {string[]} */
export function packageFiles(directory) {
  /** @param {string} current @returns {string[]} */
  function visit(current) {
    return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const path = join(current, entry.name);
      return entry.isDirectory() ? visit(path) : entry.isFile() ? [path] : [];
    });
  }
  return visit(directory)
    .map((file) => relative(directory, file).replaceAll('\\', '/'))
    .sort();
}

/** Copy non-TypeScript runtime assets and the README alongside compiled modules.
 * @param {string} directory Workspace package root.
 */
export function copyPackageAssets(directory) {
  const source = join(directory, 'src');
  for (const file of packageFiles(source)) {
    if (/\.(?:[cm]?ts|tsx)$/.test(file) && !file.endsWith('.d.ts')) continue;
    const target = join(directory, 'dist', file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(source, file), target);
  }
  if (existsSync(join(directory, 'README.md')))
    cpSync(join(directory, 'README.md'), join(directory, 'dist/README.md'));
}

/** Write publishing metadata only inside dist. Workspace routing stays static.
 * @param {string} directory Workspace package root.
 */
export function writePackageMetadata(directory) {
  const { scripts, devDependencies, workspaces, exports, files, bin, ...metadata } =
    readPackageMetadata(join(directory, 'package.json'));
  const output = join(directory, 'dist');
  const root = existsSync(join(output, 'index.js'))
    ? { '.': { types: './index.d.ts', default: './index.js' } }
    : {};
  /** @param {string} path */
  const rewriteBin = (path) => {
    if (!path.startsWith('./dist/')) throw Error(`Package executable must live in dist: ${path}`);
    return './' + path.slice('./dist/'.length);
  };
  const executables =
    typeof bin === 'string'
      ? rewriteBin(bin)
      : bin &&
        Object.fromEntries(Object.entries(bin).map(([name, path]) => [name, rewriteBin(path)]));
  writeFileSync(
    join(output, 'package.json'),
    JSON.stringify(
      {
        ...metadata,
        exports: { ...root, './*': './*' },
        ...(executables ? { bin: executables } : {}),
      },
      null,
      2,
    ) + '\n',
  );
}

/** Inventory physical build files for packed-consumer checks, not an export allowlist.
 * @param {string} directory Dist package root.
 * @returns {{name: string, entry: {types?: string, default?: string}}[]}
 */
export function packageEntrypoints(directory) {
  const files = packageFiles(directory);
  /** @type {{name: string, entry: {types?: string, default?: string}}[]} */
  const entries = [];
  for (const file of files) {
    if (file.endsWith('.d.ts')) {
      const code = file.replace(/\.d\.ts$/, '.js');
      entries.push({
        name: './' + code,
        entry: { types: './' + file, ...(files.includes(code) ? { default: './' + code } : {}) },
      });
    } else if (
      file.endsWith('.css') ||
      (file.endsWith('.js') && !files.includes(file.replace(/\.js$/, '.d.ts')))
    ) {
      entries.push({ name: './' + file, entry: { default: './' + file } });
    }
  }
  return entries;
}
