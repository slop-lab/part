import { isJsonObject, schema } from '@slop-lab/part/contracts/index.js';
import type { Contracts, Tools } from '@slop-lab/part/reference/index.js';
import { WorkspaceFiles } from './files.js';
import { installWorkspaceTool } from './workspace-tool.js';

export type WorkspaceToolOptions = {
  readonly root: string;
  readonly editMode?: 'hash' | 'exact';
  readonly maxFileBytes?: number;
  readonly maxOutputChars?: number;
  readonly maxEntries?: number;
};
export type WorkspaceToolSet = {
  readonly tools: readonly Tools.InstalledTool[];
  readonly toolSchemas: Readonly<Record<string, Contracts.Json>>;
};

type JsonObject = Record<string, unknown>;
type JsonMap = { readonly [key: string]: Contracts.Json };

const pathProperties = { path: { type: 'string', minLength: 1 } } as const;
const schemas = {
  swe_read: objectSchema(pathProperties, ['path']),
  swe_list: objectSchema({ ...pathProperties, recursive: { type: 'boolean' } }, ['path']),
  swe_search: objectSchema({ ...pathProperties, query: { type: 'string', minLength: 1 } }, [
    'path',
    'query',
  ]),
  swe_write: {
    ...objectSchema(
      {
        ...pathProperties,
        content: { type: 'string' },
        expectedDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        absent: { const: true },
      },
      ['path', 'content'],
    ),
    oneOf: [{ required: ['expectedDigest'] }, { required: ['absent'] }],
  },
  swe_edit_hash: objectSchema(
    {
      ...pathProperties,
      expectedDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      edits: {
        type: 'array',
        minItems: 1,
        items: objectSchema(
          {
            line: { type: 'integer', minimum: 1 },
            hash: { type: 'string', pattern: '^[a-f0-9]{8}$' },
            newText: { type: 'string' },
          },
          ['line', 'hash', 'newText'],
        ),
      },
    },
    ['path', 'expectedDigest', 'edits'],
  ),
  swe_edit_exact: objectSchema(
    {
      ...pathProperties,
      expectedDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      oldText: { type: 'string', minLength: 1 },
      newText: { type: 'string' },
    },
    ['path', 'expectedDigest', 'oldText', 'newText'],
  ),
} as const;

export function createWorkspaceTools(options: WorkspaceToolOptions): WorkspaceToolSet {
  const limits = {
    maxFileBytes: positive(options.maxFileBytes, 1_000_000),
    maxOutputChars: positive(options.maxOutputChars, 100_000),
    maxEntries: positive(options.maxEntries, 1_000),
  };
  const files = new WorkspaceFiles(options.root, limits);
  const editMode = options.editMode ?? 'hash';
  const definitions = [
    {
      id: 'swe_read',
      description: 'Read a bounded UTF-8 workspace file with digest and line hashes.',
      effects: 'read' as const,
      validate: hasPath,
      execute: (input: JsonObject) => files.read(requiredString(input, 'path')),
    },
    {
      id: 'swe_list',
      description: 'List bounded workspace directory entries without following symlinks.',
      effects: 'read' as const,
      validate: (value: unknown): value is JsonObject =>
        hasPath(value) && optionalBoolean(value, 'recursive'),
      execute: (input: JsonObject) =>
        files.list(requiredString(input, 'path'), input['recursive'] !== false),
    },
    {
      id: 'swe_search',
      description: 'Search bounded UTF-8 workspace files for a literal string.',
      effects: 'read' as const,
      validate: (value: unknown): value is JsonObject =>
        hasPath(value) && nonemptyString(value['query']),
      execute: (input: JsonObject) =>
        files.search(requiredString(input, 'path'), requiredString(input, 'query')),
    },
    {
      id: 'swe_write',
      description: 'Atomically replace or create a workspace file with an explicit precondition.',
      effects: 'write' as const,
      validate: isWriteInput,
      execute: (input: JsonObject) =>
        files.write({
          path: requiredString(input, 'path'),
          content: requiredString(input, 'content'),
          ...(typeof input['expectedDigest'] === 'string'
            ? { expectedDigest: input['expectedDigest'] }
            : { absent: true }),
        }),
    },
    {
      id: 'swe_edit',
      description:
        editMode === 'hash'
          ? 'Atomically edit addressed lines using a full-file digest, line number and line hash.'
          : 'Atomically replace one unique exact string using a full-file digest.',
      effects: 'write' as const,
      validate: editMode === 'hash' ? isHashEditInput : isExactEditInput,
      execute: (input: JsonObject) =>
        editMode === 'hash'
          ? files.editHash({
              path: requiredString(input, 'path'),
              expectedDigest: requiredString(input, 'expectedDigest'),
              edits: requiredEdits(input),
            })
          : files.editExact({
              path: requiredString(input, 'path'),
              expectedDigest: requiredString(input, 'expectedDigest'),
              oldText: requiredString(input, 'oldText'),
              newText: requiredString(input, 'newText'),
            }),
    },
  ];
  const tools = definitions.map((definition) =>
    installWorkspaceTool({
      id: definition.id,
      description: definition.description,
      effects: definition.effects,
      input: schema<JsonObject>(`part/swe/${definition.id}`, definition.validate),
      execute: definition.execute,
    }),
  );
  return {
    tools,
    toolSchemas: {
      swe_read: schemas.swe_read,
      swe_list: schemas.swe_list,
      swe_search: schemas.swe_search,
      swe_write: schemas.swe_write,
      swe_edit: editMode === 'hash' ? schemas.swe_edit_hash : schemas.swe_edit_exact,
    },
  };
}

