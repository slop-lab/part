// @ts-check
import { readFileSync } from 'node:fs';

/** @typedef {{
 * name: string, version: string,
 * dependencies?: Record<string, string>, devDependencies?: Record<string, string>,
 * scripts?: Record<string, string>, workspaces?: string[], files?: string[],
 * exports?: Record<string, string | Record<string, string>>,
 * bin?: string | Record<string, string>
 * } & Record<string, unknown>} PackageMetadata
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Expected a metadata object');
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @returns {Record<string, string>} */
function strings(value) {
  return Object.fromEntries(
    Object.entries(record(value)).map(([key, entry]) => {
      if (typeof entry !== 'string') throw Error(`Expected a string at ${key}`);
      return [key, entry];
    }),
  );
}

/** @param {unknown} value @returns {string[]} */
function list(value) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string'))
    throw Error('Expected a string list');
  return value;
}

/** Read and validate the metadata fields consumed by build and verification tools.
 * Other npm fields are preserved without claiming their values have a known shape.
 * @param {string} path
 * @returns {PackageMetadata}
 */
export function readPackageMetadata(path) {
  const value = record(/** @type {unknown} */ (JSON.parse(readFileSync(path, 'utf8'))));
  if (typeof value.name !== 'string' || typeof value.version !== 'string')
    throw Error(`Expected package name and version: ${path}`);
  return {
    ...value,
    name: value.name,
    version: value.version,
    ...(value.dependencies === undefined ? {} : { dependencies: strings(value.dependencies) }),
    ...(value.devDependencies === undefined
      ? {}
      : { devDependencies: strings(value.devDependencies) }),
    ...(value.scripts === undefined ? {} : { scripts: strings(value.scripts) }),
    ...(value.files === undefined ? {} : { files: list(value.files) }),
    ...(value.workspaces === undefined ? {} : { workspaces: list(value.workspaces) }),
    ...(value.bin === undefined
      ? {}
      : { bin: typeof value.bin === 'string' ? value.bin : strings(value.bin) }),
    ...(value.exports === undefined
      ? {}
      : {
          exports: Object.fromEntries(
            Object.entries(record(value.exports)).map(([key, entry]) => [
              key,
              typeof entry === 'string' ? entry : strings(entry),
            ]),
          ),
        }),
  };
}
