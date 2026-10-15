import { build } from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
execFileSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '-p', 'examples/playground/tsconfig.json'],
  { stdio: 'inherit' },
);
const bundle = await build({
  entryPoints: ['examples/playground/main.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  write: false,
  metafile: true,
});
if (Object.keys(bundle.metafile.inputs).some((path) => /packages\/(node|plugins)\//.test(path)))
  throw Error('Server implementations must not enter the browser bundle');
mkdirSync('preview', { recursive: true });
copyFileSync('examples/playground/index.html', 'preview/index.html');
writeFileSync('preview/app.js', bundle.outputFiles[0].text);
writeFileSync(
  'preview/styles.css',
  readFileSync('packages/browser/dist/styles.css', 'utf8') +
    '\n' +
    readFileSync('examples/playground/styles.css', 'utf8'),
);
console.log('Playground built: preview/ (start with npm run preview)');