function objectSchema(properties: JsonMap, required: readonly string[]): JsonMap {
  return { type: 'object', properties, required, additionalProperties: false };
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError('Workspace limits must be positive');
  return value;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasPath(value: unknown): value is JsonObject {
  return isJsonObject(value) && nonemptyString(value['path']);
}

function optionalBoolean(value: JsonObject, key: string): boolean {
  return value[key] === undefined || typeof value[key] === 'boolean';
}

function requiredString(value: JsonObject, key: string): string {
  const found = value[key];
  if (typeof found !== 'string') throw new TypeError(`Expected ${key}`);
  return found;
}

function isWriteInput(value: unknown): value is JsonObject {
  if (!hasPath(value) || typeof value['content'] !== 'string') return false;
  const digest = typeof value['expectedDigest'] === 'string';
  const absent = value['absent'] === true;
  return digest !== absent;
}

function isHashEditInput(value: unknown): value is JsonObject {
  return (
    hasPath(value) &&
    nonemptyString(value['expectedDigest']) &&
    Array.isArray(value['edits']) &&
    value['edits'].length > 0 &&
    value['edits'].every(
      (edit) =>
        isJsonObject(edit) &&
        Number.isSafeInteger(edit['line']) &&
        Number(edit['line']) > 0 &&
        nonemptyString(edit['hash']) &&
        typeof edit['newText'] === 'string',
    )
  );
}

function requiredEdits(value: JsonObject): readonly {
  readonly line: number;
  readonly hash: string;
  readonly newText: string;
}[] {
  const edits = value['edits'];
  if (!Array.isArray(edits)) throw new TypeError('Expected edits');
  return edits.map((edit) => ({
    line: Number(requiredProperty(edit, 'line')),
    hash: String(requiredProperty(edit, 'hash')),
    newText: String(requiredProperty(edit, 'newText')),
  }));
}

function requiredProperty(value: unknown, key: string): unknown {
  if (!isJsonObject(value) || !(key in value)) throw new TypeError(`Expected ${key}`);
  return value[key];
}

function isExactEditInput(value: unknown): value is JsonObject {
  return (
    hasPath(value) &&
    nonemptyString(value['expectedDigest']) &&
    nonemptyString(value['oldText']) &&
    typeof value['newText'] === 'string'
  );
}
