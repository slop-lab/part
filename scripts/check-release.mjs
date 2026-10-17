// @ts-check
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { npmSync } from './npm.mjs';
import { readPackageMetadata } from './package-metadata.mjs';

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return /** @type {Record<string, unknown>} */ (value);
}

const root = process.cwd();
const configuration = object(JSON.parse(readFileSync('package.json', 'utf8')));
assert.equal(configuration.private, true, 'The workspace root must stay private');
const minimum = object(configuration.engines).node;
assert.ok(typeof minimum === 'string' && /^>=\d+\.\d+\.\d+$/.test(minimum));
const required = minimum.slice(2).split('.').map(Number);
assert.equal(
  Number(readPackageMetadata('node_modules/@types/node-lts/package.json').version.split('.')[0]),
  required[0],
  'Consumer declarations must match the minimum Node major',
);
const running = process.versions.node.split('.').map(Number);
const delta = required
  .map((part, index) => (running[index] ?? 0) - part)
  .find((part) => part !== 0);
assert.ok(delta === undefined || delta > 0, `Release checks require Node ${minimum}`);

const directories = ['core', 'plugins', 'node', 'browser'];
const version = readPackageMetadata('packages/core/package.json').version;
assert.match(version, /^\d+\.\d+\.\d+$/, 'Release version must not contain a prerelease tag');
const license = readFileSync('LICENSE', 'utf8');
for (const directory of directories) {
  const source = readPackageMetadata(`packages/${directory}/package.json`);
  const output = join(root, 'packages', directory, 'dist');
  const distribution = readPackageMetadata(join(output, 'package.json'));
  for (const manifest of [source, distribution]) {
    assert.equal(manifest.name, `@slop-lab/part${directory === 'core' ? '' : '-' + directory}`);
    assert.equal(manifest.version, version, `${manifest.name}: mismatched version`);
    assert.notEqual(manifest.private, true, `${manifest.name}: publication is disabled`);
    assert.equal(manifest.license, 'MIT');
    assert.equal(object(manifest.engines).node, minimum);
    assert.equal(object(manifest.publishConfig).access, 'public');
    assert.equal(object(manifest.publishConfig).registry, 'https://registry.npmjs.org/');
    assert.equal(object(manifest.repository).directory, `packages/${directory}`);
    if (directory !== 'core') assert.equal(manifest.dependencies?.['@slop-lab/part'], version);
  }
  assert.equal(readFileSync(join(output, 'LICENSE'), 'utf8'), license);
  assert.equal(distribution.exports?.['./*'], './*');
  assert.equal((await import(pathToFileURL(join(output, 'version.js')).href)).version, version);
}

const packed = npmSync(
  [
    'pack',
    ...directories.map((name) => `./packages/${name}/dist`),
    '--dry-run',
    '--json',
    '--cache',
    join(tmpdir(), 'part-npm-cache'),
  ],
  { encoding: 'utf8' },
);
if (packed.error) throw packed.error;
assert.equal(packed.status, 0, packed.stderr);
/** @type {{name: string, version: string, filename: string, integrity: string, files: {path: string}[]}[]} */
const packages = JSON.parse(packed.stdout);
assert.equal(packages.length, directories.length);
for (const item of packages) {
  assert.equal(item.version, version);
  const files = item.files.map(({ path }) => path);
  for (const required of ['package.json', 'LICENSE', 'README.md', 'version.js', 'version.d.ts'])
    assert.ok(files.includes(required), `${item.name}: missing ${required}`);
  assert.ok(
    !files.some(
      (path) =>
        /^(src|dist|tests|fixtures|node_modules)\//.test(path) ||
        /(^|\/)\.env(?:\.|$)|\.tsbuildinfo$/.test(path),
    ),
    `${item.name}: unexpected package contents`,
  );
  const artifact = readFileSync(join('artifacts', item.filename));
  assert.equal(
    'sha512-' + createHash('sha512').update(artifact).digest('base64'),
    item.integrity,
    `${item.name}: tarball differs from the current distribution`,
  );
  assert.equal(
    readFileSync(join('artifacts', item.filename + '.sha256'), 'utf8'),
    `${createHash('sha256').update(artifact).digest('hex')}  ${item.filename}\n`,
  );
}
console.log(
  `Release ${version}: ${packages.length} public MIT packages, generated versions and tarball checksums verified`,
);
