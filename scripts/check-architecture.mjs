import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const failures = [];
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}
const packages = ['core', 'plugins', 'node', 'browser'].map((directory) => ({
  directory,
  path: `packages/${directory}`,
  manifest: JSON.parse(readFileSync(`packages/${directory}/package.json`, 'utf8')),
}));
const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
const sources = packages
  .flatMap((pkg) => files(`${pkg.path}/src`))
  .filter((file) => file.endsWith('.ts'));
const graph = new Map(sources.map((file) => [file, new Set()]));
const owner = (file) => packages.find((pkg) => file.startsWith(`${pkg.path}/src/`));
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
function resolveDependency(file, specifier, runtime) {
  const pkg = owner(file);
  if (specifier.startsWith('node:')) {
    if (pkg.directory !== 'node') failures.push(`${file}: Node imports belong in @part/node`);
    return specifier;
  }
  if (specifier.startsWith('.')) {
    const target = relative(root, resolve(dirname(file), specifier)).replace(/\.js$/, '.ts');
    if (!graph.has(target)) failures.push(`${file}: missing source ${target}`);
    else if (owner(target) !== pkg)
      failures.push(`${file}: cross-package imports must use public exports`);
    return target;
  }
  const match = /^(@[^/]+\/[^/]+)(?:\/(.*))?$/.exec(specifier);
  const dependency = match && byName.get(match[1]);
  if (!dependency) {
    failures.push(`${file}: dependency ${specifier} must be explicitly reviewed`);
    return undefined;
  }
  if (dependency === pkg) failures.push(`${file}: internal imports must be relative`);
  if (
    dependency !== pkg &&
    pkg.manifest.dependencies?.[dependency.manifest.name] !== dependency.manifest.version
  )
    failures.push(`${file}: undeclared or unpinned dependency ${dependency.manifest.name}`);
  const name = match[2] ? `./${match[2]}` : '.';
  const entry = dependency.manifest.exports[name];
  if (!entry || (runtime && !entry.default)) {
    failures.push(`${file}: missing public ${runtime ? 'runtime' : 'type'} export ${specifier}`);
    return undefined;
  }
  const output = entry.types ?? entry.default;
  return `${dependency.path}/${output.slice(2)}`
    .replace('/dist/', '/src/')
    .replace(/\.d\.ts$/, '.ts')
    .replace(/\.js$/, '.ts');
}
for (const file of sources) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = [];
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
      statement.isTypeOnly ||
      statement.importClause?.isTypeOnly ||
      (bindings &&
        (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((item) => item.isTypeOnly));
    imports.push({ specifier: statement.moduleSpecifier.text, runtime: !typeOnly });
  }
  for (const { specifier, runtime } of imports) {
    const target = resolveDependency(file, specifier, runtime);
    if (!target || !runtime) continue;
    graph.get(file).add(target);
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
const visiting = new Set(),
  visited = new Set();
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
    pkg.directory === 'core' ? {} : { '@part/core': byName.get('@part/core').manifest.version };
  if (JSON.stringify(pkg.manifest.dependencies ?? {}) !== JSON.stringify(expectedDependencies))
    failures.push(`${pkg.path}: dependencies must follow the core/plugin/environment boundary`);
  const targets = new Set();
  for (const [name, entry] of Object.entries(pkg.manifest.exports)) {
    entries++;
    if (name.includes('*')) failures.push(`${pkg.path}: wildcard exports expose internal helpers`);
    const output = entry.default ?? entry.types;
    const source = `${pkg.path}/${output.slice(2)}`
      .replace('/dist/', '/src/')
      .replace(/\.d\.ts$/, '.ts')
      .replace(/\.js$/, '.ts');
    if (!existsSync(source)) failures.push(`${pkg.path}/${name}: missing source ${source}`);
    if (targets.has(output)) failures.push(`${pkg.path}/${name}: duplicate public entrypoint`);
    targets.add(output);
    const path = source.slice(`${pkg.path}/src/`.length);
    const expected = path === 'index.ts' ? '.' : './' + path.replace(/(?:\/index)?\.ts$/, '');
    if (name !== expected)
      failures.push(`${pkg.path}/${name}: public path must follow source domain (${expected})`);
    if (entry.default?.endsWith('.js') && entry.types !== entry.default.replace(/\.js$/, '.d.ts'))
      failures.push(`${pkg.path}/${name}: code/declaration targets disagree`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Architecture checks passed (${packages.length} packages, ${sources.length} source modules, ${entries} public entrypoints)`,
  );
