// @ts-check
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';

/** @typedef {{types?: string, default?: string}} ExportTarget */
/** @typedef {{source: string, name: string, target: ExportTarget}} Entrypoint */

/** Discover explicitly public sources without exposing implementation helpers.
 * @param {string} directory Package directory containing src/.
 * @returns {Entrypoint[]}
 */
export function publicEntrypoints(directory) {
  const sourceRoot = join(directory, 'src');
  /** @param {string} current @returns {string[]} */
  function files(current) {
    return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const path = join(current, entry.name);
      return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
    });
  }
  /** @type {Map<string, Entrypoint>} */
  const entries = new Map();
  for (const source of files(sourceRoot).sort()) {
    if (!/\.(ts|css)$/.test(source) || source.endsWith('.d.ts')) continue;
    const text = readFileSync(source, 'utf8');
    const comments = ts.getLeadingCommentRanges(text, 0) ?? [];
    if (
      !comments.some(({ pos, end }) =>
        /(?:^|\r?\n)\s*(?:\/\*+|\*|\/\/)?\s*@public\b/.test(text.slice(pos, end)),
      )
    )
      continue;
    const path = relative(sourceRoot, source).replaceAll('\\', '/');
    const css = path.endsWith('.css');
    const name = css
      ? `./${path}`
      : path === 'index.ts'
        ? '.'
        : './' + path.replace(/(?:\/index)?\.ts$/, '');
    if (entries.has(name))
      throw Error(`Duplicate public entrypoint ${name}: ${entries.get(name).source} and ${source}`);
    /** @type {ExportTarget} */
    const target = css
      ? { default: `./dist/${path}` }
      : { types: `./dist/${path.slice(0, -3)}.d.ts` };
    if (!css) {
      // Transpilation erases interfaces and explicit type re-exports. An empty
      // module has no runtime condition, while side-effect entrypoints retain one.
      const emitted = ts.transpileModule(text, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          verbatimModuleSyntax: true,
          removeComments: true,
        },
        fileName: source,
      }).outputText;
      const module = ts.createSourceFile(source + '.js', emitted, ts.ScriptTarget.Latest, true);
      const runtime = module.statements.some(
        (statement) =>
          !ts.isEmptyStatement(statement) &&
          !(
            ts.isExportDeclaration(statement) &&
            statement.exportClause &&
            ts.isNamedExports(statement.exportClause) &&
            statement.exportClause.elements.length === 0 &&
            !statement.moduleSpecifier
          ),
      );
      if (runtime) target.default = `./dist/${path.slice(0, -3)}.js`;
    }
    entries.set(name, { source, name, target });
  }
  return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** @param {Entrypoint[]} entries @returns {Record<string, ExportTarget>} */
export function exportMap(entries) {
  return Object.fromEntries(entries.map(({ name, target }) => [name, target]));
}

/** Update the generated field only when its contents change.
 * @param {string} directory
 * @param {Entrypoint[]} entries
 */
export function writeExports(directory, entries) {
  const path = join(directory, 'package.json');
  const text = readFileSync(path, 'utf8');
  const manifest = JSON.parse(text);
  const exports = exportMap(entries);
  if (JSON.stringify(manifest.exports) === JSON.stringify(exports)) return;
  manifest.exports = exports;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}

/** @param {string} directory @param {Entrypoint[]} entries */
export function copyPublicAssets(directory, entries) {
  for (const { source, target } of entries) {
    if (!source.endsWith('.css')) continue;
    const destination = join(directory, target.default);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
}
