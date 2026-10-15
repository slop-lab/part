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
  publicEntrypoints,
  exportMap,
  writeExports,
  copyPublicAssets,
} from '../scripts/package-exports.mjs';

test('Generated exports support public code, erased types and CSS without exposing implementation files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'part-exports-'));
  const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  try {
    mkdirSync(join(directory, 'src/features'), { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'test-generated-exports', type: 'module' }),
    );
    writeFileSync(
      join(directory, 'src/index.ts'),
      '/** @public */\nexport { answer } from "./features/index.js";',
    );
    writeFileSync(
      join(directory, 'src/features/index.ts'),
      '/** @public */\nimport { value } from "./private.js"; export const answer = value;',
    );
    writeFileSync(
      join(directory, 'src/features/private.ts'),
      '/** Mentioning @public in prose does not publish this helper. */\nexport const value = 42;',
    );
    writeFileSync(
      join(directory, 'src/features/types.ts'),
      '/** @public */\nexport interface Item { value: number }',
    );
    writeFileSync(
      join(directory, 'src/features/contracts.ts'),
      '/** @public */\nexport type { Item } from "./types.js";',
    );
    writeFileSync(
      join(directory, 'src/features/styles.css'),
      '/* @public */\nbody { color: red; }',
    );
    writeFileSync(join(directory, 'src/features/internal.css'), 'body { color: blue; }');
    const entries = publicEntrypoints(directory);
    assert.deepEqual(exportMap(entries), {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './features': { types: './dist/features/index.d.ts', default: './dist/features/index.js' },
      './features/contracts': { types: './dist/features/contracts.d.ts' },
      './features/styles.css': { default: './dist/features/styles.css' },
      './features/types': { types: './dist/features/types.d.ts' },
    });
    writeExports(directory, entries);
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          target: 'ES2022',
          declaration: true,
          outDir: 'dist',
          types: [],
          strict: true,
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
    copyPublicAssets(directory, entries);
    const require = createRequire(join(directory, 'consumer.cjs'));
    const feature = await import(
      pathToFileURL(require.resolve('test-generated-exports/features')).href
    );
    assert.equal(feature.answer, 42);
    assert.equal(
      (await import(pathToFileURL(require.resolve('test-generated-exports')).href)).answer,
      42,
    );
    assert.match(
      readFileSync(require.resolve('test-generated-exports/features/styles.css'), 'utf8'),
      /color: red/,
    );
    for (const subpath of [
      'features/private',
      'features/index',
      'features/internal.css',
      'features/types',
      'features/contracts',
    ])
      assert.throws(() => require.resolve(`test-generated-exports/${subpath}`), {
        code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Export generation follows source additions/removals, preserves package metadata and rejects ambiguous public paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'part-exports-edit-'));
  try {
    mkdirSync(join(directory, 'src/new'), { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        exports: { './stale': './missing.js' },
        dependencies: { dependency: '1.0.0' },
      }),
    );
    writeFileSync(join(directory, 'src/new.ts'), '/** @public */\nexport const added = true;');
    writeExports(directory, publicEntrypoints(directory));
    const manifestPath = join(directory, 'package.json');
    const first = readFileSync(manifestPath, 'utf8');
    assert.deepEqual(JSON.parse(first), {
      name: 'fixture',
      exports: { './new': { types: './dist/new.d.ts', default: './dist/new.js' } },
      dependencies: { dependency: '1.0.0' },
    });
    writeExports(directory, publicEntrypoints(directory));
    assert.equal(readFileSync(manifestPath, 'utf8'), first);
    writeFileSync(
      join(directory, 'src/new/index.ts'),
      '/** @public */\nexport const duplicate = true;',
    );
    assert.throws(() => publicEntrypoints(directory), /Duplicate public entrypoint \.\/new/);
    rmSync(join(directory, 'src/new.ts'));
    writeExports(directory, publicEntrypoints(directory));
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).exports, {
      './new': { types: './dist/new/index.d.ts', default: './dist/new/index.js' },
    });
    writeFileSync(join(directory, 'src/new/index.ts'), 'export const nowPrivate = true;');
    writeExports(directory, publicEntrypoints(directory));
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).exports, {});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
