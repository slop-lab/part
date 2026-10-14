import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd(),
  temporary = mkdtempSync(join(tmpdir(), 'part-consumers-'));
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
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
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary]));
  const tarball = join(temporary, packed[0].filename);
  for (const name of ['non-coding', 'swe', 'contracts', 'workflow']) {
    const directory = join(temporary, name);
    cpSync(join(root, 'consumers', name), directory, { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify(
        {
          name: `part-fixture-${name}`,
          private: true,
          type: 'module',
          dependencies: { part: `file:${tarball}` },
        },
        null,
        2,
      ),
    );
    run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], directory);
    if (name === 'contracts') {
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
          },
          include: ['index.ts'],
        }),
      );
      run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')], directory);
      process.stdout.write(run(process.execPath, ['out/index.js'], directory));
    } else process.stdout.write(run(process.execPath, ['index.mjs'], directory));
    const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
    if (lock.packages['node_modules/part'].version !== '0.1.0-alpha.2')
      throw Error('Unpinned consumer version');
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
