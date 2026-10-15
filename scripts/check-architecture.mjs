// @ts-check
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { packageEntrypoints } from './package-build.mjs';
import { readPackageMetadata } from './package-metadata.mjs';

const root = process.cwd();
const failures = [];
/** @param {string} directory @returns {string[]} */
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name))
      : [join(directory, entry.name).split('\\').join('/')],
  );
}
const packages = ['core', 'plugins', 'node', 'browser'].map((directory) => ({
  directory,
  path: `packages/${directory}`,
  manifest: readPackageMetadata(`packages/${directory}/package.json`),
}));
const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
const sources = packages
  .flatMap((pkg) => files(`${pkg.path}/src`))
  .filter((file) => file.endsWith('.ts'));
/** @type {Map<string, Set<string>>} */
const graph = new Map(sources.map((file) => [file, new Set()]));
/** @param {string} file */
function owner(file) {
  const pkg = packages.find((pkg) => file.startsWith(`${pkg.path}/src/`));
  if (!pkg) throw Error(`No package owns ${file}`);
  return pkg;
}
/** @param {string} file */
const localPath = (file) => file.slice(owner(file).path.length + 5);
const coreFiles = new Set([
  'index.ts',
  'contracts/index.ts',
  'foundation/hash.ts',
  'composition/planner.ts',
  'composition/handles.ts',
  'composition/scopes.ts',
  'runtime/budget.ts',
  'runtime/boundary.ts',
  'runtime/operations.ts',
  'runtime/progress.ts',
  'runtime/deadline.ts',
]);
/** @param {string} file @param {string} specifier @param {boolean} _runtime */
function resolveDependency(file, specifier, _runtime) {
  const pkg = owner(file);
  if (specifier.startsWith('node:')) {
    if (pkg.directory !== 'node')
      failures.push(`${file}: Node imports belong in @slop-lab/part-node`);
    return specifier;
  }
  if (specifier.startsWith('.')) {
    const target = relative(root, resolve(dirname(file), specifier))
      .split('\\')
      .join('/')
      .replace(/\.js$/, '.ts');
    if (!graph.has(target)) failures.push(`${file}: missing source ${target}`);
    else if (owner(target) !== pkg)
      failures.push(`${file}: cross-package imports must use package paths`);
    return target;
  }
  const match = /^(@[^/]+\/[^/]+)(?:\/(.*))?$/.exec(specifier);
  const dependency = match?.[1] && byName.get(match[1]);
  if (!match || !dependency) {
    failures.push(`${file}: dependency ${specifier} must be explicitly reviewed`);
    return undefined;
  }
  if (dependency === pkg) failures.push(`${file}: internal imports must be relative`);
  if (
    dependency !== pkg &&
    pkg.manifest.dependencies?.[dependency.manifest.name] !== dependency.manifest.version
  )
    failures.push(`${file}: undeclared or unpinned dependency ${dependency.manifest.name}`);
  const path = match[2] ?? 'index.js';
  const target = `${dependency.path}/src/${path}`.replace(/\.js$/, '.ts');
  if (!path.endsWith('.js') || !graph.has(target)) {
    failures.push(`${file}: missing package file or explicit .js path ${specifier}`);
    return undefined;
  }
  return target;
}
for (const file of sources) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = [];
  /** @param {import("typescript").Node} node */
  function visit(node) {
    if ((ts.isImportSpecifier(node) && node.propertyName) || ts.isNamespaceImport(node))
      failures.push(`${file}: import aliases are not allowed`);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier))
        imports.push({ specifier: specifier.text, runtime: true });
      else failures.push(`${file}: dynamic imports must use literal module paths`);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      imports.push({ specifier: node.argument.literal.text, runtime: false });
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const statement of source.statements) {
    if (
      (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : statement.exportClause;
    const typeOnly =
      (ts.isExportDeclaration(statement) && statement.isTypeOnly) ||
      (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) ||
      (bindings &&
        (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((item) => item.isTypeOnly));
    imports.push({ specifier: statement.moduleSpecifier.text, runtime: !typeOnly });
  }
  for (const { specifier, runtime } of imports) {
    const target = resolveDependency(file, specifier, runtime);
    if (!target || !runtime) continue;
    graph.get(file)?.add(target);
    if (target.startsWith('node:')) continue;
    if (owner(file).directory === 'core' && owner(target)?.directory === 'core') {
      const source = localPath(file),
        destination = localPath(target);
      if (
        /^(contracts|foundation)\//.test(source) &&
        !/^(contracts|foundation)\//.test(destination)
      )
        failures.push(`${file}: shared primitives cannot depend on ${target}`);
      if (
        source.startsWith('runtime/') &&
        /^(model|tools|scripts|host|storage|artifacts|results|client)(?:\/|\.ts$)/.test(destination)
      )
        failures.push(`${file}: runtime cannot depend on ${target}`);
    }
    if (
      owner(file).directory === 'plugins' &&
      localPath(file).startsWith('workflows/memory/') &&
      owner(target)?.directory === 'plugins' &&
      localPath(target).startsWith('agent/')
    )
      failures.push(`${file}: workflow execution cannot depend on agent drivers`);
    if (
      localPath(file).startsWith('scripts/') &&
      owner(target)?.directory === 'core' &&
      localPath(target).startsWith('model/')
    )
      failures.push(`${file}: script execution must use model ports, not the model implementation`);
  }
}
/** @type {Set<string>} */
const visiting = new Set();
/** @type {Set<string>} */
const visited = new Set();
/** @param {string} file @param {string[]} path */
function checkCycles(file, path = []) {
  if (visiting.has(file)) {
    failures.push(`Runtime import cycle: ${[...path, file].join(' -> ')}`);
    return;
  }
  if (visited.has(file) || file.startsWith('node:')) return;
  visiting.add(file);
  for (const target of graph.get(file) ?? []) checkCycles(target, [...path, file]);
  visiting.delete(file);
  visited.add(file);
}
for (const file of sources) checkCycles(file);
/** @param {string} file @param {Set<string>} seen */
function reachable(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const target of graph.get(file) ?? []) reachable(target, seen);
  return seen;
}
for (const file of sources.filter((file) => owner(file).directory !== 'node'))
  for (const target of reachable(file))
    if (target.startsWith('node:')) failures.push(`${file}: portable code reaches ${target}`);
for (const target of reachable('packages/core/src/index.ts'))
  if (!target.startsWith('packages/core/src/') || !coreFiles.has(localPath(target)))
    failures.push(`Core entrypoint imports optional implementation ${target}`);
let entries = 0;
for (const pkg of packages) {
  const expectedDependencies =
    pkg.directory === 'core'
      ? {}
      : { '@slop-lab/part': packages.find((pkg) => pkg.directory === 'core')?.manifest.version };
  if (JSON.stringify(pkg.manifest.dependencies ?? {}) !== JSON.stringify(expectedDependencies))
    failures.push(`${pkg.path}: dependencies must follow the core/plugin/environment boundary`);
  const hasRoot = existsSync(`${pkg.path}/src/index.ts`);
  const expectedWorkspace = {
    ...(hasRoot ? { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } : {}),
    './*': './dist/*',
  };
  if (JSON.stringify(pkg.manifest.exports) !== JSON.stringify(expectedWorkspace))
    failures.push(`${pkg.path}: workspace exports must use fixed dist routing`);
  const distribution = readPackageMetadata(`${pkg.path}/dist/package.json`);
  const expectedPublished = {
    ...(hasRoot ? { '.': { types: './index.d.ts', default: './index.js' } } : {}),
    './*': './*',
  };
  if (JSON.stringify(distribution.exports) !== JSON.stringify(expectedPublished))
    failures.push(`${pkg.path}: distribution exports must expose root-relative files`);
  if (distribution.scripts || distribution.devDependencies || distribution.files)
    failures.push(`${pkg.path}: distribution metadata includes workspace-only fields`);
  for (const { name, entry } of packageEntrypoints(`${pkg.path}/dist`)) {
    entries++;
    for (const output of Object.values(entry))
      if (!existsSync(`${pkg.path}/dist/${output.slice(2)}`))
        failures.push(`${pkg.path}/${name}: missing build output ${output}`);
  }
  for (const output of Object.values(distribution.bin ?? {}))
    if (typeof output !== 'string' || !existsSync(`${pkg.path}/dist/${output.slice(2)}`))
      failures.push(`${pkg.path}: missing distribution executable ${output}`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Architecture checks passed (${packages.length} packages, ${sources.length} source modules, ${entries} built entrypoints)`,
  );
