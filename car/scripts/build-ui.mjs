// @ts-check
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const carRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(carRoot, '..');

/** @param {{outputDirectory?: string}=} options */
export async function buildCarUi(options = {}) {
  const outputDirectory = resolve(options.outputDirectory ?? join(carRoot, 'dist/ui'));
  await mkdir(outputDirectory, { recursive: true });
  const bundle = await build({
    absWorkingDir: workspaceRoot,
    entryPoints: [join(carRoot, 'ui/app.mjs')],
    outfile: join(outputDirectory, 'app.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    metafile: true,
    legalComments: 'none',
  });
  const serverInput = Object.keys(bundle.metafile.inputs).find((path) =>
    /packages\/(?:node|plugins)\//.test(path.replaceAll('\\', '/')),
  );
  if (serverInput) throw new Error(`Server implementation entered CAR UI bundle: ${serverInput}`);
  const [html, sharedCss, carCss] = await Promise.all([
    readFile(join(carRoot, 'ui/index.html'), 'utf8'),
    readFile(fileURLToPath(import.meta.resolve('@slop-lab/part-browser/styles.css')), 'utf8'),
    readFile(join(carRoot, 'ui/styles.css'), 'utf8'),
  ]);
  const indexPath = join(outputDirectory, 'index.html');
  const scriptPath = join(outputDirectory, 'app.js');
  const stylePath = join(outputDirectory, 'app.css');
  await Promise.all([writeFile(indexPath, html), writeFile(stylePath, `${sharedCss}\n${carCss}`)]);
  return [indexPath, scriptPath, stylePath];
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  const outputs = await buildCarUi();
  console.log(`CAR UI built:\n${outputs.join('\n')}`);
}
