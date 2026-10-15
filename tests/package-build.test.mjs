// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  copyPackageAssets,
  writePackageMetadata,
  packageEntrypoints,
} from '../scripts/package-build.mjs';

test('Distribution metadata uses root-relative exports and bins without rewriting workspace metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'part-distribution-'));
  const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  try {
    mkdirSync(join(directory, 'src/bin'), { recursive: true });
    const manifest = JSON.stringify({
      name: 'test-distribution',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './dist/index.js', './*': './dist/*' },
      files: ['dist'],
      scripts: { build: 'workspace-only' },
      devDependencies: { unused: '1.0.0' },
      dependencies: {},
      bin: { example: './dist/bin/cli.js' },
    });
    writeFileSync(join(directory, 'package.json'), manifest);
    writeFileSync(join(directory, 'README.md'), '# Distribution fixture\n');
    writeFileSync(join(directory, 'src/index.ts'), 'export { answer } from "./feature.js";');
    writeFileSync(join(directory, 'src/feature.ts'), 'export const answer = 42;');
    writeFileSync(join(directory, 'src/implementation.ts'), 'export const alsoAccessible = true;');
    writeFileSync(join(directory, 'src/types.d.ts'), 'export interface Item { value: number }');
    writeFileSync(join(directory, 'src/styles.css'), 'body { color: red; }');
    writeFileSync(join(directory, 'src/native.cs'), '// Required runtime helper');
    writeFileSync(join(directory, 'src/bin/cli.js'), "console.log('example');");
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          target: 'ES2022',
          declaration: true,
          outDir: 'dist',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
    );
    const compiled = spawnSync(process.execPath, [compiler, '-p', directory], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (compiled.error) throw compiled.error;
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    copyPackageAssets(directory);
    writePackageMetadata(directory);
    const output = join(directory, 'dist');
    const published = JSON.parse(readFileSync(join(output, 'package.json'), 'utf8'));
    assert.deepEqual(published.exports, {
      '.': { types: './index.d.ts', default: './index.js' },
      './*': './*',
    });
    assert.deepEqual(published.bin, { example: './bin/cli.js' });
    assert.deepEqual(published.dependencies, {});
    for (const key of ['files', 'scripts', 'devDependencies'])
      assert.equal(key in published, false);
    assert.equal(readFileSync(join(directory, 'package.json'), 'utf8'), manifest);
    const require = createRequire(join(output, 'consumer.cjs'));
    assert.equal(
      (await import(pathToFileURL(require.resolve('test-distribution')).href)).answer,
      42,
    );
    assert.equal(
      (await import(pathToFileURL(require.resolve('test-distribution/feature.js')).href)).answer,
      42,
    );
    assert.equal(
      (await import(pathToFileURL(require.resolve('test-distribution/implementation.js')).href))
        .alsoAccessible,
      true,
    );
    assert.match(
      readFileSync(require.resolve('test-distribution/styles.css'), 'utf8'),
      /color: red/,
    );
    assert.match(
      readFileSync(require.resolve('test-distribution/native.cs'), 'utf8'),
      /runtime helper/,
    );
    assert.match(readFileSync(join(output, 'README.md'), 'utf8'), /Distribution fixture/);
    assert.ok(
      packageEntrypoints(output).some(
        ({ name, entry }) =>
          name === './types.js' && entry.types === './types.d.ts' && !entry.default,
      ),
    );
    writeFileSync(
      join(output, 'consumer.ts'),
      'import type { Item } from "test-distribution/types.js"; import { answer } from "test-distribution"; export const item: Item = {value:answer};',
    );
    writeFileSync(
      join(output, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { module: 'NodeNext', noEmit: true, strict: true, types: [] },
        files: ['consumer.ts'],
      }),
    );
    const types = spawnSync(process.execPath, [compiler, '-p', output], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (types.error) throw types.error;
    assert.equal(types.status, 0, types.stdout + types.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Wildcard exports need no regeneration for new modules and packages without an index have no root export', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'part-wildcard-'));
  try {
    mkdirSync(join(directory, 'dist'), { recursive: true });
    const workspace = '{"name":"test-wildcard","type":"module","exports":{"./*":"./dist/*"}}\n';
    writeFileSync(join(directory, 'package.json'), workspace);
    writePackageMetadata(directory);
    const metadata = readFileSync(join(directory, 'dist/package.json'), 'utf8');
    assert.deepEqual(JSON.parse(metadata).exports, { './*': './*' });
    writeFileSync(join(directory, 'dist/added.js'), 'export const added = true;');
    const require = createRequire(join(directory, 'dist/consumer.cjs'));
    assert.equal(
      (await import(pathToFileURL(require.resolve('test-wildcard/added.js')).href)).added,
      true,
    );
    assert.equal(readFileSync(join(directory, 'dist/package.json'), 'utf8'), metadata);
    assert.equal(readFileSync(join(directory, 'package.json'), 'utf8'), workspace);
    assert.throws(() => require.resolve('test-wildcard'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
