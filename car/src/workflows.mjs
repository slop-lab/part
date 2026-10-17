// @ts-check
import { createCodeEngine } from '@slop-lab/part-plugins/workflows/code.js';
import { createWorkflowHost } from '@slop-lab/part-plugins/workflows/host.js';
import { createPipelineEngine } from '@slop-lab/part-plugins/workflows/pipeline/index.js';
import { digest, fail, isJsonObject, ok } from '@slop-lab/part/contracts/index.js';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

/**
 * @typedef {{engineId: string, definition: import('@slop-lab/part/reference/index.js').Workflows.DefinitionRef}} Registration
 * @typedef {{
 * root: string,
 * schemas: Parameters<typeof createPipelineEngine>[0]['schemas'],
 * services: Parameters<typeof createPipelineEngine>[0]['services'],
 * context: import('@slop-lab/part/reference/index.js').Contracts.InvocationContext,
 * engines?: readonly import('@slop-lab/part/reference/index.js').Workflows.Engine[],
 * registrations?: readonly Registration[],
 * codeDefinitions?: Parameters<typeof createCodeEngine>[0],
 * handlers?: Parameters<typeof createPipelineEngine>[0]['handlers'],
 * agents?: Parameters<typeof createPipelineEngine>[0]['agents'],
 * }} CarWorkflowOptions
 * @typedef {Pick<import('@slop-lab/part/reference/index.js').Workflows.StartRequest,
 * 'requestId'|'idempotencyKey'|'limits'|'parent'>} CarWorkflowStartOptions
 */

/** Load data-only workflows, compile every registration, then expose start/inspection ports. @param {CarWorkflowOptions} options */
export async function createCarWorkflowRegistry(options) {
  const loaded = await loadPipelines(options.root);
  if (!loaded.ok) return loaded;
  const engines = [...(options.engines ?? [])];
  /** @type {Registration[]} */
  const registrations = [...(options.registrations ?? [])];
  if (loaded.value.definitions.length) {
    const pipeline = createPipelineEngine({
      definitions: loaded.value.definitions,
      schemas: options.schemas,
      services: options.services,
      ...(options.handlers ? { handlers: options.handlers } : {}),
      ...(options.agents ? { agents: options.agents } : {}),
    });
    if (!pipeline.ok) return pipeline;
    engines.push(pipeline.value);
    registrations.push(
      ...loaded.value.refs.map((definition) => ({
        engineId: pipeline.value.descriptor.id,
        definition,
      })),
    );
  }
  if (options.codeDefinitions?.length) {
    const code = createCodeEngine(options.codeDefinitions, options.services);
    if (!code.ok) return code;
    engines.push(code.value);
    registrations.push(
      ...options.codeDefinitions.map(({ definition, digest: pinned }) => ({
        engineId: code.value.descriptor.id,
        definition: {
          id: definition.id,
          format: 'part.code',
          formatVersion: '1',
          digest: pinned,
          source: { owner: 'car/workflow-registry', native: { registration: definition.id } },
        },
      })),
    );
  }
  const ids = new Set(registrations.map(({ definition }) => definition.id));
  if (ids.size !== registrations.length)
    return fail('car.workflow-duplicate', 'Duplicate workflow definition ID', 'conflict');
  const hosted = createWorkflowHost(engines);
  if (!hosted.ok) return hosted;
  /** @type {Map<string, import('@slop-lab/part/reference/index.js').Workflows.Prepared>} */
  const prepared = new Map();
  for (const registration of registrations) {
    const result = await hosted.value.prepare(
      {
        engineId: registration.engineId,
        definition: registration.definition,
        profileId: 'default',
        requiredCapabilities: [],
        requiredControl: 'runner-enforced',
      },
      options.context,
    );
    if (!result.ok) return result;
    prepared.set(registration.definition.id, result.value);
  }
  return ok({
    host: hosted.value,
    definitions: registrations.map(({ definition }) => definition),
    /** @param {string} id */
    prepare(id) {
      const found = prepared.get(id);
      return found
        ? ok(found)
        : fail('car.workflow-missing', `Workflow not registered: ${id}`, 'unsupported');
    },
    /** @param {string} id @param {import('@slop-lab/part/reference/index.js').Contracts.Json} input @param {Partial<CarWorkflowStartOptions>} [startOptions] */
    start(id, input, startOptions = {}) {
      const found = prepared.get(id);
      if (!found)
        return Promise.resolve({
          kind: /** @type {const} */ ('rejected'),
          error: fail('car.workflow-missing', `Workflow not registered: ${id}`, 'unsupported')
            .error,
        });
      return hosted.value.start(
        {
          requestId: startOptions.requestId ?? crypto.randomUUID(),
          prepared: found,
          input,
          ...(startOptions.idempotencyKey ? { idempotencyKey: startOptions.idempotencyKey } : {}),
          ...(startOptions.limits ? { limits: startOptions.limits } : {}),
          ...(startOptions.parent ? { parent: startOptions.parent } : {}),
        },
        options.context,
      );
    },
    /** @param {string} id */
    resolve(id) {
      return registrations.find(({ definition }) => definition.id === id)?.definition;
    },
  });
}

/** @param {string} root */
async function loadPipelines(root) {
  let directory;
  try {
    const resolvedRoot = await realpath(root);
    directory = await realpath(join(resolvedRoot, '.agents', 'workflows'));
    const fromRoot = relative(resolvedRoot, directory);
    if (
      fromRoot === '..' ||
      fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(fromRoot)
    )
      return fail('car.workflow-path', 'Workflow directory escapes the CAR root', 'permission');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return ok({ definitions: [], refs: [] });
    throw error;
  }
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.pipeline.json'))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > 128) return fail('car.workflow-limit', 'Too many workflow definitions');
  /** @type {import('@slop-lab/part/reference/index.js').PipelineV1.Definition[]} */
  const definitions = [];
  /** @type {import('@slop-lab/part/reference/index.js').Workflows.DefinitionRef[]} */
  const refs = [];
  for (const entry of entries) {
    const bytes = await readFile(join(directory, entry.name));
    if (bytes.byteLength > 1_000_000)
      return fail('car.workflow-limit', `Workflow definition too large: ${entry.name}`);
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error instanceof SyntaxError)
        return fail('car.workflow-json', `Invalid workflow JSON: ${entry.name}`);
      throw error;
    }
    if (!isJsonObject(parsed))
      return fail('car.workflow-definition', `Missing required pipeline fields: ${entry.name}`);
    const pinned = await digest(parsed);
    if (!isPipelineDefinition(parsed))
      return fail('car.workflow-definition', `Missing required pipeline fields: ${entry.name}`);
    definitions.push(parsed);
    refs.push({
      id: parsed.id,
      format: parsed.format,
      formatVersion: String(parsed.version),
      digest: pinned,
      source: { owner: 'car/workflow-loader', native: { path: `.agents/workflows/${entry.name}` } },
    });
  }
  return ok({ definitions, refs });
}

/** @param {unknown} value @returns {value is import('@slop-lab/part/reference/index.js').PipelineV1.Definition} */
function isPipelineDefinition(value) {
  return (
    isJsonObject(value) &&
    value.format === 'part.pipeline' &&
    value.version === 1 &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    isSchemaRef(value.input) &&
    isSchemaRef(value.output) &&
    Array.isArray(value.steps) &&
    value.steps.length > 0 &&
    isJsonObject(value.result)
  );
}

/** @param {unknown} value */
function isSchemaRef(value) {
  return isJsonObject(value) && typeof value.id === 'string' && Number.isSafeInteger(value.version);
}
