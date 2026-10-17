// @ts-check
import { messageItem } from '@slop-lab/part/context/index.js';
import { fail, localContext, ok } from '@slop-lab/part/contracts/index.js';
import { createToolDispatcher } from '@slop-lab/part/tools.js';
import { expandAgent } from '@slop-lab/part-plugins/agent/index.js';
import { createBasicDriver } from '@slop-lab/part-plugins/agent/drivers/basic.js';
import { createCodingDriver } from '@slop-lab/part-plugins/swe/coding.js';
import {
  createSubagentTools,
  subagentToolId,
  subagentToolSchemas,
} from '@slop-lab/part-plugins/swe/subagents.js';
import { createExecutionRoot, modelResponseHandle } from './execution.mjs';

const childDriverId = 'car/child';
const defaultCodingInstructions =
  'Work as a coding agent. Use available tools when needed, verify changes, and report the concrete result.';

/**
 * @typedef {{
 *   maxChildren?: number,
 *   maxTurns?: number,
 *   allowedToolIds?: readonly string[],
 *   authority?: {purpose: string, allowedActions: readonly string[]}
 * }} CarSubagentOptions
 * @typedef {import('@slop-lab/part-plugins/agent/index.js').AgentOptions & {
 *   validate?: import('@slop-lab/part-plugins/swe/coding.js').CodingDriverOptions['validate'],
 *   inspectContext?: import('@slop-lab/part-plugins/swe/coding.js').CodingDriverOptions['inspectContext'],
 *   maxTurns?: number,
 *   codingInstructions?: string,
 *   subagents?: CarSubagentOptions
 * }} CarAgentOptions
 */

/**
 * Assemble one coding root, managed children, and workflow-facing execution services.
 * @param {CarAgentOptions} options
 */
export function createCarAgent(options) {
  const {
    validate,
    inspectContext,
    maxTurns = 32,
    codingInstructions = defaultCodingInstructions,
    subagents = {},
    tools: configuredTools = [],
    toolSchemas: configuredSchemas = {},
    ...agentOptions
  } = options;
  if (!codingInstructions.trim())
    return fail('car.instructions', 'Coding instructions must not be empty');
  const allowedIds = new Set(
    (subagents.allowedToolIds ?? []).filter((id) => id !== subagentToolId),
  );
  /** @type {(ReturnType<typeof createExecutionRoot> extends import('@slop-lab/part/reference/index.js').Contracts.Result<infer T> ? T : never) | undefined} */
  let root;
  /** @type {import('@slop-lab/part-plugins/swe/subagents.js').ChildRunPort<import('@slop-lab/part/reference/index.js').Model.Response>} */
  const childRuns = {
    async start(request, context) {
      if (request.driverId !== childDriverId)
        return fail('car.child-driver', 'Managed child driver does not match');
      if (!root) return fail('car.runtime', 'Execution services are unavailable', 'internal');
      const execution = await root.executionServices();
      if (!execution.ok) return execution;
      const started = await execution.value.runs.start(
        {
          driver: childDriverId,
          input: `Task:\n${request.input.task}\n\nDelegated context:\n${request.input.context}`,
          composition: execution.value.composition,
          parent: request.parent,
        },
        context,
      );
      return started.ok ? ok(modelResponseHandle(started.value)) : started;
    },
  };
  const subagentTools = createSubagentTools({
    childRuns,
    driverId: childDriverId,
    authority: subagents.authority ?? {
      purpose: 'bounded coding assistance',
      allowedActions: [...allowedIds],
    },
    ...(subagents.maxChildren === undefined ? {} : { maxChildren: subagents.maxChildren }),
  });
  const tools = [...configuredTools, ...subagentTools];
  /** @type {Record<string, import('@slop-lab/part/reference/index.js').Contracts.Json>} */
  const toolSchemas = { ...configuredSchemas, ...subagentToolSchemas };
  const inspected = createToolDispatcher({ tools, executors: options.executors });
  if (!inspected.ok) return inspected;
  const definitions = inspected.value.registry.list(localContext());
  /** @type {import('@slop-lab/part/reference/index.js').Model.ToolAdvertisement[]} */
  const advertisements = [];
  for (const definition of definitions) {
    const inputSchema = toolSchemas[definition.id];
    if (!inputSchema) return fail('car.tool-schema', `JSON Schema required for ${definition.id}`);
    advertisements.push({
      id: definition.id,
      version: definition.version,
      description: definition.description,
      inputSchema,
      execution: 'runtime',
    });
  }
  const childAdvertisements = advertisements.filter((tool) => allowedIds.has(tool.id));
  if (childAdvertisements.length !== allowedIds.size) {
    const available = new Set(childAdvertisements.map((tool) => tool.id));
    const missing = [...allowedIds].find((id) => !available.has(id));
    return fail('car.child-tool', `Child tool is unavailable or lacks a schema: ${missing}`);
  }
  const childBase = createBasicDriver({
    profileId: options.model.profile.id,
    tools: childAdvertisements,
    modelCapabilities: options.model.profile.capabilities,
    ...(subagents.maxTurns === undefined ? {} : { maxTurns: subagents.maxTurns }),
  });
  const childDriver = { ...childBase, id: childDriverId };
  const driver = createCodingDriver({
    profileId: options.model.profile.id,
    tools: advertisements,
    modelCapabilities: options.model.profile.capabilities,
    maxTurns,
    ...(validate ? { validate } : {}),
    ...(inspectContext ? { inspectContext } : {}),
  });
  const expanded = expandAgent({
    ...agentOptions,
    tools,
    toolSchemas,
    driver,
  });
  if (!expanded.ok) return expanded;
  const created = createExecutionRoot({
    specification: expanded.value.specification,
    drivers: [driver, childDriver],
    rootDriver: driver,
    operations: expanded.value.operations,
    waits: expanded.value.waits,
    limits: options.limits,
    principal: options.principal,
    customize: options.customize,
    async prepareInput(input) {
      const instructions = await messageItem('system', [
        { kind: 'text', text: codingInstructions },
      ]);
      return typeof input === 'string'
        ? [instructions, await messageItem('user', [{ kind: 'text', text: input }])]
        : [instructions, ...input];
    },
  });
  if (created.ok) root = created.value;
  return created;
}
