// @ts-check
import { packageEntrypoints } from './package-build.mjs';
import { npmSync } from './npm.mjs';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), 'part-consumers-'));
const packages = ['core', 'plugins', 'node', 'browser'].map((directory) => ({
  directory,
  tarball: '',
  manifest: JSON.parse(readFileSync(`packages/${directory}/dist/package.json`, 'utf8')),
}));
const consumers = {
  core: ['core'],
  'non-coding': ['core', 'plugins'],
  swe: ['core', 'plugins'],
  contracts: ['core', 'plugins', 'browser'],
  workflow: ['core', 'plugins'],
  node: ['core', 'node'],
  browser: ['core', 'browser'],
};
function run(command, args, cwd = root) {
  const result =
    command === 'npm'
      ? npmSync(args, {
          cwd,
          encoding: 'utf8',
          env: { ...process.env, npm_config_cache: join(temporary, 'cache') },
        })
      : spawnSync(command, args, {
          cwd,
          encoding: 'utf8',
          env: { ...process.env, npm_config_cache: join(temporary, 'cache') },
        });
  if (result.error || result.status !== 0)
    throw Error(
      `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}\n${result.error ?? ''}`,
    );
  return result.stdout;
}
const publicPath = (pkg, name) => pkg.manifest.name + (name === '.' ? '' : '/' + name.slice(2));
try {
  cpSync(join(root, 'fixtures'), join(temporary, 'fixtures'), { recursive: true });
  for (const pkg of packages) {
    const packed = JSON.parse(
      run('npm', [
        'pack',
        join(root, 'packages', pkg.directory, 'dist'),
        '--json',
        '--pack-destination',
        temporary,
      ]),
    );
    if (
      packed[0].files.some(
        ({ path }) =>
          path.startsWith('src/') || path.startsWith('dist/') || path.endsWith('.tsbuildinfo'),
      )
    )
      throw Error(`${pkg.manifest.name} was not packed from its clean distribution root`);
    pkg.tarball = join(temporary, packed[0].filename);
  }
  for (const [name, selected] of Object.entries(consumers)) {
    const directory = join(temporary, 'consumers', name);
    const installed = packages.filter((pkg) => selected.includes(pkg.directory));
    cpSync(join(root, 'consumers', name), directory, { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify(
        {
          name: `part-fixture-${name}`,
          private: true,
          type: 'module',
          dependencies: Object.fromEntries(
            installed.map((pkg) => [pkg.manifest.name, `file:${pkg.tarball}`]),
          ),
        },
        null,
        2,
      ),
    );
    run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], directory);
    const entries = installed.flatMap((pkg) =>
      packageEntrypoints(join(root, 'packages', pkg.directory, 'dist')).map(({ name, entry }) => ({
        pkg,
        name,
        entry,
      })),
    );
    if (['core', 'contracts', 'node', 'browser'].includes(name)) {
      writeFileSync(
        join(directory, 'entrypoints.ts'),
        `export type Entrypoints = [\n${entries
          .filter(({ entry }) => entry.types)
          .map(({ pkg, name }) => `  typeof import(${JSON.stringify(publicPath(pkg, name))})`)
          .join(',\n')}\n];\n`,
      );
      writeFileSync(
        join(directory, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            skipLibCheck: false,
            outDir: 'out',
            lib: ['ES2022', 'DOM', 'DOM.Iterable'],
            types: name === 'node' ? ['node'] : [],
            ...(name === 'node' ? { typeRoots: [join(root, 'node_modules/@types')] } : {}),
          },
          include: ['index.ts', 'entrypoints.ts'],
        }),
      );
      run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')], directory);
    }
    process.stdout.write(
      run(process.execPath, [name === 'contracts' ? 'out/index.js' : 'index.mjs'], directory),
    );
    const modules = entries
      .filter(
        ({ pkg, entry }) =>
          entry.default?.endsWith('.js') &&
          !Object.values(pkg.manifest.bin ?? {}).includes(entry.default),
      )
      .map(({ pkg, name }) => publicPath(pkg, name));
    run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `for (const path of ${JSON.stringify(modules)}) await import(path);`,
      ],
      directory,
    );
    for (const { pkg, entry } of entries)
      if (entry.default?.endsWith('.css'))
        readFileSync(join(directory, 'node_modules', pkg.manifest.name, entry.default));
    for (const pkg of installed)
      for (const [command, path] of Object.entries(pkg.manifest.bin ?? {}))
        if (
          !run(
            process.execPath,
            [join(directory, 'node_modules', pkg.manifest.name, path), '--help'],
            directory,
          ).includes(command)
        )
          throw Error(`Packaged executable ${command} failed`);
    if (name === 'browser') {
      const bundle = await build({
        stdin: {
          contents:
            "export { createChat } from '@slop-lab/part-browser/dom.js'; export { createController } from '@slop-lab/part/client/index.js';",
          resolveDir: directory,
        },
        bundle: true,
        platform: 'browser',
        write: false,
        metafile: true,
      });
      if (
        Object.keys(bundle.metafile.inputs).some((path) =>
          /@slop-lab\/part-(node|plugins)\//.test(path),
        )
      )
        throw Error('Browser consumer pulled in another runtime');
    }
    const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
    for (const pkg of packages) {
      const path = join(directory, 'node_modules', pkg.manifest.name);
      if (selected.includes(pkg.directory)) {
        if (lock.packages[`node_modules/${pkg.manifest.name}`]?.version !== pkg.manifest.version)
          throw Error('Unpinned consumer version');
      } else if (existsSync(path))
        throw Error(`${name} unexpectedly installed ${pkg.manifest.name}`);
    }
    console.log(`${name}: isolated packages and ${entries.length} public entrypoints verified`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
