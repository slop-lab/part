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
const sources = files('src').filter((file) => file.endsWith('.ts'));
const graph = new Map(sources.map((file) => [file, new Set()]));
const portableRoots = [
  'src/index.ts',
  'src/client/index.ts',
  ...sources.filter((file) => file.startsWith('src/ui/')),
];
const coreFiles = new Set([
  'src/index.ts',
  'src/contracts/index.ts',
  'src/foundation/hash.ts',
  'src/foundation/deadline.ts',
  'src/composition/index.ts',
  'src/composition/handles.ts',
  'src/composition/planner.ts',
  'src/composition/scopes.ts',
  'src/runtime/index.ts',
  'src/runtime/budget.ts',
  'src/runtime/boundary.ts',
  'src/runtime/effects.ts',
  'src/runtime/operations.ts',
  'src/runtime/progress.ts',
]);
const nodeAdapters =
  /^(src\/(scripts\/node\/|scripts\/bridge\/node\.ts$|extensions\/packages\/node\.ts$|artifacts\/node\.ts$|storage\/sqlite\.ts$|host\/http\.ts$))/;
const coreLayers = /^(src\/(contracts|foundation)\/)/;
const lowerRuntime = /^src\/runtime\//;
const higherLayers =
  /^src\/(agent|model|scripts|workflows|host|storage|artifacts|results|ui|client)\//;

for (const file of sources) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = [];
  const visit = (node) => {
    if ((ts.isImportSpecifier(node) && node.propertyName) || ts.isNamespaceImport(node))
      failures.push(`${file}: import aliases are not allowed`);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier)) imports.push(specifier.text);
      else failures.push(`${file}: dynamic imports must use literal module paths`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
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
    if (typeOnly) continue;
    imports.push(specifier);
  }
  for (const specifier of imports) {
    if (specifier.startsWith('node:')) {
      graph.get(file).add(specifier);
      if (!nodeAdapters.test(file))
        failures.push(`${file}: Node imports belong in explicit Node adapters`);
      continue;
    }
    if (!specifier.startsWith('.')) {
      failures.push(`${file}: runtime dependency ${specifier} must be explicitly reviewed`);
      continue;
    }
    const target = relative(root, resolve(dirname(file), specifier)).replace(/\.js$/, '.ts');
    if (!graph.has(target)) {
      failures.push(`${file}: missing source dependency ${target}`);
      continue;
    }
    graph.get(file).add(target);
    if (coreLayers.test(file) && !coreLayers.test(target))
      failures.push(`${file}: shared primitives cannot depend on ${target}`);
    if (lowerRuntime.test(file) && higherLayers.test(target))
      failures.push(`${file}: runtime cannot depend on ${target}`);
    if (file.startsWith('src/scripts/') && /^src\/(model|agent|workflows)\//.test(target))
      failures.push(`${file}: scripts cannot depend on ${target}`);
    if (file.startsWith('src/workflows/memory/') && target.startsWith('src/agent/'))
      failures.push(`${file}: workflow execution cannot depend on agent drivers`);
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
  for (const target of graph.get(file)) checkCycles(target, [...path, file]);
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
for (const entry of portableRoots)
  for (const target of reachable(entry))
    if (target.startsWith('node:'))
      failures.push(`${entry}: portable entrypoint reaches ${target}`);
for (const target of reachable('src/index.ts'))
  if (!coreFiles.has(target))
    failures.push(`Core entrypoint imports optional implementation ${target}`);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const targets = new Set();
for (const [name, entry] of Object.entries(pkg.exports)) {
  if (name.includes('*')) failures.push(`Wildcard export ${name} exposes internal helpers`);
  const output = entry.default ?? entry.types;
  const source = output
    .replace(/^\.\/dist\//, 'src/')
    .replace(/\.d\.ts$/, '.ts')
    .replace(/\.js$/, '.ts');
  if (!existsSync(source)) failures.push(`${name}: missing source ${source}`);
  if (targets.has(output)) failures.push(`${name}: duplicate public entrypoint for ${output}`);
  targets.add(output);
  const expected =
    source === 'src/index.ts' ? '.' : './' + source.slice(4).replace(/(?:\/index)?\.ts$/, '');
  if (name !== expected)
    failures.push(`${name}: public path must follow its source domain (${expected})`);
  if (entry.default?.endsWith('.js') && entry.types !== entry.default.replace(/\.js$/, '.d.ts'))
    failures.push(`${name}: JavaScript and declaration targets disagree`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Architecture checks passed (${sources.length} source modules, ${targets.size} public entrypoints)`,
  );
}
